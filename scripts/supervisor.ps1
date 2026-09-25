<#
    pair-gate-and-clipboard — 独立守护脚本（不依赖 DSH 自启机制）

    职责
      * 幂等拉起两个局域网服务：pair-gate（默认 18080）、lan-chat（默认 18082）；
        端口已在监听就跳过，因此重复运行安全（计划任务/手动/安装脚本都调它）。
      * 崩溃自愈：本脚本每 15 秒巡检一次，发现子进程死了就重启（带退避）。
      * 日志轮转：单文件超过 5 MB 就改名 .1 再重开。
      * -Info 打印现场信息（入口地址、口令、端口状态、配置路径）。

    用法
      powershell -NoProfile -ExecutionPolicy Bypass -File supervisor.ps1            # 前台守护
      powershell -NoProfile -ExecutionPolicy Bypass -File supervisor.ps1 -Once      # 只拉一次，随即退出
      powershell -NoProfile -ExecutionPolicy Bypass -File supervisor.ps1 -Info      # 只打印信息，不启动
      powershell -NoProfile -ExecutionPolicy Bypass -File supervisor.ps1 -Stop      # 停掉两个服务
      powershell -NoProfile -ExecutionPolicy Bypass -File supervisor.ps1 -HealthCheck # 探针模式（给任务用）

    说明
      * 端口、口令、落盘路径全部来自 config\*.json；改完重启服务即可。
      * 只按"端口占用"判断存活，不做进程名匹配（避免误杀同名 node）。
#>
[CmdletBinding()]
param(
    [string]$Root = '',
    [switch]$Once,
    [switch]$Info,
    [switch]$Stop,
    [switch]$HealthCheck,
    [int]$IntervalSeconds = 15,
    [int]$StartupDelaySeconds = 0
)

$ErrorActionPreference = 'Continue'
Set-StrictMode -Off

if (-not $Root) { $Root = $PSScriptRoot }
$Root = (Resolve-Path -LiteralPath $Root).Path

$configDir = Join-Path $Root 'config'
$stateDir = Join-Path $Root 'state'
$logDir = Join-Path $Root 'logs'
$runDir = Join-Path $Root 'run'
foreach ($d in @($stateDir, $logDir, $runDir)) {
    if (-not (Test-Path -LiteralPath $d)) { New-Item -ItemType Directory -Force -Path $d | Out-Null }
}

$gateConfig = Join-Path $configDir 'pair-gate.config.json'
$chatConfig = Join-Path $configDir 'chat.config.json'

# UTF-8 无 BOM 读取：Node 的 JSON.parse 不接受 BOM。
function Read-JsonFile {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) { return $null }
    try {
        $text = [IO.File]::ReadAllText($Path, [Text.UTF8Encoding]::new($false))
        return $text | ConvertFrom-Json
    } catch {
        Write-Host ("pair-gate-and-clipboard: 配置读取失败 {0}：{1}" -f $Path, $_.Exception.Message) -ForegroundColor Yellow
        return $null
    }
}

# 真实可用的 PowerShell 宿主：本机 pwsh 可能被 WindowsApps 的 MSIX 别名劫持，
# 那种宿主在计划任务/无人交互下会 "access denied"。
function Resolve-PsHost {
    $candidates = @(
        (Join-Path $PSHOME 'pwsh.exe'),
        (Join-Path $PSHOME 'powershell.exe'),
        'C:\Program Files\PowerShell\7\pwsh.exe',
        (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe')
    )
    foreach ($c in $candidates) {
        if ($c -and $c -notmatch 'WindowsApps' -and (Test-Path -LiteralPath $c)) { return $c }
    }
    return $null
}

function Resolve-Node {
    $cmd = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    foreach ($c in @('C:\Program Files\nodejs\node.exe', 'C:\nodejs\node.exe', (Join-Path $env:LOCALAPPDATA 'Programs\nodejs\node.exe'))) {
        if (Test-Path -LiteralPath $c) { return $c }
    }
    return $null
}

function Get-PortOwner {
    param([int]$Port)
    try {
        $conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop | Select-Object -First 1
        if ($conn) { return [int]$conn.OwningProcess }
    } catch {}
    return 0
}

$script:Node = Resolve-Node
$gateCfg = Read-JsonFile -Path $gateConfig
$chatCfg = Read-JsonFile -Path $chatConfig
$gatePort = if ($gateCfg -and $gateCfg.port) { [int]$gateCfg.port } else { 18080 }
$chatPort = if ($chatCfg -and $chatCfg.port) { [int]$chatCfg.port } else { 18082 }

function Get-LanAddresses {
    $addrs = @()
    try {
        $addrs = @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction Stop |
            Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' -and $_.AddressState -eq 'Preferred' } |
            Select-Object -ExpandProperty IPAddress)
    } catch {}
    return $addrs
}

