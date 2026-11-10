param()

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$version = (Get-Content -Raw -LiteralPath "$root\legacy\package.json" | ConvertFrom-Json).version
if ($version -notmatch '^\d+\.\d+\.\d+$') { throw 'Invalid release version.' }
$source = Join-Path $root 'github-ready\Legacy-AI'
$out = Join-Path $root 'release'

if (Test-Path -LiteralPath $source) {
    $resolved = (Resolve-Path -LiteralPath $source).Path
    if ($resolved -ne (Join-Path (Resolve-Path -LiteralPath $root).Path 'github-ready\Legacy-AI')) {
        throw 'Invalid source export directory.'
    }
    Remove-Item -LiteralPath $resolved -Recurse -Force
}
New-Item -ItemType Directory -Path "$source\legacy", $out -Force | Out-Null

foreach ($name in @('.github', '.gitattributes', '.gitignore', 'README.md', 'LICENSE', 'ASSET_LICENSE.md',
        'CHANGELOG.md', 'RELEASE_NOTES.md', 'PRIVACY.md', 'SECURITY.md', 'THIRD_PARTY_NOTICES.md')) {
    Copy-Item -LiteralPath (Join-Path $root $name) -Destination $source -Recurse
}
New-Item -ItemType Directory -Path "$source\installer" | Out-Null
foreach ($name in @('Build.ps1', 'LegacyAI.iss', 'Package-Source.ps1', 'Verify-Install.ps1', 'smoke.py', 'WizardLogo.bmp', 'WizardSmallLogo.bmp')) {
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot $name) -Destination "$source\installer"
}
foreach ($name in @('src', 'public', 'presets', 'skills', 'streamdeck', 'desktop',
        'package.json', 'package-lock.json', 'config.json', '.env.example', '.gitignore')) {
    Copy-Item -LiteralPath (Join-Path $root "legacy\$name") -Destination "$source\legacy" -Recurse
}
Copy-Item -Path "$root\legacy\SETUP-*.md" -Exclude 'SETUP-start.md' -Destination "$source\legacy"

$files = Get-ChildItem -LiteralPath $source -Recurse -File -Force
foreach ($file in $files) {
    $relative = $file.FullName.Substring($source.Length + 1)
    if ($file.Name -like '.env*' -and $file.Name -ne '.env.example') { throw "Credential file found at $relative" }
    if ($relative -match '(^|[\\/])(node_modules|data|\.git|\.build|__pycache__)([\\/]|$)') {
        throw "Generated or private files found at $relative"
    }
    if ($file.Length -ge 100MB) { throw "File exceeds the GitHub source limit at $relative" }
}

$archive = Join-Path $out "Legacy-AI-$version-Source.zip"
if (Test-Path -LiteralPath $archive) { Remove-Item -LiteralPath $archive }
Add-Type -AssemblyName System.IO.Compression.FileSystem
[IO.Compression.ZipFile]::CreateFromDirectory($source, $archive, [IO.Compression.CompressionLevel]::Optimal, $true)
$sha = (Get-FileHash -LiteralPath $archive).Hash.ToLowerInvariant()
"$sha  $(Split-Path -Leaf $archive)" | Set-Content -LiteralPath "$archive.sha256" -Encoding ascii
Write-Host "Source folder: $source"
Write-Host "Source ZIP: $archive"
