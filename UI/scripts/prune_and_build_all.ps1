param(
    [string]$FlutterSdkPath = "C:\tools\flutter",
    [switch]$RunFlutterBuild,
    [switch]$RunSdkPrune,
    [switch]$CopyToResources
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot = Resolve-Path (Join-Path $ScriptDir "..")
$ResourceDir = Join-Path $ProjectRoot "resources"

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  SoloForge Canvas - Full Build Pipeline" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan

# Step 1: Prune Dart SDK
if ($RunSdkPrune) {
    Write-Host "`n>>> Step 1: Pruning Dart SDK..." -ForegroundColor Magenta
    $dartSdkPath = Join-Path $FlutterSdkPath "bin\cache\dart-sdk"
    if (-not (Test-Path $dartSdkPath)) {
        # Try alternative path inside flutter
        $dartSdkPath = Join-Path $FlutterSdkPath "bin\dart"
    }
    
    & (Join-Path $ProjectRoot "resources\prune_dart_sdk.ps1") -DartSdkPath $dartSdkPath
}

# Step 2: Build Flutter Canvas
if ($RunFlutterBuild) {
    Write-Host "`n>>> Step 2: Building Flutter Canvas Release..." -ForegroundColor Magenta
    & (Join-Path $ScriptDir "build_canvas.ps1") -Release -CopyToResources
}

# Step 3: Copy artifacts to resources
if ($CopyToResources) {
    Write-Host "`n>>> Step 3: Copying artifacts to resources..." -ForegroundColor Magenta
    
    $releaseDir = Join-Path $ResourceDir "canvas\canvas_preview\build\windows\x64\Release"
    if (-not (Test-Path $releaseDir)) {
        $releaseDir = Join-Path $ResourceDir "canvas\canvas_preview\build\windows\runner\Release"
    }
    
    $targetDir = Join-Path $ResourceDir "canvas_artifact"
    New-Item -ItemType Directory -Force -Path $targetDir | Out-Null
    
    if (Test-Path $releaseDir) {
        Copy-Item "$releaseDir\*" $targetDir -Recurse -Force -Include *.exe,*.dll,*.pak,*.dat,*.bin,*.icudtl
        Write-Host "  Artifacts copied to: $targetDir" -ForegroundColor Green
    }
    
    # Copy pruned SDK
    $sdkTarget = Join-Path $ResourceDir "sdk\pruned_dart_sdk"
    New-Item -ItemType Directory -Force -Path $sdkTarget | Out-Null
    Write-Host "  SDK staging directory: $sdkTarget" -ForegroundColor Green
}

Write-Host "`n========================================" -ForegroundColor Cyan
Write-Host "  Pipeline Complete!" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
