param(
    [string]$Repo = 'lomorage/lomoagent',
    [string]$Tag = 'latest',
    [switch]$DownloadOnly,
    [switch]$NoLaunch
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
} catch {
}

function Write-Step {
    param([string]$Message)
    Write-Host "[LomoAgent] $Message"
}

function Get-Release {
    param(
        [string]$Repo,
        [string]$Tag
    )

    $headers = @{
        'User-Agent' = 'LomoAgent-Installer'
        'Accept' = 'application/vnd.github+json'
    }

    $uri = if ($Tag -eq 'latest') {
        "https://api.github.com/repos/$Repo/releases/latest"
    } else {
        "https://api.github.com/repos/$Repo/releases/tags/$Tag"
    }

    Invoke-RestMethod -Uri $uri -Headers $headers
}

function Find-InstallerAsset {
    param($Release)

    $patterns = @(
        'lomorage_*_x64-setup.exe',
        '*setup.exe',
        '*.msi'
    )

    foreach ($pattern in $patterns) {
        $asset = @($Release.assets) | Where-Object { $_.name -like $pattern } | Select-Object -First 1
        if ($asset) {
            return $asset
        }
    }

    throw "No installer asset was found in release $($Release.tag_name)."
}

function Install-Asset {
    param(
        [string]$InstallerPath,
        [string]$AssetName
    )

    if ($AssetName -like '*.msi') {
        Write-Step "Running MSI installer..."
        Start-Process -FilePath 'msiexec.exe' -ArgumentList @('/i', $InstallerPath, '/qn', '/norestart') -Wait
        return
    }

    Write-Step "Running setup installer..."
    Start-Process -FilePath $InstallerPath -ArgumentList '/S' -Wait
}

function Find-InstalledExe {
    $candidates = @(
        (Join-Path $env:LOCALAPPDATA 'LomoPhotoViewer\lomo-photo-viewer.exe'),
        (Join-Path $env:LOCALAPPDATA 'Programs\LomoPhotoViewer\lomo-photo-viewer.exe'),
        (Join-Path $env:ProgramFiles 'LomoPhotoViewer\lomo-photo-viewer.exe')
    )

    if (${env:ProgramFiles(x86)}) {
        $candidates += Join-Path ${env:ProgramFiles(x86)} 'LomoPhotoViewer\lomo-photo-viewer.exe'
    }

    foreach ($candidate in $candidates) {
        if ($candidate -and (Test-Path -LiteralPath $candidate)) {
            return $candidate
        }
    }

    $roots = @($env:LOCALAPPDATA, $env:ProgramFiles, ${env:ProgramFiles(x86)}) | Where-Object { $_ }
    foreach ($root in $roots) {
        $match = Get-ChildItem -Path $root -Filter 'lomo-photo-viewer.exe' -File -Recurse -ErrorAction SilentlyContinue |
            Select-Object -First 1 -ExpandProperty FullName
        if ($match) {
            return $match
        }
    }

    return $null
}

Write-Step "Checking GitHub release metadata..."
$release = Get-Release -Repo $Repo -Tag $Tag
$asset = Find-InstallerAsset -Release $release

$downloadDir = Join-Path $env:TEMP 'LomoAgent'
New-Item -ItemType Directory -Path $downloadDir -Force | Out-Null
$installerPath = Join-Path $downloadDir $asset.name

Write-Step "Downloading $($asset.name) from $($release.tag_name)..."
$downloadHeaders = @{
    'User-Agent' = 'LomoAgent-Installer'
    'Accept' = 'application/octet-stream'
}
Invoke-WebRequest -Uri $asset.url -Headers $downloadHeaders -OutFile $installerPath

if ($DownloadOnly) {
    Write-Step "Download completed: $installerPath"
    return
}

Install-Asset -InstallerPath $installerPath -AssetName $asset.name

if (-not $NoLaunch) {
    $installedExe = Find-InstalledExe
    if ($installedExe) {
        Write-Step "Launching LomoAgent..."
        Start-Process -FilePath $installedExe | Out-Null
    } else {
        Write-Warning 'Install completed, but the app executable was not found automatically.'
    }
}

Write-Step "Install completed."
