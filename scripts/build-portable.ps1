[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$NodeExe,
    [Parameter(Mandatory = $true)][string]$PythonDirectory,
    [Parameter(Mandatory = $true)][string]$TurboModelDirectory,
    [Parameter(Mandatory = $true)][string]$CudaDirectory,
    [Parameter(Mandatory = $true)][string]$LicenseDirectory,
    [string]$OutputDirectory
)

$ErrorActionPreference = "Stop"

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

$repo = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$workspace = (Resolve-Path (Join-Path $repo "..")).Path
if (-not $OutputDirectory) {
    $OutputDirectory = Join-Path $workspace "build\portable"
}

$NodeExe = (Resolve-Path $NodeExe).Path
$PythonDirectory = (Resolve-Path $PythonDirectory).Path
$TurboModelDirectory = (Resolve-Path $TurboModelDirectory).Path
$CudaDirectory = (Resolve-Path $CudaDirectory).Path
$LicenseDirectory = (Resolve-Path $LicenseDirectory).Path
$OutputDirectory = [System.IO.Path]::GetFullPath($OutputDirectory)
if (-not $OutputDirectory.StartsWith($workspace, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Output directory escaped release workspace."
}

if (Test-Path -LiteralPath $OutputDirectory) {
    Remove-Item -LiteralPath $OutputDirectory -Recurse -Force
}
New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null

$launcherOutput = Join-Path $workspace "build\launcher-self-contained"
$env:DOTNET_CLI_HOME = Join-Path $workspace "build\dotnet-home"
$env:NUGET_PACKAGES = Join-Path $workspace "build\nuget-packages"
$env:DOTNET_SKIP_FIRST_TIME_EXPERIENCE = "1"
$env:DOTNET_CLI_TELEMETRY_OPTOUT = "1"

dotnet publish (Join-Path $repo "launcher\ObsKaraokeLauncher.csproj") `
    -c Release -r win-x64 --self-contained true `
    -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true `
    -o $launcherOutput
if ($LASTEXITCODE -ne 0) { throw "Launcher build failed." }

Copy-Item -Path (Join-Path $launcherOutput "*") -Destination $OutputDirectory -Recurse -Force
Get-ChildItem -LiteralPath $OutputDirectory -Filter "*.pdb" -Recurse -Force |
    Remove-Item -Force
Copy-Item -LiteralPath (Join-Path $repo "server.js"),(Join-Path $repo "package.json"),
    (Join-Path $repo "requirements-whisper.txt"),(Join-Path $repo "README.md"),
    (Join-Path $repo "THIRD_PARTY_NOTICES.md") -Destination $OutputDirectory
Copy-Item -LiteralPath (Join-Path $repo "public") -Destination $OutputDirectory -Recurse
New-Item -ItemType Directory -Path (Join-Path $OutputDirectory "work") -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $repo "work\model_align.py"),
    (Join-Path $repo "work\download_model.py"),
    (Join-Path $repo "work\download_cuda_runtime.py") -Destination (Join-Path $OutputDirectory "work")
Copy-Item -LiteralPath $NodeExe -Destination (Join-Path $OutputDirectory "node.exe")
Copy-Item -LiteralPath $LicenseDirectory -Destination $OutputDirectory -Recurse
if (Test-Path -LiteralPath (Join-Path $repo "licenses")) {
    New-Item -ItemType Directory -Path (Join-Path $OutputDirectory "licenses") -Force | Out-Null
    Copy-Item -Path (Join-Path $repo "licenses\*") `
        -Destination (Join-Path $OutputDirectory "licenses") -Recurse -Force
}

& robocopy $PythonDirectory (Join-Path $OutputDirectory "python") /E /COPY:DAT /DCOPY:DAT /R:1 /W:1 /NFL /NDL /NJH /NJS /NP
if ($LASTEXITCODE -ge 8) { throw "Python copy failed with code $LASTEXITCODE" }
& robocopy $TurboModelDirectory (Join-Path $OutputDirectory "models\faster-whisper-turbo") /E /COPY:DAT /DCOPY:DAT /R:1 /W:1 /NFL /NDL /NJH /NJS /NP
if ($LASTEXITCODE -ge 8) { throw "Model copy failed with code $LASTEXITCODE" }
& robocopy $CudaDirectory (Join-Path $OutputDirectory "runtime\cuda") /E /COPY:DAT /DCOPY:DAT /R:1 /W:1 /NFL /NDL /NJH /NJS /NP
if ($LASTEXITCODE -ge 8) { throw "CUDA copy failed with code $LASTEXITCODE" }

$python = Join-Path $OutputDirectory "python\python.exe"
& $python (Join-Path $OutputDirectory "work\model_align.py") --check
if ($LASTEXITCODE -ne 0) { throw "Packaged model environment check failed." }

Remove-GeneratedCaches $OutputDirectory

Write-Host "Portable package ready: $OutputDirectory"
