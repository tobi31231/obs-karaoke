[CmdletBinding()]
param(
    [string]$Version = "v0.1.0-alpha",
    [string]$PortablePath,
    [string]$InstallerPath
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
$releaseRoot = Join-Path $workspace "release"
$releaseDirectory = Join-Path $releaseRoot $Version
$stagingRoot = Join-Path $workspace "build\asset-staging"

function Assert-WorkspacePath([string]$Path) {
    $full = [System.IO.Path]::GetFullPath($Path)
    if (-not $full.StartsWith($workspace, [System.StringComparison]::OrdinalIgnoreCase)) {
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

Reset-Directory $releaseDirectory
Reset-Directory $stagingRoot

$coreStaging = Join-Path $stagingRoot "app-core"
$modelStaging = Join-Path $stagingRoot "model"
$cudaStaging = Join-Path $stagingRoot "cuda"

Copy-Tree $PortablePath $coreStaging @(
    (Join-Path $PortablePath "models"),
    (Join-Path $PortablePath "runtime")
)
Copy-Tree (Join-Path $PortablePath "models") (Join-Path $modelStaging "models")
Copy-Tree (Join-Path $PortablePath "runtime") (Join-Path $cudaStaging "runtime")

$assetDefinitions = @(
    @{ Name = "obs-karaoke-app-core-win-x64.zip"; Source = $coreStaging },
    @{ Name = "obs-karaoke-turbo-model.zip"; Source = $modelStaging },
    @{ Name = "obs-karaoke-cuda-runtime-win-x64.zip"; Source = $cudaStaging }
)

foreach ($definition in $assetDefinitions) {
    $destination = Join-Path $releaseDirectory $definition.Name
    Write-Host "Compressing $($definition.Name)..."
    Compress-Archive -Path (Join-Path $definition.Source "*") -DestinationPath $destination -CompressionLevel Optimal
    if ((Get-Item -LiteralPath $destination).Length -ge 2GB) {
        throw "GitHub asset is 2 GiB or larger: $($definition.Name)"
    }
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

@"
OBS Karaoke MVP $Version

사용자 배포:
1. OBS-Karaoke-Setup.exe만 안내합니다.
2. GitHub에서는 나머지 ZIP과 release-manifest.json을 같은 Release에 올립니다.
3. 설치기는 로컬 파일이 옆에 있으면 로컬 파일을 사용하고, 없으면 GitHub에서 받습니다.

주의:
- GitHub 저장소 주소를 installer/Program.cs에 설정한 뒤 Setup을 다시 빌드해야 합니다.
- 각 ZIP은 GitHub Release의 파일당 2 GiB 제한 미만이어야 합니다.
"@ | Set-Content -LiteralPath (Join-Path $releaseDirectory "RELEASE-NOTES.txt") -Encoding utf8

Write-Host ""
Write-Host "Release assets ready: $releaseDirectory"
Get-ChildItem -LiteralPath $releaseDirectory -File |
    Select-Object Name, Length, LastWriteTime |
    Format-Table -AutoSize
