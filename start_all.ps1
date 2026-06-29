# ============================================================
# SoloForge One-Click Startup + Connectivity Test
# Usage: powershell -ExecutionPolicy Bypass -File start_all.ps1
# Stop : Ctrl+C
# ============================================================

$ErrorActionPreference = "Continue"
$ProjectRoot = $PSScriptRoot
Set-Location $ProjectRoot

# 强制 UTF-8 输出
$OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
chcp 65001 | Out-Null

function Write-Banner($text) {
    Write-Host ""
    Write-Host "============================================================" -ForegroundColor Cyan
    Write-Host ("  " + $text) -ForegroundColor Cyan
    Write-Host "============================================================" -ForegroundColor Cyan
    Write-Host ""
}

function Write-Ok($text)   { Write-Host ("  [OK]   " + $text) -ForegroundColor Green }
function Write-Warn($text) { Write-Host ("  [WARN] " + $text) -ForegroundColor Yellow }
function Write-Err($text)  { Write-Host ("  [FAIL] " + $text) -ForegroundColor Red }
function Write-Info($text) { Write-Host ("  [info] " + $text) -ForegroundColor Gray }

function Test-Port($port, $hostName = "127.0.0.1") {
    $conn = Get-NetTCPConnection -LocalPort $port -ErrorAction SilentlyContinue -State Listen
    return $null -ne $conn
}

function Wait-Port($port, $timeoutSec = 30, $hostName = "127.0.0.1") {
    $deadline = (Get-Date).AddSeconds($timeoutSec)
    while ((Get-Date) -lt $deadline) {
        if (Test-Port $port $hostName) { return $true }
        Start-Sleep -Milliseconds 500
    }
    return $false
}

function Test-Tcp([string]$tcpHost, [int]$port) {
    try {
        $client = New-Object System.Net.Sockets.TcpClient
        $iar = $client.BeginConnect($tcpHost, $port, $null, $null)
        $success = $iar.AsyncWaitHandle.WaitOne(2000, $false)
        $client.Close()
        return $success
    } catch { return $false }
}

function Test-Http([string]$url, [int]$timeoutSec = 5) {
    try {
        $req = [System.Net.HttpWebRequest]::Create($url)
        $req.Timeout = $timeoutSec * 1000
        $req.Method = "GET"
        $resp = $req.GetResponse()
        $code = [int]$resp.StatusCode
        $resp.Close()
        return ($code -ge 200 -and $code -lt 500)
    } catch [System.Net.WebException] {
        try {
            $code = [int]$_.Exception.Response.StatusCode
            return ($code -ge 200 -and $code -lt 500)
        } catch { return $false }
    } catch { return $false }
}

function Test-GarnetPing {
    try {
        $client = New-Object System.Net.Sockets.TcpClient
        $iar = $client.BeginConnect("127.0.0.1", 6379, $null, $null)
        if (-not $iar.AsyncWaitHandle.WaitOne(2000, $false)) { $client.Close(); return $false }
        $stream = $client.GetStream()
        $writer = New-Object System.IO.StreamWriter($stream)
        $reader = New-Object System.IO.StreamReader($stream)
        $writer.WriteLine("PING"); $writer.Flush()
        Start-Sleep -Milliseconds 200
        $line = $reader.ReadLine()
        $client.Close()
        return ($line -match "PONG")
    } catch { return $false }
}

# 准备日志目录
$LogDir = Join-Path $ProjectRoot "logs"
if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir | Out-Null }

# 清理已存在进程
Write-Banner "SoloForge one-click startup - cleanup"
Get-Process -Name "node","GarnetServer","scheduler","git-service" -ErrorAction SilentlyContinue | ForEach-Object {
    Write-Info ("stopping existing process: " + $_.ProcessName + " PID=" + $_.Id)
    $_ | Stop-Process -Force -ErrorAction SilentlyContinue
}
Start-Sleep -Seconds 2

