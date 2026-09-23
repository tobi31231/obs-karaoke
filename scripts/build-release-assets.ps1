[CmdletBinding()]
param(
    [string]$Version = "v0.1.0-alpha",
    [string]$PortablePath,
    [string]$InstallerPath,
    [string]$LauncherPath,
    [switch]$ReuseRuntimeAssets
)

$ErrorActionPreference = "Stop"
$repo = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$workspace = (Resolve-Path (Join-Path $repo "..")).Path
if (-not $PortablePath) {
    $PortablePath = Join-Path $workspace "build\portable"
}
if (-not $InstallerPath) {
    $InstallerPath = Join-Path $workspace "build\installer\OBS-Karaoke-Setup.exe"
}

$PortablePath = (Resolve-Path $PortablePath).Path
$InstallerPath = (Resolve-Path $InstallerPath).Path
if ($LauncherPath) { $LauncherPath = (Resolve-Path $LauncherPath).Path }
$releaseRoot = Join-Path $workspace "release"
$releaseDirectory = Join-Path $releaseRoot $Version
$stagingRoot = Join-Path $workspace "build\asset-staging"

function Assert-WorkspacePath([string]$Path) {
    $full = [System.IO.Path]::GetFullPath($Path)
    if (-not $full.StartsWith($workspace + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Path escaped release workspace: $full"
    }
}

function Reset-Directory([string]$Path) {
    Assert-WorkspacePath $Path
    if (Test-Path -LiteralPath $Path) {
        Remove-Item -LiteralPath $Path -Recurse -Force
    }
    New-Item -ItemType Directory -Path $Path -Force | Out-Null
}

function Remove-GeneratedCaches([string]$Root) {
    $cacheDirectories = Get-ChildItem -LiteralPath $Root -Directory -Recurse -Force |
        Where-Object { $_.Name -in @("__pycache__", ".cache") } |
        Sort-Object { $_.FullName.Length } -Descending

    foreach ($directory in $cacheDirectories) {
        if (Test-Path -LiteralPath $directory.FullName) {
            Remove-Item -LiteralPath $directory.FullName -Recurse -Force
        }
    }
}

function Copy-Tree([string]$Source, [string]$Destination, [string[]]$Excluded = @()) {
    New-Item -ItemType Directory -Path $Destination -Force | Out-Null
    $arguments = @($Source, $Destination, "/E", "/COPY:DAT", "/DCOPY:DAT", "/R:1", "/W:1",
        "/NFL", "/NDL", "/NJH", "/NJS", "/NP")
    if ($Excluded.Count -gt 0) {
        $arguments += "/XD"
        $arguments += $Excluded
    }
    & robocopy @arguments
    if ($LASTEXITCODE -ge 8) {
        throw "Robocopy failed with code $LASTEXITCODE"
    }
}

if ($ReuseRuntimeAssets) {
    $previousManifest = Get-Content -LiteralPath (Join-Path $releaseDirectory "release-manifest.json") -Raw | ConvertFrom-Json
    foreach ($assetName in @("obs-karaoke-turbo-model.zip", "obs-karaoke-cuda-runtime-win-x64.zip")) {
        $assetPath = Join-Path $releaseDirectory $assetName
        $record = $previousManifest.assets | Where-Object name -eq $assetName
        if (-not $record -or (Get-FileHash -LiteralPath $assetPath -Algorithm SHA256).Hash -ne $record.sha256) {
            throw "Existing runtime archive failed verification: $assetName"
        }
    }
} else {
    Reset-Directory $releaseDirectory
}
Reset-Directory $stagingRoot

$coreStaging = Join-Path $stagingRoot "app-core"
$modelStaging = Join-Path $stagingRoot "model"
$cudaStaging = Join-Path $stagingRoot "cuda"

Copy-Tree $PortablePath $coreStaging @(
    (Join-Path $PortablePath "models"),
    (Join-Path $PortablePath "runtime"),
    (Join-Path $PortablePath "work\uploads")
)
if ($LauncherPath) {
    Copy-Item -LiteralPath $LauncherPath -Destination (Join-Path $coreStaging "OBS Karaoke MVP.exe") -Force
}
if (-not $ReuseRuntimeAssets) {
    Copy-Tree (Join-Path $PortablePath "models") (Join-Path $modelStaging "models")
    Copy-Tree (Join-Path $PortablePath "runtime") (Join-Path $cudaStaging "runtime")
}

Remove-GeneratedCaches $coreStaging
if (-not $ReuseRuntimeAssets) {
    Remove-GeneratedCaches $modelStaging
    Remove-GeneratedCaches $cudaStaging
}

$assetDefinitions = @(
    @{ Name = "obs-karaoke-app-core-win-x64.zip"; Source = $coreStaging },
    @{ Name = "obs-karaoke-turbo-model.zip"; Source = $modelStaging },
    @{ Name = "obs-karaoke-cuda-runtime-win-x64.zip"; Source = $cudaStaging }
)

foreach ($definition in $assetDefinitions) {
    if ($ReuseRuntimeAssets -and $definition.Source -ne $coreStaging) { continue }
    $destination = Join-Path $releaseDirectory $definition.Name
    $temporaryArchive = Join-Path $stagingRoot $definition.Name
    Write-Host "Compressing $($definition.Name)..."
    Compress-Archive -Path (Join-Path $definition.Source "*") -DestinationPath $temporaryArchive -CompressionLevel Optimal
    if ((Get-Item -LiteralPath $temporaryArchive).Length -ge 2GB) {
        throw "GitHub asset is 2 GiB or larger: $($definition.Name)"
    }
    Move-Item -LiteralPath $temporaryArchive -Destination $destination -Force
}

$setupDestination = Join-Path $releaseDirectory "OBS-Karaoke-Setup.exe"
Copy-Item -LiteralPath $InstallerPath -Destination $setupDestination -Force

$manifestAssets = foreach ($definition in $assetDefinitions) {
    $path = Join-Path $releaseDirectory $definition.Name
    [ordered]@{
        name = $definition.Name
        sha256 = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash
        size = (Get-Item -LiteralPath $path).Length
    }
}

$manifest = [ordered]@{
    version = $Version.TrimStart("v")
    installerSha256 = (Get-FileHash -LiteralPath $setupDestination -Algorithm SHA256).Hash
    assets = @($manifestAssets)
}
$manifestPath = Join-Path $releaseDirectory "release-manifest.json"
$manifest | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $manifestPath -Encoding utf8

$checksumFiles = @($setupDestination, $manifestPath)
$checksumFiles += $assetDefinitions | ForEach-Object {
    Join-Path $releaseDirectory $_.Name
}
$checksumLines = foreach ($path in $checksumFiles) {
    "{0}  {1}" -f (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash, (Split-Path $path -Leaf)
}
$checksumLines | Set-Content -LiteralPath (Join-Path $releaseDirectory "SHA256SUMS.txt") -Encoding ascii

Copy-Item -LiteralPath (Join-Path $repo "docs\RELEASE-NOTES.md") -Destination (Join-Path $releaseDirectory "RELEASE-NOTES.txt") -Force

Write-Host ""
Write-Host "Release assets ready: $releaseDirectory"
Get-ChildItem -LiteralPath $releaseDirectory -File |
    Select-Object Name, Length, LastWriteTime |
    Format-Table -AutoSize
