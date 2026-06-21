param([string]$SdkPath)

$ErrorActionPreference = "Stop"

function Remove-Dir {
    param([string]$Path, [string]$Label)
    if (Test-Path $Path) {
        $size = (Get-ChildItem $Path -Recurse -File -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum
        [System.IO.Directory]::Delete($Path, $true)
        Write-Host "  Removed: $Label ($([math]::Round($size / 1MB, 2)) MB)" -ForegroundColor DarkYellow
    }
}

function Remove-File {
    param([string]$Path, [string]$Label)
    if (Test-Path $Path) {
        $size = (Get-Item $Path).Length
        [System.IO.File]::Delete($Path)
        Write-Host "  Removed: $Label ($([math]::Round($size / 1MB, 2)) MB)" -ForegroundColor DarkYellow
    }
}

Write-Host "=== Pruning Dart SDK ===" -ForegroundColor Cyan
$totalBefore = (Get-ChildItem $SdkPath -Recurse -File | Measure-Object -Property Length -Sum).Sum
Write-Host "Before: $([math]::Round($totalBefore / 1MB, 2)) MB" -ForegroundColor Yellow

Write-Host "`n[1/5] Removing non-essential snapshots..." -ForegroundColor Magenta
$snapDir = Join-Path $SdkPath "bin\snapshots"
$keepSnapshots = @(
    "frontend_server.dart.snapshot",     # Flutter AOT compilation
    "kernel_worker.dart.snapshot",        # Used by frontend_server
    "dartdev.dart.snapshot",             # Flutter CLI dart runner
    "kernel-service.dart.snapshot",      # DartDev kernel service
    "dart_tooling_daemon.dart.snapshot", # Tooling daemon
    "dds.dart.snapshot",                 # Dart Dev Service
    "frontend_server_aot.dart.snapshot", # AOT variant
    "gen_kernel_aot.dart.snapshot"       # AOT kernel generator
)
if (Test-Path $snapDir) {
    Get-ChildItem $snapDir -Filter "*.snapshot" | ForEach-Object {
        if ($_.Name -notin $keepSnapshots) {
            Remove-File $_.FullName "snapshot: $($_.Name)"
        }
    }
}

Write-Host "`n[2/5] Removing Web libraries..." -ForegroundColor Magenta
$libDir = Join-Path $SdkPath "lib"
@("html", "indexed_db", "web_audio", "web_gl", "web_sql", "js", "js_util") | ForEach-Object {
    Remove-Dir (Join-Path $libDir $_) "web lib: $_"
}

Write-Host "`n[3/5] Removing _internal sub-targets (keep only vm)..." -ForegroundColor Magenta
$internalDir = Join-Path $libDir "_internal"
if (Test-Path $internalDir) {
    Get-ChildItem $internalDir -Directory | ForEach-Object {
        if ($_.Name -ne "vm") {
            Remove-Dir $_.FullName "_internal: $($_.Name)"
        }
    }
}

Write-Host "`n[4/5] Removing dev tooling, doc, examples..." -ForegroundColor Magenta
Remove-Dir (Join-Path $SdkPath "doc") "doc"
Remove-Dir (Join-Path $SdkPath "examples") "examples"
Remove-Dir (Join-Path $SdkPath "third_party\android_embedding_dependencies") "android deps"
Remove-Dir (Join-Path $SdkPath "pkg") "pkg (dev packages)"
# analysis_server, dds, dtd removed via snapshot filter above

Write-Host "`n[5/5] Removing non-essential bin tools..." -ForegroundColor Magenta
$binDir = Join-Path $SdkPath "bin"
@("dartanalyzer.bat", "dartdoc.bat", "dartfmt.bat", "dart2js.bat", "dartdevc.bat", "dartdevnative.bat",
  "dartanalyzer", "dartdoc", "dartfmt", "dart2js", "dartdevc", "dartdevnative") | ForEach-Object {
    $p = Join-Path $binDir $_
    if (Test-Path $p) {
        if ((Get-Item $p) -is [System.IO.DirectoryInfo]) {
            Remove-Dir $p "tool: $_"
        } else {
            Remove-File $p "tool: $_"
        }
    }
}

$totalAfter = (Get-ChildItem $SdkPath -Recurse -File | Measure-Object -Property Length -Sum).Sum
$saved = $totalBefore - $totalAfter
Write-Host "`n========================================" -ForegroundColor Cyan
Write-Host "  Pruning Complete!" -ForegroundColor Cyan
Write-Host "  Before: $([math]::Round($totalBefore / 1MB, 2)) MB" -ForegroundColor Yellow
Write-Host "  After:  $([math]::Round($totalAfter / 1MB, 2)) MB" -ForegroundColor Green
Write-Host "  Saved:  $([math]::Round($saved / 1MB, 2)) MB" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Cyan

# Verify
$dartExe = Join-Path $SdkPath "bin\dart.exe"
$fes = Join-Path $SdkPath "bin\snapshots\frontend_server.dart.snapshot"
Write-Host "`nVerification:" -ForegroundColor Cyan
Write-Host "  dart.exe: $(if (Test-Path $dartExe) { 'OK' } else { 'MISSING!' })" -ForegroundColor $(if (Test-Path $dartExe) { 'Green' } else { 'Red' })
Write-Host "  frontend_server: $(if (Test-Path $fes) { 'OK' } else { 'MISSING!' })" -ForegroundColor $(if (Test-Path $fes) { 'Green' } else { 'Red' })
Write-Host "  dartdev: $(if (Test-Path (Join-Path $SdkPath 'bin\snapshots\dartdev.dart.snapshot')) { 'OK' } else { 'MISSING!' })" -ForegroundColor $(if (Test-Path (Join-Path $SdkPath 'bin\snapshots\dartdev.dart.snapshot')) { 'Green' } else { 'Red' })
Write-Host "  kernel-service: $(if (Test-Path (Join-Path $SdkPath 'bin\snapshots\kernel-service.dart.snapshot')) { 'OK' } else { 'MISSING!' })" -ForegroundColor $(if (Test-Path (Join-Path $SdkPath 'bin\snapshots\kernel-service.dart.snapshot')) { 'Green' } else { 'Red' })
