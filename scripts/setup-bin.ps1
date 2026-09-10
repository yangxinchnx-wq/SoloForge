#Requires -Version 5.1
<#
.SYNOPSIS
    Rebuild the SoloForge bin/ directory (third-party runtimes and local models).

.DESCRIPTION
    bin/ is excluded by .gitignore, so it never travels with Git.
    Run this on a fresh machine to re-download the components.

    Default: Databases + Models.
    Add -Component Python to also rebuild bin/python-3.13: it downloads the 3.13.14 installer
    and reinstalls every package from scripts/requirements-bin.txt.
    torch is pulled from the CPU index on purpose - the default PyPI wheel is the CUDA build
    and would pull roughly 2.5 GB instead of 500 MB.
    Never needed: bin/data (runtime state) and bin/python-3.13.tar.gz (leftover archive).

.PARAMETER Component
    Which parts to rebuild: Databases, Models, Runtimes, All.

.PARAMETER UseMirror
    Route GitHub Releases and HuggingFace through CN mirrors (ghproxy.net / hf-mirror.com).

.PARAMETER IncludeOnnx
    Also pull the onnx/ and openvino/ model variants (+450 MB). Usually not needed.

.EXAMPLE
    .\setup-bin.ps1
    .\setup-bin.ps1 -Component All -UseMirror
#>
[CmdletBinding()]
param(
    [ValidateSet('Databases', 'Models', 'Runtimes', 'Python', 'All')]
    [string[]]$Component = @('Databases', 'Models'),

    [switch]$UseMirror,

    [switch]$IncludeOnnx,

    [string]$Root = (Split-Path -Parent $PSScriptRoot)
)

$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'

$bin = Join-Path $Root 'bin'
$tmp = Join-Path $env:TEMP 'soloforge-bin'
$ghPrefix = if ($UseMirror) { 'https://ghproxy.net/' } else { '' }
$hfHost = if ($UseMirror) { 'https://hf-mirror.com' } else { 'https://huggingface.co' }

$SurrealVersion = '2.0.3'
$QdrantVersion = '1.18.2'
$GarnetVersion = '1.1.10'
$NodeVersion = '24.15.0'
$JdkMajor = '23'
$ModelRepo = 'sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2'
$ModelDir = Join-Path $bin 'models/paraphrase-multilingual-MiniLM-L12-v2'
$PythonVersion = '3.13.14'
$TorchVersion = '2.12.1'
$PyIndex = 'https://pypi.tuna.tsinghua.edu.cn/simple'
$TorchCpuIndex = 'https://download.pytorch.org/whl/cpu'

function Ensure-Dir {
    param([string]$Path)
    if (-not (Test-Path $Path)) { New-Item -ItemType Directory -Path $Path -Force | Out-Null }
}

function Get-Remote {
    param([string]$Url, [string]$OutFile)
    Write-Host "    GET $Url" -ForegroundColor DarkGray
    try {
        Invoke-WebRequest -Uri $Url -OutFile $OutFile -UseBasicParsing -TimeoutSec 600
        return $true
    }
    catch {
        Write-Host "    failed: $($_.Exception.Message)" -ForegroundColor Yellow
        return $false
    }
}

function Install-Surreal {
    Write-Host '  SurrealDB' -ForegroundColor Cyan
    $dest = Join-Path $bin 'surreal.exe'
    if (Test-Path $dest) { Write-Host '    already present, skipped'; return }
    Ensure-Dir $tmp
    $pkg = Join-Path $tmp 'surreal.tgz'
    $url = "${ghPrefix}https://github.com/surrealdb/surrealdb/releases/download/v$SurrealVersion/surreal-v$SurrealVersion.windows-x86_64.tgz"
    if (-not (Get-Remote $url $pkg)) {
        Write-Host "    manual: https://github.com/surrealdb/surrealdb/releases/tag/v$SurrealVersion"
        return
    }
    & tar -xzf $pkg -C $tmp
    $hit = Get-ChildItem -Path $tmp -Filter 'surreal.exe' -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($hit) { Copy-Item $hit.FullName $dest -Force; Write-Host '    done' }
    else { Write-Host '    surreal.exe not found after extract' -ForegroundColor Yellow }
}

