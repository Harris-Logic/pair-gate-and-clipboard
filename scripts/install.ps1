<#
    pair-gate-and-clipboard — 一键安装脚本（Windows）

    做什么（幂等，可重复运行）
      1. 检查 Node.js（>=18）与本机 DSH 安装位置。
      2. 把 services/ scripts/ 复制到安装目录（默认 %LOCALAPPDATA%\pair-gate-and-clipboard）。
      3. 生成/更新 config\*.json：桌面文档与附件目录按当前用户自动推导，
         端口沿用已有配置（首次 18080/18082）。口令沿用已有配置，首次安装时：
           门(18080) —— 随机生成 8 位并打印出来；
           剪贴板(18082) —— **留空**：服务进入"设置模式"，第一次访问时在页面上自己设。
      4. 打 DSH Web 鉴权补丁（scripts\dsh-web-auth-patch.ps1）——
         没有它，"换 IP / 重启后仍然免配对"不成立，详见 README。
      5. 加防火墙规则（TCP，LocalSubnet，Profile Any）。
      6. 注册开机自启（计划任务，SYSTEM/最高权限）与"DSH 升级后自动补打补丁"任务。
      7. 立即拉起守护，并跑一遍自检（doctor.ps1）。

    用法
      powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1
      ... -Root D:\apps\pair-gate-and-clipboard        # 换安装目录
      ... -GatePort 18080 -ChatPort 18082             # 换端口
      ... -SkipFirewall -SkipAutostart                # 只装文件
      ... -Uninstall                                  # 卸载（停服务、删任务、可选删文件）
#>
[CmdletBinding()]
param(
    [string]$Root = (Join-Path $env:LOCALAPPDATA 'pair-gate-and-clipboard'),
    [int]$GatePort = 0,
    [int]$ChatPort = 0,
    [string]$Password = '',
    [switch]$SkipFirewall,
    [switch]$SkipAutostart,
    [switch]$SkipAuthPatch,
    [switch]$Uninstall,
    [switch]$Force,
    # 源码树所在目录（含 services\ scripts\ config\）。留空则自动探测。
    [string]$Source = ''
)

$ErrorActionPreference = 'Continue'
Set-StrictMode -Off

# --------------------------------------------------------------------------
# 定位源码树。
# 不要只信 $PSScriptRoot：脚本常被从"下载目录"或解压出的临时目录里运行，
# 那时 $PSScriptRoot 指向别处，复制会静默变成"0 个文件"。
# 依次尝试：显式 -Source → $PSScriptRoot → 其父目录 → 其祖父目录；
# 以"services\pair-gate\gate.mjs 存在"作为判定标准。
# --------------------------------------------------------------------------
function Resolve-SourceRoot {
    param([string]$Hint)
    $candidates = @()
    if ($Hint -ne '') { $candidates += $Hint }
    $candidates += $PSScriptRoot
    if ($PSScriptRoot) { $candidates += (Split-Path -Parent $PSScriptRoot) }
    if ($PSScriptRoot) {
        $up = Split-Path -Parent $PSScriptRoot
        if ($up) { $candidates += (Split-Path -Parent $up) }
    }
    foreach ($c in $candidates) {
        if (-not $c) { continue }
        if (Test-Path -LiteralPath (Join-Path $c 'services\pair-gate\gate.mjs')) { return (Resolve-Path -LiteralPath $c).Path }
    }
    return $null
}

$SourceRoot = Resolve-SourceRoot -Hint $Source
$TaskNameSupervisor = 'pair-gate-and-clipboard supervisor'
$TaskNameAuthPatch = 'pair-gate-and-clipboard auth-patch'

function Say {
    param([string]$Message, [string]$Level = 'info')
    $color = switch ($Level) { 'ok' { 'Green' } 'warn' { 'Yellow' } 'err' { 'Red' } default { 'Gray' } }
    Write-Host $Message -ForegroundColor $color
}

function Test-Admin {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    return ([Security.Principal.WindowsPrincipal]$id).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Resolve-Node {
    $cmd = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    foreach ($c in @('C:\Program Files\nodejs\node.exe', 'C:\nodejs\node.exe', (Join-Path $env:LOCALAPPDATA 'Programs\nodejs\node.exe'))) {
        if (Test-Path -LiteralPath $c) { return $c }
    }
    return $null
}

function Read-JsonFile {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) { return $null }
    try { return ([IO.File]::ReadAllText($Path, [Text.UTF8Encoding]::new($false)) | ConvertFrom-Json) } catch { return $null }
}

