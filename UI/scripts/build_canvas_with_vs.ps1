param(
    [string]$CanvasProjectPath = "..\resources\canvas\canvas_preview",
    [switch]$Release
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot = Resolve-Path (Join-Path $ScriptDir $CanvasProjectPath)
$ResourceDir = Resolve-Path (Join-Path $ScriptDir "..\resources\canvas")

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  Canvas Preview Build Script" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan

$flutter = Get-Command flutter -ErrorAction SilentlyContinue
if (-not $flutter) {
    $env:PATH = "C:\tools\flutter\bin;$env:PATH"
}

# Find latest MSVC
$msvcBase = "C:\Program Files\Microsoft Visual Studio\18\Community\VC\Tools\MSVC"
$msvcVers = Get-ChildItem $msvcBase -Directory | Sort-Object Name -Descending
$msvcVer = $msvcVers[0].Name
Write-Host "Using MSVC: $msvcVer" -ForegroundColor Yellow

# Find latest Windows Kits
$kitBase = "C:\Program Files (x86)\Windows Kits\10"
$kitVers = Get-ChildItem "$kitBase\bin" -Directory | Where-Object { $_.Name -match '^\d+\.' } | Sort-Object Name -Descending
$kitVer = $kitVers[0].Name
Write-Host "Using Windows Kit: $kitVer" -ForegroundColor Yellow

$vcPath = "$msvcBase\$msvcVer"
$kitPath = "$kitBase"

# Set up VS environment variables properly for CMake detection
$env:VSINSTALLDIR = "C:\Program Files\Microsoft Visual Studio\18\Community"
$env:VisualStudioDir = "C:\Program Files\Microsoft Visual Studio\18\Community"
$env:VisualStudioVersion = "18.0"

# Add MSVC to PATH
$env:PATH = "$vcPath\bin\Hostx64\x64;$env:PATH"
$env:PATH = "$kitPath\bin\$kitVer\x64;$env:PATH"

# Set INCLUDE
$env:INCLUDE = "$vcPath\include;$kitPath\Include\$kitVer\ucrt;$kitPath\Include\$kitVer\shared;$kitPath\Include\$kitVer\um;$kitPath\Include\$kitVer\winrt"

# Set LIB
$env:LIB = "$vcPath\lib\x64;$kitPath\Lib\$kitVer\ucrt\x64;$kitPath\Lib\$kitVer\um\x64"

# Set CMAKE generator instance
$env:CMAKE_GENERATOR_INSTANCE = "C:\Program Files\Microsoft Visual Studio\18\Community"

# Ensure CMake uses the correct VS generator
$env:CMAKE_GENERATOR = "Visual Studio 17 2022"
$env:CMAKE_GENERATOR_PLATFORM = "x64"

Write-Host "`n[1/4] flutter pub get..." -ForegroundColor Magenta
Push-Location $ProjectRoot
try {
    flutter pub get 2>&1 | ForEach-Object { Write-Host "  $_" }
    if ($LASTEXITCODE -ne 0) { throw "flutter pub get failed" }

    Write-Host "`n[2/4] flutter clean..." -ForegroundColor Magenta
    flutter clean 2>&1 | Out-Null

    $buildType = if ($Release) { "--release" } else { "--debug" }
    Write-Host "`n[3/4] flutter build windows $buildType ..." -ForegroundColor Magenta
    flutter build windows $buildType 2>&1 | ForEach-Object { Write-Host "  $_" }
    if ($LASTEXITCODE -ne 0) { throw "Build failed" }

    Write-Host "`n[4/4] Extracting release artifacts..." -ForegroundColor Magenta

    $buildBase = Join-Path $ProjectRoot "build\windows"
    $buildMode = if ($Release) { "Release" } else { "Debug" }

    # Find the correct output dir
    $searchPaths = @(
        "$buildBase\x64\$buildMode",
        "$buildBase\runner\$buildMode",
        "$buildBase\$(Get-ChildItem $buildBase -Directory | Select-Object -First 1)\$buildMode"
    )

    $buildOutput = $null
    foreach ($p in $searchPaths) {
        if (Test-Path $p) { $buildOutput = $p; break }
    }

    if (-not $buildOutput) {
        Write-Warning "Could not find build output directory. Build may have succeeded but output not found."
        Pop-Location
        return
    }

    Write-Host "  Output: $buildOutput" -ForegroundColor Green

    $releaseDir = Join-Path $ResourceDir "release"
    if (Test-Path $releaseDir) { Remove-Item $releaseDir -Recurse -Force -ErrorAction SilentlyContinue }
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

    Write-Host "`n========================================" -ForegroundColor Cyan
    Write-Host "  Build Completed Successfully!" -ForegroundColor Cyan
    Write-Host "========================================" -ForegroundColor Cyan
} catch {
    Write-Error "Build failed: $_"
    Pop-Location
    exit 1
} finally {
    Pop-Location
}