function Install-Qdrant {
    Write-Host '  Qdrant' -ForegroundColor Cyan
    $dest = Join-Path $bin 'qdrant/qdrant.exe'
    if (Test-Path $dest) { Write-Host '    already present, skipped'; return }
    Ensure-Dir (Join-Path $bin 'qdrant')
    $pkg = Join-Path $tmp 'qdrant.zip'
    $url = "${ghPrefix}https://github.com/qdrant/qdrant/releases/download/v$QdrantVersion/qdrant-x86_64-pc-windows-msvc.zip"
    if (-not (Get-Remote $url $pkg)) {
        Write-Host "    manual: https://github.com/qdrant/qdrant/releases/tag/v$QdrantVersion"
        return
    }
    $out = Join-Path $tmp 'qdrant'
    Expand-Archive -Path $pkg -DestinationPath $out -Force
    $hit = Get-ChildItem -Path $out -Filter 'qdrant.exe' -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($hit) { Copy-Item $hit.FullName $dest -Force; Write-Host '    done' }
    else { Write-Host '    qdrant.exe not found after extract' -ForegroundColor Yellow }
}

function Install-Garnet {
    Write-Host '  Garnet' -ForegroundColor Cyan
    $dest = Join-Path $bin 'garnet/portable/net10.0/GarnetServer.exe'
    if (Test-Path $dest) { Write-Host '    already present, skipped'; return }
    Ensure-Dir (Split-Path $dest)
    $pkg = Join-Path $tmp 'garnet.zip'
    $candidates = @(
        "Garnet.windows-x64.release.zip",
        "Garnet.win-x64.release.zip"
    )
    $ok = $false
    foreach ($asset in $candidates) {
        $url = "${ghPrefix}https://github.com/microsoft/garnet/releases/download/v$GarnetVersion/$asset"
        if (Get-Remote $url $pkg) { $ok = $true; break }
    }
    if (-not $ok) {
        Write-Host "    manual: https://github.com/microsoft/garnet/releases/tag/v$GarnetVersion"
        return
    }
    $out = Join-Path $tmp 'garnet'
    Expand-Archive -Path $pkg -DestinationPath $out -Force
    $hit = Get-ChildItem -Path $out -Filter 'GarnetServer.exe' -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($hit) { Copy-Item $hit.FullName $dest -Force; Write-Host '    done' }
    else { Write-Host '    GarnetServer.exe not found after extract' -ForegroundColor Yellow }
}

function Install-Models {
    Write-Host '  Embedding model (paraphrase-multilingual-MiniLM-L12-v2)' -ForegroundColor Cyan
    Ensure-Dir $ModelDir
    Ensure-Dir (Join-Path $ModelDir '1_Pooling')

    $files = @(
        'config.json',
        'config_sentence_transformers.json',
        'modules.json',
        'sentence_bert_config.json',
        'special_tokens_map.json',
        'tokenizer.json',
        'tokenizer_config.json',
        'sentencepiece.bpe.model',
        'model.safetensors',
        '1_Pooling/config.json'
    )
    if ($IncludeOnnx) {
        $files += @(
            'onnx/model.onnx',
            'openvino/openvino_model.xml',
            'openvino/openvino_model.bin'
        )
    }

    foreach ($f in $files) {
        $target = Join-Path $ModelDir $f
        if (Test-Path $target) { Write-Host "    skip $f"; continue }
        Ensure-Dir (Split-Path $target)
        $url = "$hfHost/$ModelRepo/resolve/main/$f"
        if (-not (Get-Remote $url $target)) {
            Write-Host "    manual: $url" -ForegroundColor Yellow
        }
        else {
            Write-Host "    ok $f"
        }
    }
}