# 真实可用的 PowerShell 宿主：裸 `pwsh` 在部分机器上会被 WindowsApps 的 MSIX
# 别名劫持，在计划任务/无人交互下启动失败（"access denied"）。
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
    return 'powershell.exe'
}

function Write-JsonFile {
    param([string]$Path, $Object)
    $json = $Object | ConvertTo-Json -Depth 8
    [IO.File]::WriteAllText($Path, $json, [Text.UTF8Encoding]::new($false))
}

# 源码树没找到就不能继续（只有卸载分支不需要源码）。
if (-not $Uninstall -and -not $SourceRoot) {
    Say '找不到源码树（需要含 services\pair-gate\gate.mjs 的目录）。' 'err'
    Say '请在仓库根目录运行 install.ps1，或用 -Source <仓库路径> 指定。'
    exit 2
}

# ==========================================================================
# 0. 卸载
# ==========================================================================
if ($Uninstall) {
    Say '== 卸载 pair-gate-and-clipboard ==' 'warn'
    $supervisor = Join-Path $Root 'scripts\supervisor.ps1'
    if (Test-Path -LiteralPath $supervisor) {
        & powershell -NoProfile -ExecutionPolicy Bypass -File $supervisor -Root $Root -Stop
    }
    foreach ($t in @($TaskNameSupervisor, $TaskNameAuthPatch)) {
        try { Unregister-ScheduledTask -TaskName $t -Confirm:$false -ErrorAction Stop; Say ("已删除计划任务：{0}" -f $t) 'ok' } catch { Say ("计划任务不存在或删除失败：{0}" -f $t) }
    }
    $cfg = Read-JsonFile -Path (Join-Path $Root 'config\pair-gate.config.json')
    $chat = Read-JsonFile -Path (Join-Path $Root 'config\chat.config.json')
    foreach ($p in @($(if ($cfg) { [int]$cfg.port } else { 18080 }), $(if ($chat) { [int]$chat.port } else { 18082 }))) {
        try { Remove-NetFirewallRule -DisplayName ("pair-gate-and-clipboard-{0}" -f $p) -ErrorAction Stop; Say ("已删除防火墙规则：{0}" -f $p) 'ok' } catch {}
    }
    if ($Force) { Remove-Item -LiteralPath $Root -Recurse -Force; Say ("已删除安装目录 {0}" -f $Root) 'ok' }
    else { Say ("安装目录保留在 {0}（加 -Force 一并删除）" -f $Root) }
    exit 0
}

# ==========================================================================
# 1. 前置检查
# ==========================================================================
Say '== pair-gate-and-clipboard 安装 ==' 
$node = Resolve-Node
if (-not $node) { Say '找不到 node.exe。请先安装 Node.js（>=18）后重试。' 'err'; exit 2 }
Say ("Node.js     : {0}" -f $node) 'ok'

$dshBin = Join-Path $env:APPDATA 'npm\node_modules\@deepseek-ai\dsh\lib\bin.js'
if (Test-Path -LiteralPath $dshBin) { Say ("DSH         : {0}" -f $dshBin) 'ok' }
else { Say 'DSH         : 未在默认位置找到（配对门仍可运行，但"输入口令免配对"需要本机 DSH Web + dsh-remote-web-ui 插件）' 'warn' }

# ==========================================================================
# 2. 复制文件
# ==========================================================================
New-Item -ItemType Directory -Force -Path $Root | Out-Null
foreach ($d in @('services', 'scripts', 'config', 'state', 'logs', 'run')) {
    New-Item -ItemType Directory -Force -Path (Join-Path $Root $d) | Out-Null
}
foreach ($item in @('services', 'scripts', 'README.md', 'README.zh.md', 'LICENSE')) {
    $src = Join-Path $SourceRoot $item
    if (-not (Test-Path -LiteralPath $src)) { continue }
    $dst = Join-Path $Root $item
    if ((Get-Item -LiteralPath $src).PSIsContainer) {
        # 注意：Windows PowerShell 5.1 下 `Copy-Item -LiteralPath "$src\*" -Destination $dst -Recurse`
        # 会**静默不复制**（只建出空目录，$Error 里也没有记录）。必须用管道写法：
        # Get-ChildItem -LiteralPath $src | Copy-Item -Destination $dst -Recurse。
        # 只覆盖服务代码，保留用户改过的配置（配置在 config\ 下，不在这里）。
        Get-ChildItem -LiteralPath $src -Force | Copy-Item -Destination $dst -Recurse -Force
    } else {
        Copy-Item -LiteralPath $src -Destination $dst -Force
    }
}
$copied = @(Get-ChildItem -LiteralPath (Join-Path $Root 'scripts') -File -ErrorAction SilentlyContinue).Count + @(Get-ChildItem -LiteralPath (Join-Path $Root 'services') -Recurse -File -ErrorAction SilentlyContinue).Count
if ($copied -lt 5) { Say ("复制文件不完整（只找到 {0} 个文件），请检查权限后重试。" -f $copied) 'err'; exit 4 }
Say ("已复制 {0} 个文件到 {1}" -f $copied, $Root) 'ok'

