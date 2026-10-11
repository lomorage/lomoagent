param(
    [string]$Repo = 'lomorage/lomoagent',
    [string]$Tag,
    [string]$InstallerPath,
    [string]$ScriptPath = 'install.ps1'
)

$ErrorActionPreference = 'Stop'

if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
    throw 'GitHub CLI (gh) is required.'
}

if (-not $Tag) {
    $config = Get-Content 'src-tauri\tauri.conf.json' | ConvertFrom-Json
    $Tag = "v$($config.version)"
}

if (-not $InstallerPath) {
    $config = Get-Content 'src-tauri\tauri.conf.json' | ConvertFrom-Json
    $InstallerPath = "src-tauri\target\release\bundle\nsis\lomorage_$($config.version)_x64-setup.exe"
}

$resolvedInstaller = (Resolve-Path $InstallerPath).Path
$resolvedScript = (Resolve-Path $ScriptPath).Path

Write-Host "Uploading release assets to $Repo $Tag..."
gh release upload $Tag `
    "$resolvedInstaller#$(Split-Path $resolvedInstaller -Leaf)" `
    "$resolvedScript#install.ps1" `
    --repo $Repo `
    --clobber

Write-Host "Release assets uploaded."