function Install-Node {
    Write-Host '  Node.js portable' -ForegroundColor Cyan
    $dest = Join-Path $bin 'nodejs'
    if (Test-Path (Join-Path $dest 'node.exe')) { Write-Host '    already present, skipped'; return }
    $pkg = Join-Path $tmp 'node.zip'
    $url = "https://nodejs.org/dist/v$NodeVersion/node-v$NodeVersion-win-x64.zip"
    if (-not (Get-Remote $url $pkg)) { Write-Host "    manual: $url"; return }
    $out = Join-Path $tmp 'node'
    Expand-Archive -Path $pkg -DestinationPath $out -Force
    $inner = Get-ChildItem -Path $out -Directory | Select-Object -First 1
    Ensure-Dir $dest
    if ($inner) { Copy-Item (Join-Path $inner.FullName '*') $dest -Recurse -Force }
    Write-Host '    done'
}

function Install-Jdk {
    Write-Host "  JDK $JdkMajor (mini)" -ForegroundColor Cyan
    $dest = Join-Path $bin 'jdk-23-mini'
    if (Test-Path $dest) { Write-Host '    already present, skipped'; return }
    $pkg = Join-Path $tmp 'jdk.zip'
    $url = "https://api.adoptium.net/v3/binary/latest/$JdkMajor/ga/windows/x64/jdk/hotspot/normal/eclipse"
    if (-not (Get-Remote $url $pkg)) { Write-Host "    manual: https://adoptium.net/temurin/releases/?version=$JdkMajor"; return }
    $out = Join-Path $tmp 'jdk'
    Expand-Archive -Path $pkg -DestinationPath $out -Force
    $inner = Get-ChildItem -Path $out -Directory | Select-Object -First 1
    if ($inner) {
        Ensure-Dir (Split-Path $dest)
        Copy-Item $inner.FullName $dest -Recurse -Force
        Write-Host '    done'
    }
}

function Install-Python {
    Write-Host "  Python $PythonVersion + AI Society packages" -ForegroundColor Cyan
    $target = Join-Path $bin 'python-3.13'
    $py = Join-Path $target 'python.exe'
    if (Test-Path $py) { Write-Host '    already present, skipped'; return }

    $installer = Join-Path $tmp 'python-installer.exe'
    $url = "https://www.python.org/ftp/python/$PythonVersion/python-$PythonVersion-amd64.exe"
    if (-not (Get-Remote $url $installer)) { Write-Host "    manual: $url"; return }

    Write-Host '    running silent install (1-2 min)...'
    & $installer /quiet InstallAllUsers=0 TargetDir=$target PrependPath=0 AssociateFiles=0 Include_launcher=0
    for ($i = 0; $i -lt 90; $i++) {
        if (Test-Path $py) { break }
        Start-Sleep -Seconds 2
    }
    if (-not (Test-Path $py)) {
        Write-Host '    python.exe not found, install may have failed' -ForegroundColor Yellow
        return
    }

    Write-Host '    installing packages (torch CPU build first, this is the slow part)...'
    $env:HTTP_PROXY = ''; $env:HTTPS_PROXY = ''; $env:no_proxy = '*'
    & $py -m pip install --upgrade pip -i $PyIndex
    & $py -m pip install "torch==$TorchVersion" --index-url $TorchCpuIndex
    $req = Join-Path $Root 'scripts/requirements-bin.txt'
    if (Test-Path $req) { & $py -m pip install -r $req -i $PyIndex }
    else { Write-Host "    missing $req" -ForegroundColor Yellow }
    Write-Host '    done'
}

Ensure-Dir $bin
Ensure-Dir $tmp
Write-Host "Target: $bin" -ForegroundColor Green

$set = if ($Component -contains 'All') { @('Databases', 'Models', 'Runtimes', 'Python') } else { $Component }

if ($set -contains 'Databases') {
    Install-Surreal
    Install-Qdrant
    Install-Garnet
}
if ($set -contains 'Models') {
    Install-Models
}
if ($set -contains 'Runtimes') {
    Install-Node
    Install-Jdk
}
if ($set -contains 'Python') {
    Install-Python
}

Write-Host ''
Write-Host 'Nothing needs to be copied from the old machine.' -ForegroundColor Green
Write-Host 'Not required on a new machine:'
Write-Host '  bin/data/                592 MB  qdrant storage + duckdb + pids, regenerated at runtime'
Write-Host '  bin/python-3.13.tar.gz    45 MB  leftover archive, safe to delete'