# ==========================================================================
# 3. 生成/更新配置
# ==========================================================================

# 首次安装用的口令：随机生成，不再写死默认值。
# 为什么不写死：这个服务能在局域网里往桌面写文件，一个"人人皆知"的默认口令
# 等于没有口令。8 位、去掉容易看错的 0/O/1/l/I；用密码学随机源 + 拒绝采样
# （取模会把字符分布带偏，这里只接受落在完整区间内的字节）。
function New-RandomPassword {
    param([int]$Length = 8)
    $alphabet = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'
    $limit = [math]::Floor(256 / $alphabet.Length) * $alphabet.Length
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    $buf = New-Object byte[] 1
    $chars = New-Object System.Collections.Generic.List[char]
    while ($chars.Count -lt $Length) {
        $rng.GetBytes($buf)
        if ($buf[0] -lt $limit) { $chars.Add($alphabet[$buf[0] % $alphabet.Length]) }
    }
    $rng.Dispose()
    return (-join $chars)
}

# 读配置时保留"显式写下的 0"。
# 注意：0 在 PowerShell 里是 falsy，用真值判断会把用户特意设的 0（= 不限）
# 当成"没配"而重置回默认值 —— 那正好把"去掉大小限制"这件事抹掉了。
function Get-IntOr {
    param($Value, [int]$Default)
    if ($null -eq $Value -or "$Value" -eq '') { return $Default }
    return [int]$Value
}

$gateConfigPath = Join-Path $Root 'config\pair-gate.config.json'
$chatConfigPath = Join-Path $Root 'config\chat.config.json'
$oldGate = Read-JsonFile -Path $gateConfigPath
$oldChat = Read-JsonFile -Path $chatConfigPath

$gatePort = if ($GatePort -gt 0) { $GatePort } elseif ($oldGate -and $oldGate.port) { [int]$oldGate.port } else { 18080 }
$chatPort = if ($ChatPort -gt 0) { $ChatPort } elseif ($oldChat -and $oldChat.port) { [int]$oldChat.port } else { 18082 }
# 两个服务的口令策略不同：
#   门(18080) 没有"首次访问自己设口令"的流程 → 首次装随机生成一个；
#   剪贴板(18082) 支持首次访问时在页面上自己设 → 首次装**留空**，服务会进入设置模式。
# 显式传 -Password 时两者都用它。
$gatePw = if ($Password -ne '') { $Password } elseif ($oldGate -and $oldGate.password) { [string]$oldGate.password } else { New-RandomPassword }
$chatPw = if ($Password -ne '') { $Password } elseif ($null -ne $oldChat.password) { [string]$oldChat.password } else { '' }

$desktop = [Environment]::GetFolderPath('Desktop')
if (-not $desktop) { $desktop = Join-Path $env:USERPROFILE 'Desktop' }
$mdName = '手机剪贴板.md'
$assetsName = '手机剪贴板.assets'

$gateConfig = [ordered]@{
    port     = $gatePort
    webPort  = if ($oldGate -and $oldGate.webPort) { [int]$oldGate.webPort } else { 0 }  # 0 = 自动探测 DSH web 端口
    address  = ''      # 空 = 按客户端请求的 Host 当场签发（任意本机 IP 都能用）
    password = $gatePw
    _comment = 'port=门监听端口；webPort=DSH web 端口(0=自动探测)；address 留空=按访问方用的本机 IP 签发；改完重启服务。'
}
Write-JsonFile -Path $gateConfigPath -Object $gateConfig