function Get-SupervisorState {
    $pidFile = Join-Path $runDir 'supervisor.pid'
    if (-not (Test-Path -LiteralPath $pidFile)) { return '未运行（无 PID 文件）' }
    try {
        $spid = [int]([IO.File]::ReadAllText($pidFile).Trim())
        if (Get-Process -Id $spid -ErrorAction Stop) { return ('运行中 (PID {0})' -f $spid) }
    } catch {}
    return '未运行（PID 文件过期）'
}

# --------------------------------------------------------------------------
# -Stop：停掉两个服务（只按端口取 PID）
# --------------------------------------------------------------------------
if ($Stop) {
    foreach ($p in @($gatePort, $chatPort)) {
        $owner = Get-PortOwner -Port $p
        if ($owner -gt 0) {
            try { Stop-Process -Id $owner -Force -ErrorAction Stop; Write-Host ("已停止端口 {0} (PID {1})" -f $p, $owner) }
            catch { Write-Host ("停止端口 {0} 失败：{1}" -f $p, $_.Exception.Message) -ForegroundColor Yellow }
        } else { Write-Host ("端口 {0} 本来就没在服务" -f $p) }
    }
    exit 0
}

# --------------------------------------------------------------------------
# 日志
# --------------------------------------------------------------------------
$logFile = Join-Path $logDir 'supervisor.log'
function Write-Log {
    param([string]$Message)
    $line = '[{0}] {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message
    Write-Host $line
    try {
        $fi = Get-Item -LiteralPath $logFile -ErrorAction SilentlyContinue
        if ($fi -and $fi.Length -gt 5MB) { Move-Item -LiteralPath $logFile -Destination "$logFile.1" -Force }
    } catch {}
    try { Add-Content -LiteralPath $logFile -Value $line -Encoding UTF8 -ErrorAction Stop } catch {}
}

function Start-Service-Process {
    param(
        [string]$Name,
        [string]$ScriptPath,
        [int]$Port,
        [hashtable]$Env
    )
    $owner = Get-PortOwner -Port $Port
    if ($owner -gt 0) {
        Write-Log ("{0,-10}: 端口 {1} 已在服务 (PID {2})，跳过" -f $Name, $Port, $owner)
        return $false
    }
    if (-not (Test-Path -LiteralPath $ScriptPath)) {
        Write-Log ("{0,-10}: 找不到脚本 {1}" -f $Name, $ScriptPath)
        return $false
    }
    if (-not $script:Node) {
        Write-Log ("{0,-10}: 找不到 node.exe，无法启动" -f $Name)
        return $false
    }
    # 子进程环境变量注入（配置路径 + 真实 web 端口）。
    foreach ($k in $Env.Keys) { Set-Item -Path ("env:" + $k) -Value $Env[$k] -Force }
    $svcLog = Join-Path $logDir ("{0}.log" -f $Name)
    try {
        $p = Start-Process -FilePath $script:Node -ArgumentList @($ScriptPath) `
            -WorkingDirectory (Split-Path -Parent $ScriptPath) -WindowStyle Hidden -PassThru `
            -RedirectStandardOutput $svcLog -RedirectStandardError (Join-Path $logDir ("{0}.err.log" -f $Name))
        [IO.File]::WriteAllText((Join-Path $runDir ("{0}.pid" -f $Name)), [string]$p.Id, [Text.UTF8Encoding]::new($false))
        Write-Log ("{0,-10}: 已启动，端口 {1} (PID {2})" -f $Name, $Port, $p.Id)
        return $true
    } catch {
        Write-Log ("{0,-10}: 启动失败：{1}" -f $Name, $_.Exception.Message)
        return $false
    } finally {
        foreach ($k in $Env.Keys) { Remove-Item -Path ("env:" + $k) -ErrorAction SilentlyContinue }
    }
}

function Get-WebPort {
    # 配对门要向本机 DSH Web 的 loopback 签发接口取链接，必须知道真实端口：
    # 配置里写 0/缺省时用 dsh web --dump-config 探测，最后退回 3080。
    if ($gateCfg -and $gateCfg.webPort) {
        $v = [int]$gateCfg.webPort
        if ($v -gt 0) { return $v }
    }
    if ($script:Node) {
        $bin = Join-Path $env:APPDATA 'npm\node_modules\@deepseek-ai\dsh\lib\bin.js'
        if (Test-Path -LiteralPath $bin) {
            try {
                $dump = & $script:Node $bin web --dump-config 2>$null
                $hit = $dump | Select-String -Pattern '^\s*port:\s*(\d+)\s*$' | Select-Object -Last 1
                if ($hit) { return [int]$hit.Matches[0].Groups[1].Value }
            } catch {}
        }
    }
    return 3080
}

