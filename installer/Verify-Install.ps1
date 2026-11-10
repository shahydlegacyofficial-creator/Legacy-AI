param()

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$version = (Get-Content -Raw -LiteralPath "$root\legacy\package.json" | ConvertFrom-Json).version
$setup = Join-Path $root "release\Legacy-AI-$version-Windows-x64-Setup.exe"
$target = Join-Path $root ".build\verify-$([Guid]::NewGuid().ToString('N'))"
$registry = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\{5BCA7661-5144-46C9-8FD1-54D17258EA9B}_is1'
if (Test-Path -LiteralPath $registry) { throw 'Run installer verification in a Windows profile without an existing Legacy AI installation.' }
try {
    $process = Start-Process -FilePath $setup -ArgumentList @(
        '/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', "/DIR=`"$target`"", '/MERGETASKS="!desktopicon"'
    ) -Wait -PassThru -WindowStyle Hidden
    if ($process.ExitCode -ne 0) { throw "Installer exited $($process.ExitCode)." }
    python "$PSScriptRoot\smoke.py" $target
    if ($LASTEXITCODE -ne 0) { throw 'Installed app smoke check failed.' }
    $installed = (Get-Content -Raw -LiteralPath "$target\package.json" | ConvertFrom-Json).version
    $registered = (Get-ItemProperty -LiteralPath $registry).DisplayVersion
    if ($installed -ne $version -or $registered -ne $version) { throw 'Installed version does not match package.json.' }
} finally {
    if (Test-Path -LiteralPath "$target\unins000.exe") {
        $process = Start-Process -FilePath "$target\unins000.exe" -ArgumentList @(
            '/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART'
        ) -Wait -PassThru -WindowStyle Hidden
        if ($process.ExitCode -ne 0) { throw "Uninstall exited $($process.ExitCode)." }
    }
}
if (Test-Path -LiteralPath $registry) { throw 'Uninstall registration remains.' }
if (Test-Path -LiteralPath "$target\runtime\node.exe") { throw 'Uninstall left the application runtime.' }
Write-Host "Verified Legacy AI $version install, application startup and uninstall."