$chatConfig = [ordered]@{
    port            = $chatPort
    password        = $chatPw
    # 0 = 不限。单文件/单次传输走流式落盘，所以新装默认就不限。
    maxFileMB       = Get-IntOr $oldChat.maxFileMB 0
    maxRequestMB    = Get-IntOr $oldChat.maxRequestMB 0
    maxZipEntries   = Get-IntOr $oldChat.maxZipEntries 0
    maxZipTotalMB   = Get-IntOr $oldChat.maxZipTotalMB 0
    mdOrder         = if ($oldChat -and $oldChat.mdOrder) { [string]$oldChat.mdOrder } else { 'newest-first' }
    desktopMd       = Join-Path $desktop $mdName
    assetsDir       = Join-Path $desktop $assetsName
    dataDir         = Join-Path $Root 'state\lan-chat'
    _comment        = 'password=进入口令；desktopMd/assetsDir=落盘位置；改完重启服务。'
}
Write-JsonFile -Path $chatConfigPath -Object $chatConfig

Say ("配置已写入：门 {0}（口令 {1}）/ 剪贴板 {2}" -f $gatePort, $gatePw, $chatPort) 'ok'
if ($chatPw -eq '') {
    Say ("剪贴板还没设口令：在那台机器上打开 http://127.0.0.1:{0}/ 现场设一个（从局域网设需要日志里的设置码）" -f $chatPort) 'ok'
} else {
    Say ("剪贴板口令：{0}" -f $chatPw) 'ok'
}
Say ("桌面落盘：{0}" -f (Join-Path $desktop $mdName)) 'ok'

# ==========================================================================
# 4. DSH Web 鉴权补丁（"换 IP/重启后仍然免配对"的前提）
# ==========================================================================
if (-not $SkipAuthPatch) {
    $patch = Join-Path $Root 'scripts\dsh-web-auth-patch.ps1'
    if (Test-Path -LiteralPath $patch) {
        Say '-- 打 DSH Web 鉴权补丁 --'
        try {
            $out = & powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $patch -Quiet 2>&1
            $last = ($out | Select-Object -Last 1) -join ' '
            Say ("补丁结果：{0}" -f $last) $(if ($LASTEXITCODE -eq 0) { 'ok' } else { 'warn' })
            if ($LASTEXITCODE -ne 0) { Say '补丁未完全成功（上游源码可能变了）。不影响两个服务本身，只是"换 IP 免配对"可能失效。' 'warn' }
        } catch {
            Say ("补丁失败（继续）：{0}" -f $_.Exception.Message) 'warn'
        }
    } else { Say ("找不到补丁脚本 {0}" -f $patch) 'warn' }
} else { Say '已按参数跳过 DSH Web 鉴权补丁' }

# ==========================================================================
# 5. 防火墙规则
# ==========================================================================
if (-not $SkipFirewall) {
    $needElevation = -not (Test-Admin)
    $ruleScript = @"
foreach (`$p in @($gatePort, $chatPort)) {
    `$name = "pair-gate-and-clipboard-`$p"
    try { Remove-NetFirewallRule -DisplayName `$name -ErrorAction SilentlyContinue } catch {}
    New-NetFirewallRule -DisplayName `$name -Direction Inbound -Action Allow -Protocol TCP ``
        -LocalPort `$p -RemoteAddress LocalSubnet -Profile Any | Out-Null
}
"@
    if ($needElevation) {
        Say '-- 添加防火墙规则（需要管理员，会弹一次 UAC）--' 'warn'
        $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($ruleScript))
        try {
            Start-Process -FilePath 'powershell' -Verb RunAs -Wait -WindowStyle Hidden `
                -ArgumentList @('-NoProfile', '-NonInteractive', '-EncodedCommand', $encoded)
            Say ("防火墙规则已添加：TCP {0}, {1}（LocalSubnet）" -f $gatePort, $chatPort) 'ok'
        } catch {
            Say ("防火墙规则未添加（{0}）。请以管理员重跑，或手动执行 README 里的命令。" -f $_.Exception.Message) 'warn'
        }
    } else {
        try {
            Invoke-Expression $ruleScript
            Say ("防火墙规则已添加：TCP {0}, {1}（LocalSubnet）" -f $gatePort, $chatPort) 'ok'
        } catch { Say ("防火墙规则添加失败：{0}" -f $_.Exception.Message) 'warn' }
    }
} else { Say '已按参数跳过防火墙规则（别的机器将连不上）' 'warn' }

