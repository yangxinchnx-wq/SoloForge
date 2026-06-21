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

Write-Host "`n[1/4] Getting Flutter packages..." -ForegroundColor Magenta
Push-Location $ProjectRoot
try {
    & $flutter pub get 2>&1 | ForEach-Object { Write-Host "  $_" }
    if ($LASTEXITCODE -ne 0) { throw "flutter pub get failed" }
    
    Write-Host "`n[2/4] Cleaning previous build..." -ForegroundColor Magenta
    & $flutter clean 2>&1 | Out-Null
    
    if ($Release) {
        Write-Host "`n[3/4] Building RELEASE version..." -ForegroundColor Magenta
        & $flutter build windows --release 2>&1 | ForEach-Object { Write-Host "  $_" }
        if ($LASTEXITCODE -ne 0) { throw "Release build failed" }
        
        $buildOutput = Join-Path $ProjectRoot "build\windows\$(if (Test-Path (Join-Path $ProjectRoot 'build\windows\x64')) {'x64'} else {'runner'})\Release"
        if (-not (Test-Path $buildOutput)) {
            $buildOutput = Join-Path $ProjectRoot "build\windows\runner\Release"
        }
        
        Write-Host "`n[4/4] Extracting minimal release artifacts..." -ForegroundColor Magenta
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
            Write-Host "  Copied: $($_.Name)" -ForegroundColor Green
        }
        
        $releaseSize = (Get-ChildItem $releaseDir -Recurse -File | Measure-Object -Property Length -Sum).Sum
        Write-Host "`nRelease artifacts size: $([math]::Round($releaseSize / 1MB, 2)) MB" -ForegroundColor Yellow
        
        if ($releaseSize -gt 30MB) {
            Write-Warning "Target is ~20 MB. Current release: $([math]::Round($releaseSize / 1MB, 2)) MB"
        } else {
            Write-Host "Target achieved! (~20 MB)" -ForegroundColor Green
        }
        
        Write-Host "`nRelease path: $releaseDir" -ForegroundColor Cyan
    } else {
        Write-Host "`n[3/4] Building DEBUG version..." -ForegroundColor Magenta
        & $flutter build windows --debug 2>&1 | ForEach-Object { Write-Host "  $_" }
        if ($LASTEXITCODE -ne 0) { throw "Debug build failed" }
        
        Write-Host "`n[4/4] Build complete (debug)" -ForegroundColor Green
    }
    
    Write-Host "`n========================================" -ForegroundColor Cyan
    Write-Host "  Build Completed Successfully!" -ForegroundColor Cyan
    Write-Host "========================================" -ForegroundColor Cyan
} catch {
    Write-Error "Build failed: $_"
    exit 1
} finally {
    Pop-Location
}
