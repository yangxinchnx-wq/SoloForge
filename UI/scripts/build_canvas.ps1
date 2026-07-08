param(
    [string]$CanvasProjectPath = "..\resources\canvas\canvas_preview",
    [switch]$Release,
    [switch]$CopyToResources
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot = Resolve-Path (Join-Path $ScriptDir $CanvasProjectPath)
$ResourceDir = Resolve-Path (Join-Path $ScriptDir "..\resources\canvas")

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  Canvas Preview Build Script" -ForegroundColor Cyan
Write-Host "  Project: $ProjectRoot" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan

# Verify Flutter is available
$flutter = Get-Command flutter -ErrorAction SilentlyContinue
if (-not $flutter) {
    $flutterPath = "C:\tools\flutter\bin\flutter.bat"
    if (-not (Test-Path $flutterPath)) {
        Write-Error "Flutter not found. Please install Flutter SDK."
        exit 1
    }
    $flutter = $flutterPath
}

Write-Host "`n[1/5] Getting Flutter packages..." -ForegroundColor Magenta
Push-Location $ProjectRoot
try {
    & $flutter pub get 2>&1 | ForEach-Object { Write-Host "  $_" }
    if ($LASTEXITCODE -ne 0) { throw "flutter pub get failed" }
    
    Write-Host "`n[2/5] Cleaning previous build..." -ForegroundColor Magenta
    & $flutter clean 2>&1 | Out-Null
    
    $buildMode = if ($Release) { "Release" } else { "Debug" }
    $buildFlag = if ($Release) { "--release" } else { "--debug" }
    
    Write-Host "`n[3/5] Building $buildMode version..." -ForegroundColor Magenta
    & $flutter build windows $buildFlag 2>&1 | ForEach-Object { Write-Host "  $_" }
    if ($LASTEXITCODE -ne 0) { throw "$buildMode build failed" }
    
    # Find the correct output dir — Flutter 3.22+ uses build\windows\x64\runner\<Mode>
    $buildBase = Join-Path $ProjectRoot "build\windows"
    $searchPaths = @(
        "$buildBase\x64\runner\$buildMode",
        "$buildBase\x64\$buildMode",
        "$buildBase\runner\$buildMode"
    )
    $buildOutput = $null
    foreach ($p in $searchPaths) {
        if (Test-Path $p) { $buildOutput = $p; break }
    }
    if (-not $buildOutput) {
        # Fallback: 递归查找 canvas_preview.exe
        $found = Get-ChildItem $buildBase -Recurse -Filter "canvas_preview.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($found) {
            $buildOutput = $found.DirectoryName
        }
    }
    if (-not $buildOutput) {
        throw "Build output directory not found in: $buildBase"
    }
    Write-Host "  Build output: $buildOutput" -ForegroundColor Green

    Write-Host "`n[4/5] Copying artifacts to canvas-dist/ (dev runtime path)..." -ForegroundColor Magenta
    $canvasDistDir = Join-Path $ResourceDir "canvas-dist"
    if (Test-Path $canvasDistDir) {
        Remove-Item $canvasDistDir -Recurse -Force -ErrorAction SilentlyContinue
    }
    New-Item -ItemType Directory -Force -Path $canvasDistDir | Out-Null
    
    # Copy all files (exe, dll, etc.)
    Get-ChildItem $buildOutput -File | ForEach-Object {
        Copy-Item $_.FullName (Join-Path $canvasDistDir $_.Name) -Force
        Write-Host "  Copied: $($_.Name)" -ForegroundColor Green
    }
    # Copy data/ directory (Flutter assets, icudtl, app.so)
    $dataDir = Join-Path $buildOutput "data"
    if (Test-Path $dataDir) {
        Copy-Item $dataDir $canvasDistDir -Recurse -Force
        Write-Host "  Copied: data/" -ForegroundColor Green
    }
    
    $distSize = (Get-ChildItem $canvasDistDir -Recurse -File | Measure-Object -Property Length -Sum).Sum
    Write-Host "  canvas-dist size: $([math]::Round($distSize / 1MB, 2)) MB" -ForegroundColor Yellow

    Write-Host "`n[5/5] Also extracting minimal release artifacts..." -ForegroundColor Magenta
    $releaseDir = Join-Path $ResourceDir "release"
    if (Test-Path $releaseDir) {
        Remove-Item $releaseDir -Recurse -Force -ErrorAction SilentlyContinue
    }
    New-Item -ItemType Directory -Force -Path $releaseDir | Out-Null
    
    $keepExtensions = @(".exe", ".dll", ".pak", ".dat", ".bin", ".icudtl")
    Get-ChildItem $buildOutput -File | Where-Object {
        $keepExtensions -contains $_.Extension.ToLower()
    } | ForEach-Object {
        Copy-Item $_.FullName (Join-Path $releaseDir $_.Name) -Force
    }
    
    Write-Host "`n========================================" -ForegroundColor Cyan
    Write-Host "  Build Completed Successfully!" -ForegroundColor Cyan
    Write-Host "  canvas-dist: $canvasDistDir" -ForegroundColor Cyan
    Write-Host "========================================" -ForegroundColor Cyan
} catch {
    Write-Error "Build failed: $_"
    exit 1
} finally {
    Pop-Location
}