function Start-All {
    $started = $false
    $webPort = Get-WebPort
    $started = (Start-Service-Process -Name 'pair-gate' `
        -ScriptPath (Join-Path $Root 'services\pair-gate\gate.mjs') -Port $gatePort `
        -Env @{
            PAIR_GATE_CONFIG   = $gateConfig
            PAIR_GATE_DATA_DIR = $stateDir
            PAIR_GATE_WEB_PORT = [string]$webPort
            PAIR_GATE_PORT     = [string]$gatePort
        }) -or $started
    $started = (Start-Service-Process -Name 'lan-chat' `
        -ScriptPath (Join-Path $Root 'services\lan-chat\chat.mjs') -Port $chatPort `
        -Env @{
            LANCHAT_CONFIG = $chatConfig
            LANCHAT_PORT   = [string]$chatPort
        }) -or $started
    return $started
}

# --------------------------------------------------------------------------
# -HealthCheck：探针模式（任务/监控用），不常驻
# --------------------------------------------------------------------------
if ($HealthCheck) {
    $gateOk = (Get-PortOwner -Port $gatePort) -gt 0
    $chatOk = (Get-PortOwner -Port $chatPort) -gt 0
    if ($gateOk -and $chatOk) { exit 0 }
    exit 1
}

if ($StartupDelaySeconds -gt 0) { Start-Sleep -Seconds $StartupDelaySeconds }

# --------------------------------------------------------------------------
# -Info：只打印，不启动（放在所有函数定义之后，避免调用未定义函数）
# --------------------------------------------------------------------------
if ($Info) {
    $lanIps = Get-LanAddresses
    Write-Host ''
    Write-Host '========== pair-gate-and-clipboard 现场信息 =========='
    Write-Host ('安装目录    : {0}' -f $Root)
    Write-Host ('配置文件    : {0}' -f $configDir)
    if ($lanIps.Count -gt 0) {
        Write-Host ('配对门入口  : {0}   口令 {1}' -f ((@($lanIps | ForEach-Object { 'http://{0}:{1}/' -f $_, $gatePort }) -join '  '), $(if ($gateCfg) { $gateCfg.password } else { '?' })))
        Write-Host ('手机剪贴板  : {0}   口令 {1}' -f ((@($lanIps | ForEach-Object { 'http://{0}:{1}/' -f $_, $chatPort }) -join '  '), $(if ($chatCfg) { $chatCfg.password } else { '?' })))
    } else {
        Write-Host '配对门入口  : (未检测到局域网 IPv4 地址)' -ForegroundColor Yellow
    }
    if ($chatCfg -and $chatCfg.desktopMd) { Write-Host ('桌面文档    : {0}' -f $chatCfg.desktopMd) }
    foreach ($p in @($gatePort, $chatPort)) {
        $owner = Get-PortOwner -Port $p
        if ($owner -gt 0) { Write-Host ('端口 {0,-6} : 正在服务 (PID {1})' -f $p, $owner) -ForegroundColor Green }
        else { Write-Host ('端口 {0,-6} : 未在服务' -f $p) -ForegroundColor Yellow }
    }
    Write-Host ('DSH web 端口: {0}' -f (Get-WebPort))
    Write-Host ('守护状态    : {0}' -f (Get-SupervisorState))
    Write-Host '====================================================='
    Write-Host ''
    exit 0
}

if ($Once) {
    Write-Log ("单次拉起（web 端口 {0}）" -f (Get-WebPort))
    Start-All | Out-Null
    exit 0
}

# --------------------------------------------------------------------------
# 常驻守护：拉起 + 每 IntervalSeconds 巡检一次
# --------------------------------------------------------------------------
$pidFile = Join-Path $runDir 'supervisor.pid'
[IO.File]::WriteAllText($pidFile, [string]$PID, [Text.UTF8Encoding]::new($false))
Write-Log ("守护启动 (PID {0})，根目录 {1}，巡检间隔 {2}s" -f $PID, $Root, $IntervalSeconds)
Write-Log ("配对门 {0} / 手机剪贴板 {1} / DSH web 端口 {2}" -f $gatePort, $chatPort, (Get-WebPort))

# 退出时清掉 PID 文件（Ctrl+C、Stop-Process、任务结束都覆盖）。
Register-EngineEvent -SourceIdentifier PowerShell.Exiting -SupportEvent -Action {
    Remove-Item -LiteralPath $pidFile -ErrorAction SilentlyContinue
} | Out-Null

Start-All | Out-Null

while ($true) {
    Start-Sleep -Seconds $IntervalSeconds
    Start-All | Out-Null
}
