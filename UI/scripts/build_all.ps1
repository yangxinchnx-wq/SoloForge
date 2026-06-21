param(
    [switch]$SkipCanvas,
    [switch]$SkipPrune
)

$ErrorActionPreference = "Stop"
$RootDir = Split-Path $PSScriptRoot -Parent
$CanvasProject = Join-Path $RootDir "resources\canvas\canvas_preview"
$CanvasDist = Join-Path $RootDir "resources\canvas\canvas-dist"
$FlutterBin = "C:\tools\flutter\bin"
$VsPath = "C:\Program Files\Microsoft Visual Studio\18\Community"

Write-Host "==================================" -ForegroundColor Cyan
Write-Host "  SoloForge 全量构建脚本" -ForegroundColor Cyan
Write-Host "==================================" -ForegroundColor Cyan

# === 1. 环境准备 ===
$env:PATH = "$FlutterBin;$env:PATH"
$env:PATH = "$VsPath\Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin;$env:PATH"
$env:CMAKE_GENERATOR = "Visual Studio 18 2026"

# === 2. 构建 Flutter Canvas ===
if (-not $SkipCanvas) {
    Write-Host "`n[1/3] 构建 Flutter Canvas..." -ForegroundColor Magenta
    Push-Location $CanvasProject
    try {
        flutter clean 2>&1 | Out-Null
        flutter build windows --release 2>&1
        if ($LASTEXITCODE -ne 0) { throw "Flutter build failed" }
        
        if (Test-Path $CanvasDist) { [System.IO.Directory]::Delete($CanvasDist, $true) }
        New-Item -ItemType Directory -Force -Path $CanvasDist | Out-Null
        Copy-Item "build\windows\x64\runner\Release\*" -Destination $CanvasDist -Recurse
        Remove-Item "$CanvasDist\*.pdb" -ErrorAction SilentlyContinue
        
        $size = (Get-ChildItem $CanvasDist -Recurse -File | Measure-Object -Property Length -Sum).Sum
        Write-Host "  Canvas distribution: $([math]::Round($size / 1MB, 2)) MB" -ForegroundColor Green
    } finally {
        Pop-Location
    }
}

# === 3. 构建前端 + 后端 ===
Write-Host "`n[2/3] 构建前端 (Vite) + 后端 (esbuild)..." -ForegroundColor Magenta
Push-Location $RootDir
try {
    npm run build 2>&1
    if ($LASTEXITCODE -ne 0) { throw "Vite/esbuild build failed" }
    Write-Host "  前端+后端构建完成" -ForegroundColor Green
} finally {
    Pop-Location
}

# === 4. 打包 Electron ===
Write-Host "`n[3/3] 打包 Electron (electron-builder)..." -ForegroundColor Magenta
Push-Location $RootDir
try {
    npx electron-builder build --win --x64 --config.electronDist=node_modules/electron/dist 2>&1
    if ($LASTEXITCODE -ne 0) { throw "electron-builder failed" }
    
    $releaseDir = Join-Path $RootDir "release"
    if (Test-Path $releaseDir) {
        Write-Host "`n打包产物:" -ForegroundColor Cyan
        Get-ChildItem $releaseDir -Recurse -File | Where-Object { $_.Extension -in ".exe", ".zip", ".msi", ".7z" } | Select-Object Name, Length | Format-Table -AutoSize
    }
    Write-Host "`n打包完成!" -ForegroundColor Green
} finally {
    Pop-Location
}