# ==========================================================================
# 6. 开机自启（计划任务）
# ==========================================================================
$supervisor = Join-Path $Root 'scripts\supervisor.ps1'
$psHost = Resolve-PsHost
if (-not $SkipAutostart) {
    if (-not (Test-Admin)) {
        Say '-- 注册开机自启需要管理员，会弹一次 UAC --' 'warn'
        $taskScript = @"
`$a = New-ScheduledTaskAction -Execute '$psHost' -Argument '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "$supervisor"'
`$t = New-ScheduledTaskTrigger -AtStartup
`$s = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)
Register-ScheduledTask -TaskName '$TaskNameSupervisor' -Action `$a -Trigger `$t -Settings `$s -RunLevel Highest -Force | Out-Null
`$a2 = New-ScheduledTaskAction -Execute '$psHost' -Argument '-NoProfile -ExecutionPolicy Bypass -File "$(Join-Path $Root 'scripts\dsh-web-auth-patch.ps1')" -Quiet'
`$t2 = New-ScheduledTaskTrigger -Daily -At 12:00
Register-ScheduledTask -TaskName '$TaskNameAuthPatch' -Action `$a2 -Trigger `$t2 -RunLevel Highest -Force | Out-Null
"@
        $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($taskScript))
        try {
            Start-Process -FilePath 'powershell' -Verb RunAs -Wait -WindowStyle Hidden `
                -ArgumentList @('-NoProfile', '-NonInteractive', '-EncodedCommand', $encoded)
            Say '计划任务已注册（开机自启 + 每日补打鉴权补丁）' 'ok'
        } catch { Say ("计划任务注册失败：{0}" -f $_.Exception.Message) 'warn' }
    } else {
        try {
            $a = New-ScheduledTaskAction -Execute $psHost -Argument ('-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "{0}"' -f $supervisor)
            $t = New-ScheduledTaskTrigger -AtStartup
            $s = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
                -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)
            Register-ScheduledTask -TaskName $TaskNameSupervisor -Action $a -Trigger $t -Settings $s -RunLevel Highest -Force | Out-Null
            $a2 = New-ScheduledTaskAction -Execute $psHost -Argument ('-NoProfile -ExecutionPolicy Bypass -File "{0}" -Quiet' -f (Join-Path $Root 'scripts\dsh-web-auth-patch.ps1'))
            $t2 = New-ScheduledTaskTrigger -Daily -At 12:00
            Register-ScheduledTask -TaskName $TaskNameAuthPatch -Action $a2 -Trigger $t2 -RunLevel Highest -Force | Out-Null
            Say '计划任务已注册（开机自启 + 每日补打鉴权补丁）' 'ok'
        } catch { Say ("计划任务注册失败：{0}" -f $_.Exception.Message) 'warn' }
    }
} else { Say '已按参数跳过开机自启（需手动运行 supervisor.ps1）' 'warn' }

# ==========================================================================
# 7. 立即拉起 + 自检
# ==========================================================================
Say '-- 启动服务 --'
$supervisorPath = Join-Path $Root 'scripts\supervisor.ps1'
if (-not (Test-Admin)) {
    # 通过提权进程直接跑 supervisor -Once（而不是再套一层 Start-Process），
    # 这样服务启动失败会以非零退出码返回，而不是被静默吞掉。
    $startScript = @"
& '$psHost' -NoProfile -ExecutionPolicy Bypass -File '$supervisorPath' -Root '$Root' -Once -StartupDelaySeconds 2
"@
    $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($startScript))
    try {
        Start-Process -FilePath 'powershell' -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList @('-NoProfile', '-NonInteractive', '-EncodedCommand', $encoded) -ErrorAction Stop
        Say '服务已通过提权进程拉起（常驻守护由开机任务负责）' 'ok'
    } catch {
        Say ("提权启动失败或被你取消：{0}" -f $_.Exception.Message) 'warn'
        Say ('请手动运行：powershell -File "{0}" -Once' -f $supervisorPath)
    }
} else {
    & powershell -NoProfile -ExecutionPolicy Bypass -File $supervisorPath -Root $Root -Once -StartupDelaySeconds 2
}
Start-Sleep -Seconds 3

Say '-- 自检 --'
$doctor = Join-Path $Root 'scripts\doctor.ps1'
if (Test-Path -LiteralPath $doctor) { & powershell -NoProfile -ExecutionPolicy Bypass -File $doctor -Root $Root }

Say ''
Say '安装完成。' 'ok'
Say ('安装目录 : {0}' -f $Root)
Say ('现场信息 : powershell -File "{0}" -Info' -f (Join-Path $Root 'scripts\supervisor.ps1'))
Say ('自检     : powershell -File "{0}"' -f (Join-Path $Root 'scripts\doctor.ps1'))
