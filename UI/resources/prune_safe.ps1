param([string]$SdkPath)

$ErrorActionPreference = "Stop"
$totalBefore = (Get-ChildItem $SdkPath -Recurse -File | Measure-Object -Property Length -Sum).Sum
Write-Host "=== Safe Dart SDK Pruning ===" -ForegroundColor Cyan
Write-Host "Before: $([math]::Round($totalBefore / 1MB, 2)) MB" -ForegroundColor Yellow

# === Safe removals - web/non-native stuff ===
Write-Host "`n[1/4] Removing Web-only libraries (safe)..." -ForegroundColor Magenta
@("html", "indexed_db", "web_audio", "web_gl", "web_sql", "js", "js_util") | ForEach-Object {
    $p = Join-Path $SdkPath "lib" $_
    if (Test-Path $p) {
        $size = (Get-ChildItem $p -Recurse -File -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum
        [System.IO.Directory]::Delete($p, $true)
        Write-Host "  Removed lib\$_ ($([math]::Round($size / 1MB, 2)) MB)" -ForegroundColor DarkYellow
    }
}

# === Remove WASM and JS _internal subtargets (keep only vm) ===
Write-Host "`n[2/4] Removing JS/WASM _internal targets (safe)..." -ForegroundColor Magenta
$internalDir = Join-Path $SdkPath "lib\_internal"
if (Test-Path $internalDir) {
    Get-ChildItem $internalDir -Directory | ForEach-Object {
        if ($_.Name -in @("js_dev_runtime", "js_runtime", "js_shared", "wasm", "wasm_js_compatibility")) {
            $size = (Get-ChildItem $_.FullName -Recurse -File -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum
            [System.IO.Directory]::Delete($_.FullName, $true)
            Write-Host "  Removed _internal\$($_.Name) ($([math]::Round($size / 1MB, 2)) MB)" -ForegroundColor DarkYellow
        }
    }
}

# === Remove doc, examples, pkg, third_party android ===
Write-Host "`n[3/4] Removing doc/examples/pkg/android-deps..." -ForegroundColor Magenta
@("doc", "examples", "pkg", "third_party\android_embedding_dependencies") | ForEach-Object {
    $p = Join-Path $SdkPath $_
    if (Test-Path $p) {
        $size = (Get-ChildItem $p -Recurse -File -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum
        [System.IO.Directory]::Delete($p, $true)
        Write-Host "  Removed $_ ($([math]::Round($size / 1MB, 2)) MB)" -ForegroundColor DarkYellow
    }
}

# === Remove non-essential snapshots (keep only what Flutter CLI needs) ===
Write-Host "`n[4/4] Removing non-essential snapshots..." -ForegroundColor Magenta
$snapDir = Join-Path $SdkPath "bin\snapshots"
$keep = @(
    "frontend_server.dart.snapshot",   # Flutter AOT compilation
    "kernel_worker.dart.snapshot",      # Used by frontend_server
    "dartdev.dart.snapshot",           # Flutter CLI dart runner
    "kernel-service.dart.snapshot",    # DartDev kernel service
    "dart_tooling_daemon.dart.snapshot", # Tooling daemon
    "dds.dart.snapshot",               # Dart Development Service
    "frontend_server_aot.dart.snapshot", # AOT variant
    "gen_kernel_aot.dart.snapshot"     # AOT kernel generator
)
if (Test-Path $snapDir) {
    Get-ChildItem $snapDir -Filter "*.snapshot" | ForEach-Object {
        if ($_.Name -notin $keep) {
            $size = $_.Length
            Remove-Item $_.FullName -Force -ErrorAction SilentlyContinue
            Write-Host "  Removed $($_.Name) ($([math]::Round($size / 1MB, 2)) MB)" -ForegroundColor DarkYellow
        }
    }
}

$totalAfter = (Get-ChildItem $SdkPath -Recurse -File | Measure-Object -Property Length -Sum).Sum
Write-Host "`n========================================" -ForegroundColor Cyan
Write-Host "  Pruning Complete!" -ForegroundColor Cyan
Write-Host "  Before: $([math]::Round($totalBefore / 1MB, 2)) MB" -ForegroundColor Yellow
Write-Host "  After:  $([math]::Round($totalAfter / 1MB, 2)) MB" -ForegroundColor Green
Write-Host "  Saved:  $([math]::Round(($totalBefore-$totalAfter) / 1MB, 2)) MB" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Cyan

Write-Host "`nRemaining snapshots:" -ForegroundColor Cyan
ls (Join-Path $SdkPath "bin\snapshots") | Select-Object Name, @{N='MB';E={[math]::Round($_.Length/1MB,2)}} | Format-Table -AutoSize
