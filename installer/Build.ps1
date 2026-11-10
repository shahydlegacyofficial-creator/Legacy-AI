param(
    [string]$Compiler,
    [switch]$ReuseDependencies
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$app = Join-Path $root 'legacy'
$version = (Get-Content -Raw -LiteralPath (Join-Path $app 'package.json') | ConvertFrom-Json).version
if ($version -notmatch '^\d+\.\d+\.\d+$') { throw 'package.json needs a stable semantic version.' }
$build = Join-Path $root '.build'
$nodeVersion = '24.22.2'
$nodeName = "node-v$nodeVersion-win-x64"
$runtime = Join-Path $build $nodeName
$payload = Join-Path $build 'payload'
New-Item -ItemType Directory -Path $build -Force | Out-Null

if (!$Compiler) {
    $Compiler = @("$build\inno\ISCC.exe", "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe", "$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe") |
        Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
}
if (!$Compiler) { throw 'Install Inno Setup 6 and pass the path to ISCC.exe using -Compiler.' }

if (!(Test-Path -LiteralPath "$runtime\node.exe")) {
    $url = "https://nodejs.org/dist/v$nodeVersion"
    $archive = Join-Path $build "$nodeName.zip"
    Invoke-WebRequest "$url/$nodeName.zip" -OutFile $archive
    $sums = (Invoke-RestMethod "$url/SHASUMS256.txt") -split "`n"
    $expected = (($sums | Where-Object { $_ -match "  $nodeName\.zip\s*$" }) -split '\s+')[0]
    if ((Get-FileHash -LiteralPath $archive).Hash -ne $expected) { throw 'Node.js archive checksum mismatch.' }
    Expand-Archive -LiteralPath $archive -DestinationPath $build -Force
}

Push-Location $app
$previousPath = $env:PATH
try {
    $env:PATH = "$runtime;$env:PATH"
    if (!$ReuseDependencies) {
        & "$runtime\npm.cmd" ci --omit=dev --no-audit --no-fund
        if ($LASTEXITCODE) { throw 'npm ci failed.' }
    }
    & "$runtime\node.exe" --input-type=module -e 'import { speak } from "./src/mouth.js"; const wav = await speak("Legacy AI is ready."); if (wav.subarray(0, 4).toString() !== "RIFF") throw new Error("Kokoro could not produce a WAV file");'
    if ($LASTEXITCODE) { throw 'Kokoro installation check failed.' }
    & "$runtime\node.exe" src/setup-objects.js
    if ($LASTEXITCODE) { throw 'Object recognition model download failed.' }
} finally {
    $env:PATH = $previousPath
    Pop-Location
}

if (Test-Path -LiteralPath $payload) {
    $resolved = (Resolve-Path -LiteralPath $payload).Path
    if ($resolved -ne (Join-Path (Resolve-Path -LiteralPath $build).Path 'payload')) { throw 'Invalid payload directory.' }
    Remove-Item -LiteralPath $resolved -Recurse -Force
}
New-Item -ItemType Directory -Path "$payload\runtime" -Force | Out-Null
New-Item -ItemType Directory -Path "$payload\Licenses" | Out-Null
foreach ($name in @('LICENSE', 'ASSET_LICENSE.md', 'THIRD_PARTY_NOTICES.md', 'PRIVACY.md')) {
    Copy-Item -LiteralPath (Join-Path $root $name) -Destination "$payload\Licenses"
}
foreach ($name in @('src', 'public', 'presets', 'skills', 'streamdeck', 'desktop', 'package.json', 'package-lock.json', 'config.json', '.env.example')) {
    Copy-Item -LiteralPath (Join-Path $app $name) -Destination $payload -Recurse
}
Copy-Item -LiteralPath "$app\desktop\Start Legacy.cmd" -Destination $payload
Copy-Item -LiteralPath "$app\desktop\Setup Guide.txt" -Destination $payload
New-Item -ItemType Directory -Path "$payload\Setup Notes" | Out-Null
Copy-Item -Path "$app\SETUP-*.md" -Exclude 'SETUP-start.md' -Destination "$payload\Setup Notes"
Copy-Item -LiteralPath "$runtime\node.exe", "$runtime\LICENSE" -Destination "$payload\runtime"
Copy-Item -LiteralPath "$runtime\npm.cmd", "$runtime\npx.cmd" -Destination "$payload\runtime"
New-Item -ItemType Directory -Path "$payload\runtime\node_modules" | Out-Null
Copy-Item -LiteralPath "$runtime\node_modules\npm" -Destination "$payload\runtime\node_modules" -Recurse

& robocopy.exe "$app\node_modules" "$payload\node_modules" /E /XJ /NFL /NDL /NJH /NJS /NP /XF 'agent-browser-darwin-*' 'agent-browser-linux-*' '.env' '.env.*'
if ($LASTEXITCODE -ge 8) { throw 'Dependency staging failed.' }

Copy-Item -LiteralPath "$app\node_modules\qrcodejs\qrcode.min.js" -Destination "$payload\public\vendor\qrcode.min.js"
Copy-Item -Path "$app\node_modules\qrcodejs\LICENSE*" -Destination "$payload\public\vendor"

$redist = Join-Path $build 'vc_redist.x64.exe'
if (!(Test-Path -LiteralPath $redist)) {
    Invoke-WebRequest 'https://aka.ms/vc14/vc_redist.x64.exe' -OutFile $redist
}
$signature = Get-AuthenticodeSignature -LiteralPath $redist
if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'CN=Microsoft Corporation') {
    throw 'The Visual C++ runtime must have a valid Microsoft signature.'
}

$out = Join-Path $root 'release'
New-Item -ItemType Directory -Path $out -Force | Out-Null
& $Compiler '/Qp' "/DAppVersion=$version" "/DPayload=$payload" "/DVCRedist=$redist" (Join-Path $PSScriptRoot 'LegacyAI.iss')
if ($LASTEXITCODE) { throw 'Inno Setup compilation failed.' }
$setup = Get-Item -LiteralPath (Join-Path $out "Legacy-AI-$version-Windows-x64-Setup.exe")
$sha = (Get-FileHash -LiteralPath $setup.FullName).Hash.ToLowerInvariant()
"$sha  $($setup.Name)" | Set-Content -LiteralPath "$($setup.FullName).sha256" -Encoding ascii
Write-Host $setup.FullName