# 1. Garnet
Write-Banner "[1/6] Starting Garnet (hot data layer) - port 6379"
$GarnetExe = Join-Path $ProjectRoot "bin\garnet\portable\net10.0\GarnetServer.exe"
$GarnetData = Join-Path $ProjectRoot "bin\garnet\data"
$GarnetLogDir = Join-Path $GarnetData "logs"
$GarnetCkptDir = Join-Path $GarnetData "checkpoint"
if (-not (Test-Path $GarnetData))    { New-Item -ItemType Directory -Path $GarnetData | Out-Null }
if (-not (Test-Path $GarnetLogDir))  { New-Item -ItemType Directory -Path $GarnetLogDir | Out-Null }
if (-not (Test-Path $GarnetCkptDir)) { New-Item -ItemType Directory -Path $GarnetCkptDir | Out-Null }

if (Test-Path $GarnetExe) {
    $GarnetLogFile = Join-Path $LogDir "garnet.log"
    $GarnetProc = Start-Process -FilePath $GarnetExe `
        -ArgumentList "--port","6379","--disable-console-logger" `
        -RedirectStandardOutput $GarnetLogFile -RedirectStandardError "$GarnetLogFile.err" `
        -WindowStyle Hidden -PassThru
    Write-Ok ("Garnet launched (PID " + $GarnetProc.Id + ")")
    if (Wait-Port 6379 20) { Write-Ok "Garnet port 6379 READY" }
    else { Write-Warn "Garnet port 6379 NOT ready in 20s" }
} else {
    Write-Err ("GarnetServer.exe not found: " + $GarnetExe)
}

# 2. Rust Scheduler
Write-Banner "[2/6] Rust Scheduler - spawned by main process"
$SchedulerExe = Join-Path $ProjectRoot "bin\scheduler.exe"
if (Test-Path $SchedulerExe) {
    Write-Ok ("scheduler.exe ready: " + $SchedulerExe + " (auto-spawned by core)")
} else {
    Write-Err ("scheduler.exe not found: " + $SchedulerExe)
}

# 3. MARL Python
Write-Banner "[3/6] Starting MARL Python service - port 8765"
$PythonExe = Join-Path $ProjectRoot "bin\python-3.13\python.exe"
$PythonCwd = Join-Path $ProjectRoot "python"
if (Test-Path $PythonExe) {
    $MarlLog = Join-Path $LogDir "marl.log"
    $MarlProc = Start-Process -FilePath $PythonExe `
        -ArgumentList "-u","-m","marl_service.server_prod" `
        -WorkingDirectory $PythonCwd `
        -RedirectStandardOutput $MarlLog -RedirectStandardError "$MarlLog.err" `
        -WindowStyle Hidden -PassThru
    Write-Info ("MARL launched (PID " + $MarlProc.Id + "), waiting for ready...")
    if (Wait-Port 8765 20) { Write-Ok "MARL port 8765 READY" }
    else { Write-Warn "MARL port 8765 NOT ready in 20s (check logs/marl.log)" }
} else {
    Write-Err ("Python.exe not found: " + $PythonExe)
}

# 4. SoloForge Core
Write-Banner "[4/6] Starting SoloForge Core - port 3001 (API) + 9090 (Prometheus)"
$NpmCmd  = Join-Path $ProjectRoot "bin/nodejs/npm.cmd"
$CoreLog = Join-Path $LogDir "core.log"
if (Test-Path $NpmCmd) {
    $CoreProc = Start-Process -FilePath $NpmCmd `
        -ArgumentList "start" `
        -WorkingDirectory $ProjectRoot `
        -RedirectStandardOutput $CoreLog -RedirectStandardError "$CoreLog.err" `
        -WindowStyle Hidden -PassThru
    Write-Info ("Core launched (PID " + $CoreProc.Id + "), waiting for kernel READY...")
    if (Wait-Port 3001 60) { Write-Ok "API port 3001 READY" }
    else { Write-Warn "API port 3001 NOT ready in 60s (check logs/core.log)" }
    if (Wait-Port 9090 10) { Write-Ok "Prometheus port 9090 READY" }
    else { Write-Warn "Prometheus port 9090 NOT ready" }
} else {
    Write-Err ("npm.cmd not found: " + $NpmCmd)
}

# 5. Go git-service
Write-Banner "[5/6] Starting Go git-service - port 3002"
$GitExe = Join-Path $ProjectRoot "UI\git-service\git-service.exe"
$GitLog = Join-Path $LogDir "git-service.log"
if (Test-Path $GitExe) {
    $GitProc = Start-Process -FilePath $GitExe `
        -ArgumentList "--port","3002","--repo",$ProjectRoot `
        -WorkingDirectory (Join-Path $ProjectRoot "UI\git-service") `
        -RedirectStandardOutput $GitLog -RedirectStandardError "$GitLog.err" `
        -WindowStyle Hidden -PassThru
    Write-Info ("git-service launched (PID " + $GitProc.Id + "), waiting...")
    if (Wait-Port 3002 10) { Write-Ok "git-service port 3002 READY" }
    else { Write-Warn "git-service port 3002 NOT ready in 10s" }
} else {
    Write-Warn ("git-service.exe not found: " + $GitExe)
}

# 6. UI Node Dev Server (use project-local npm)
Write-Banner "[6/6] Starting UI Node dev server - port 3000"
$UiNpmCmd = Join-Path $ProjectRoot "bin/nodejs/npm.cmd"
$UiLog = Join-Path $LogDir "ui.log"
$UiCwd = Join-Path $ProjectRoot "UI"
if (Test-Path $UiNpmCmd) {
    $UiProc = Start-Process -FilePath $UiNpmCmd `
        -ArgumentList "run","dev:server" `
        -WorkingDirectory $UiCwd `
        -RedirectStandardOutput $UiLog -RedirectStandardError "$UiLog.err" `
        -WindowStyle Hidden -PassThru
    Write-Info ("UI dev launched (PID " + $UiProc.Id + "), waiting...")
    if (Wait-Port 3000 45) { Write-Ok "UI port 3000 READY" }
    else { Write-Warn "UI port 3000 NOT ready in 45s" }
} else {
    Write-Warn ("project-local npm not found: " + $UiNpmCmd)
}

# 连通性测试
Write-Banner "Connectivity Test"
Start-Sleep -Seconds 3

$Tests = @(
    @{ Name = "Garnet PING (6379)";              Cmd = { Test-GarnetPing } }
    @{ Name = "MARL TCP (8765)";                 Cmd = { Test-Tcp "127.0.0.1" 8765 } }
    @{ Name = "API /api/health (3001)";          Cmd = { Test-Http "http://127.0.0.1:3001/api/health" } }
    @{ Name = "API /api/events/stream (3001)";   Cmd = { Test-Http "http://127.0.0.1:3001/api/events/stream" 5 } }
    @{ Name = "Prometheus /metrics (9090)";      Cmd = { Test-Http "http://127.0.0.1:9090/metrics" } }
    @{ Name = "git-service /health (3002)";      Cmd = { Test-Http "http://127.0.0.1:3002/health" } }
    @{ Name = "UI / (3000)";                     Cmd = { Test-Http "http://127.0.0.1:3000/" } }
)

$pass = 0; $fail = 0
foreach ($t in $Tests) {
    $ok = & $t.Cmd
    if ($ok) { Write-Ok $t.Name; $pass++ } else { Write-Err $t.Name; $fail++ }
}

Write-Banner ("Test Result: PASS=" + $pass + " FAIL=" + $fail)
Write-Host ("  log dir: " + $LogDir) -ForegroundColor Gray
Write-Host ""
Write-Host "  Endpoints:" -ForegroundColor Cyan
Write-Host "     API Server:        http://127.0.0.1:3001" -ForegroundColor White
Write-Host "     Admin UI:          http://127.0.0.1:3001/admin" -ForegroundColor White
Write-Host "     SSE Events:        http://127.0.0.1:3001/api/events/stream" -ForegroundColor White
Write-Host "     Prometheus:        http://127.0.0.1:9090/metrics" -ForegroundColor White
Write-Host "     SoloForge Web UI:  http://127.0.0.1:3000" -ForegroundColor White
Write-Host ""
Write-Host "  Press Ctrl+C to stop all services..." -ForegroundColor Yellow
