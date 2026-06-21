param(
    [Parameter(Mandatory=$true)]
    [string]$DartSdkPath,
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"
$BackupDir = Join-Path $DartSdkPath "_backup"

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  Dart SDK 裁剪脚本" -ForegroundColor Cyan
Write-Host "  Target: $DartSdkPath" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan

if (-not (Test-Path $DartSdkPath)) {
    Write-Error "Dart SDK path not found: $DartSdkPath"
    exit 1
}

$totalBefore = (Get-ChildItem $DartSdkPath -Recurse -File | Measure-Object -Property Length -Sum).Sum
Write-Host "Current SDK size: $([math]::Round($totalBefore / 1MB, 2)) MB" -ForegroundColor Yellow

if (-not $DryRun) {
    New-Item -ItemType Directory -Force -Path $BackupDir | Out-Null
}

function Backup-And-Remove {
    param([string]$Path, [string]$Reason)
    
    if (-not (Test-Path $Path)) { return }
    
    if ($DryRun) {
        Write-Host "  [DRY-RUN] Would delete: $Path ($Reason)" -ForegroundColor Gray
        return
    }
    
    $relPath = $Path.Substring($DartSdkPath.Length).TrimStart('\')
    $targetDir = Join-Path $BackupDir (Split-Path $relPath -Parent)
    New-Item -ItemType Directory -Force -Path $targetDir | Out-Null
    
    Copy-Item -Path $Path -Destination $targetDir -Recurse -Force
    Remove-Item -Path $Path -Recurse -Force -ErrorAction SilentlyContinue
    Write-Host "  Removed: $relPath ($Reason)" -ForegroundColor Green
}

Write-Host "`n[1/6] Cleaning bin/snapshots/..." -ForegroundColor Magenta
$snapshotDir = Join-Path $DartSdkPath "bin\snapshots"
if (Test-Path $snapshotDir) {
    Get-ChildItem $snapshotDir -Filter "*.snapshot" | ForEach-Object {
        if ($_.Name -in @("frontend_server.dart.snapshot", "gen_kernel.dart.snapshot", "kernel_worker.dart.snapshot")) {
            Write-Host "  Keeping: $($_.Name)" -ForegroundColor Green
        } else {
            Backup-And-Remove $_.FullName "Non-essential snapshot"
        }
    }
}

Write-Host "`n[2/6] Removing Web-related Dart libraries..." -ForegroundColor Magenta
$libDir = Join-Path $DartSdkPath "lib"
$webLibs = @("html", "indexed_db", "web_audio", "web_gl", "web_sql", "js", "js_util")
foreach ($lib in $webLibs) {
    $libPath = Join-Path $libDir $lib
    Backup-And-Remove $libPath "Web library (not needed for compilation)"
}

Write-Host "`n[3/6] Removing non-essential Dart tools..." -ForegroundColor Magenta
$binDir = Join-Path $DartSdkPath "bin"
$removeTools = @(
    "dartanalyzer.bat", "dartanalyzer",
    "dartdoc.bat", "dartdoc",
    "dartfmt.bat", "dartfmt",
    "dart2js.bat", "dart2js",
    "dartdevc.bat", "dartdevc",
    "dartdevnative.bat", "dartdevnative"
)
foreach ($tool in $removeTools) {
    $toolPath = Join-Path $binDir $tool
    Backup-And-Remove $toolPath "Non-essential tool"
}

Write-Host "`n[4/6] Removing dev tooling directories..." -ForegroundColor Magenta
$removeDirs = @(
    "bin\dartdevc",
    "bin\snapshots\analysis_server.dart.snapshot",
    "bin\snapshots\dds.dart.snapshot",
    "bin\snapshots\dtd.dart.snapshot"
)
foreach ($dir in $removeDirs) {
    Backup-And-Remove (Join-Path $DartSdkPath $dir) "Dev tooling directory"
}

Write-Host "`n[5/6] Cleaning pub cache, documentation, and examples..." -ForegroundColor Magenta
$extraCleanup = @(
    "lib\_internal\pub",
    "doc",
    "examples",
    "third_party\android_embedding_dependencies"
)
foreach ($dir in $extraCleanup) {
    Backup-And-Remove (Join-Path $DartSdkPath $dir) "Not needed for compilation"
}

Write-Host "`n[6/6] Verification - testing frontend_server..." -ForegroundColor Magenta
$dartExe = Join-Path $DartSdkPath "bin\dart.exe"
$fes = Join-Path $DartSdkPath "bin\snapshots\frontend_server.dart.snapshot"
if ((Test-Path $dartExe) -and (Test-Path $fes)) {
    Write-Host "  dart.exe: FOUND" -ForegroundColor Green
    Write-Host "  frontend_server.dart.snapshot: FOUND" -ForegroundColor Green
    Write-Host "  gen_kernel.dart.snapshot: $(if (Test-Path (Join-Path $DartSdkPath 'bin\snapshots\gen_kernel.dart.snapshot')) {'FOUND'} else {'MISSING'})" -ForegroundColor $(if (Test-Path (Join-Path $DartSdkPath 'bin\snapshots\gen_kernel.dart.snapshot')) {'Green'} else {'Red'})
    Write-Host "  kernel_worker.dart.snapshot: $(if (Test-Path (Join-Path $DartSdkPath 'bin\snapshots\kernel_worker.dart.snapshot')) {'FOUND'} else {'MISSING'})" -ForegroundColor $(if (Test-Path (Join-Path $DartSdkPath 'bin\snapshots\kernel_worker.dart.snapshot')) {'Green'} else {'Red'})
} else {
    Write-Warning "  Critical files missing after pruning!"
    if (-not (Test-Path $dartExe)) { Write-Error "  dart.exe not found!" }
    if (-not (Test-Path $fes)) { Write-Error "  frontend_server.dart.snapshot not found!" }
}

$totalAfter = (Get-ChildItem $DartSdkPath -Recurse -File | Measure-Object -Property Length -Sum).Sum
$saved = $totalBefore - $totalAfter
$finalSize = [math]::Round($totalAfter / 1MB, 2)
$savedSize = [math]::Round($saved / 1MB, 2)
Write-Host "`n========================================" -ForegroundColor Cyan
Write-Host "  Pruning Complete!" -ForegroundColor Cyan
Write-Host "  Before: $([math]::Round($totalBefore / 1MB, 2)) MB" -ForegroundColor Yellow
Write-Host "  After:  $finalSize MB" -ForegroundColor Green
Write-Host "  Saved:  $savedSize MB" -ForegroundColor Green
Write-Host "  Backup: $BackupDir" -ForegroundColor Gray
Write-Host "========================================" -ForegroundColor Cyan

if ($finalSize -gt 250) {
    Write-Warning "Target size is ~200 MB. Current: $finalSize MB. Consider additional manual pruning."
} else {
    Write-Host "Target achieved! (~200 MB)" -ForegroundColor Green
}
