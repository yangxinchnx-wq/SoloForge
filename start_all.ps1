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
Get-Process -Name "node","GarnetServer","scheduler","git-service","java","electron","SoloForge" -ErrorAction SilentlyContinue | ForEach-Object {
    Write-Info ("stopping existing process: " + $_.ProcessName + " PID=" + $_.Id)
    $_ | Stop-Process -Force -ErrorAction SilentlyContinue
}
Start-Sleep -Seconds 2

# 1. Garnet
Write-Banner "[1/9] Starting Garnet (hot data layer) - port 6379"
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
Write-Banner "[2/9] Rust Scheduler - spawned by main process"
$SchedulerExe = Join-Path $ProjectRoot "bin\scheduler.exe"
if (Test-Path $SchedulerExe) {
    Write-Ok ("scheduler.exe ready: " + $SchedulerExe + " (auto-spawned by core)")
} else {
    Write-Err ("scheduler.exe not found: " + $SchedulerExe)
}

# 3. MARL Python (8765 TCP + 8766 HTTP Reputation + 8767 HTTP LLM)
Write-Banner "[3/9] Starting MARL Python service - port 8765/8766/8767"
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
    if (Wait-Port 8765 20) { Write-Ok "MARL TCP port 8765 READY" }
    else { Write-Warn "MARL TCP port 8765 NOT ready in 20s (check logs/marl.log)" }
    if (Wait-Port 8766 10) { Write-Ok "MARL Reputation HTTP port 8766 READY" }
    else { Write-Warn "MARL Reputation HTTP port 8766 NOT ready in 10s" }
    if (Wait-Port 8767 10) { Write-Ok "MARL LLM HTTP port 8767 READY" }
    else { Write-Warn "MARL LLM HTTP port 8767 NOT ready in 10s" }
} else {
    Write-Err ("Python.exe not found: " + $PythonExe)
}

# 4. DB Seed (governance 种子数据, 修复 Java Agent GovernanceClient 外键错误)
Write-Banner "[4/9] Seeding AI Society DB (governance records)"
$DbPath = Join-Path $ProjectRoot "python\data\ai_society\ai_society.db"
if (Test-Path $DbPath) {
    $SeedScript = @'
import sqlite3, datetime
db = r"__DB_PATH__"
conn = sqlite3.connect(db)
c = conn.cursor()
now = datetime.datetime.now().isoformat()
institutions = c.execute("SELECT id, name FROM institution").fetchall()
inserted = 0
for inst_id, inst_name in institutions:
    exists = c.execute("SELECT 1 FROM governance WHERE id = ?", (inst_id,)).fetchone()
    if not exists:
        c.execute("""INSERT INTO governance (id, institution_id, owner, effectiveness, violations, last_review, description, notes, created_at, updated_at)
                     VALUES (?, ?, ?, 1.0, 0, ?, ?, NULL, ?, ?)""",
                  (inst_id, inst_id, "system", now, f"{inst_name} governance", now, now))
        inserted += 1
conn.commit()
conn.close()
print(f"DB seed: {inserted} governance records inserted ({len(institutions)} institutions total)")
'@ -replace "__DB_PATH__", ($DbPath -replace "\\", "\\")
    $SeedFile = Join-Path $LogDir "db_seed.py"
    $SeedScript | Out-File -FilePath $SeedFile -Encoding utf8
    & $PythonExe $SeedFile
    if ($LASTEXITCODE -eq 0) { Write-Ok "AI Society DB seed completed" }
    else { Write-Warn "DB seed failed (non-blocking, governance records may already exist)" }
} else {
    Write-Warn ("AI Society DB not found: " + $DbPath + " (will be created by MARL)")
}

# 5. SoloForge Core
Write-Banner "[5/9] Starting SoloForge Core - port 3001 (API) + 9090 (Prometheus)"
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

# 6. Java Agent (Spring Boot, 8770) - Agent 管线核心
Write-Banner "[6/9] Starting Java Agent (Spring Boot) - port 8770"
$JavaJar = Join-Path $ProjectRoot "solo-forge-agent\target\solo-forge-agent-1.0.0.jar"
$JavaLog = Join-Path $LogDir "java-agent.log"
if (Test-Path $JavaJar) {
    $JavaCwd = Join-Path $ProjectRoot "solo-forge-agent"
    $JavaProc = Start-Process -FilePath "java" `
        -ArgumentList "-jar", $JavaJar `
        -WorkingDirectory $JavaCwd `
        -RedirectStandardOutput $JavaLog -RedirectStandardError "$JavaLog.err" `
        -WindowStyle Hidden -PassThru
    Write-Info ("Java Agent launched (PID " + $JavaProc.Id + "), waiting for ready...")
    if (Wait-Port 8770 30) { Write-Ok "Java Agent port 8770 READY" }
    else { Write-Warn "Java Agent port 8770 NOT ready in 30s (check logs/java-agent.log)" }
} else {
    Write-Err ("Java Agent JAR not found: " + $JavaJar + " - run: cd solo-forge-agent && mvn clean package -DskipTests")
}

# 7. Go git-service
Write-Banner "[7/9] Starting Go git-service - port 3002"
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

# 8. UI Node Dev Server
Write-Banner "[8/9] Starting UI Node dev server - port 3000"
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

# 9. Electron Shell (桌面壳子)
Write-Banner "[9/9] Starting Electron Shell"
$ElectronLog = Join-Path $LogDir "electron.log"
$ElectronCwd = Join-Path $ProjectRoot "UI"
if (Test-Path $UiNpmCmd) {
    # 用 npm run dev:electron 启动 Electron 壳子，加载 http://localhost:3000
    $ElectronProc = Start-Process -FilePath $UiNpmCmd `
        -ArgumentList "run","dev:electron" `
        -WorkingDirectory $ElectronCwd `
        -RedirectStandardOutput $ElectronLog -RedirectStandardError "$ElectronLog.err" `
        -WindowStyle Hidden -PassThru
    Write-Ok ("Electron Shell launched (PID " + $ElectronProc.Id + ")")
} else {
    Write-Warn ("Cannot launch Electron: npm not found at " + $UiNpmCmd)
}

# 连通性测试
Write-Banner "Connectivity Test"
Start-Sleep -Seconds 3

$Tests = @(
    @{ Name = "Garnet PING (6379)";              Cmd = { Test-GarnetPing } }
    @{ Name = "MARL TCP (8765)";                 Cmd = { Test-Tcp "127.0.0.1" 8765 } }
    @{ Name = "MARL Reputation HTTP (8766)";     Cmd = { Test-Http "http://127.0.0.1:8766/health" 3 } }
    @{ Name = "API /api/health (3001)";          Cmd = { Test-Http "http://127.0.0.1:3001/api/health" } }
    @{ Name = "API /api/events/stream (3001)";   Cmd = { Test-Http "http://127.0.0.1:3001/api/events/stream" 5 } }
    @{ Name = "Java Agent /health (8770)";       Cmd = { Test-Http "http://127.0.0.1:8770/health" 5 } }
    @{ Name = "Prometheus /metrics (9090)";      Cmd = { Test-Http "http://127.0.0.1:9090/metrics" } }
    @{ Name = "git-service /api/git/health (3002)"; Cmd = { Test-Http "http://127.0.0.1:3002/api/git/health" } }
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
Write-Host "     Java Agent:        http://127.0.0.1:8770/health" -ForegroundColor White
Write-Host "     MARL Reputation:   http://127.0.0.1:8766/health" -ForegroundColor White
Write-Host ""
Write-Host "  Press Ctrl+C to stop all services..." -ForegroundColor Yellow
