<#
    pair-gate-and-clipboard — 自检脚本（doctor）

    只读检查，不改任何东西。适合搬机后、升级 DSH 后、连不上时先跑一遍：
      * Node.js / 配置文件是否就位
      * 两个端口是否在监听、健康接口是否 200
      * 防火墙规则是否存在
      * DSH Web 是否在跑、loopback 签发接口是否可用（配对门的命脉）
      * DSH Web 鉴权补丁是否已打（"换 IP/重启后仍免配对"的前提）
      * 守护进程与计划任务是否在

    用法
      powershell -NoProfile -ExecutionPolicy Bypass -File doctor.ps1
      powershell -NoProfile -ExecutionPolicy Bypass -File doctor.ps1 -Root D:\apps\pair-gate-and-clipboard
#>
[CmdletBinding()]
param([string]$Root = '')

$ErrorActionPreference = 'Continue'
Set-StrictMode -Off

if (-not $Root) {
    if ($PSScriptRoot -and (Test-Path -LiteralPath (Join-Path (Split-Path -Parent $PSScriptRoot) 'config'))) {
        $Root = Split-Path -Parent $PSScriptRoot
    } else {
        $Root = Join-Path $env:LOCALAPPDATA 'pair-gate-and-clipboard'
    }
}
$resolved = Resolve-Path -LiteralPath $Root -ErrorAction SilentlyContinue
if ($resolved) { $Root = $resolved.Path }

$script:Problems = 0
function Check {
    param([string]$Name, [bool]$Ok, [string]$Detail = '', [switch]$WarnOnly)
    if ($Ok) { Write-Host ('  [OK]   {0,-22} {1}' -f $Name, $Detail) -ForegroundColor Green }
    elseif ($WarnOnly) { Write-Host ('  [WARN] {0,-22} {1}' -f $Name, $Detail) -ForegroundColor Yellow }
    else { Write-Host ('  [FAIL] {0,-22} {1}' -f $Name, $Detail) -ForegroundColor Red; $script:Problems++ }
}

function Read-JsonFile {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) { return $null }
    try { return ([IO.File]::ReadAllText($Path, [Text.UTF8Encoding]::new($false)) | ConvertFrom-Json) } catch { return $null }
}

function Get-StatusFromError {
    # PowerShell 5.1 没有 -SkipHttpErrorCheck：4xx/5xx 会抛 WebException。但 401 恰恰
    # 说明"服务活着且在鉴权"（DSH Web 对无 token 的请求就是 401），必须把状态码从异常
    # 里取出来当成正常响应，否则 5.1 下会误报"连不上"。
    param($ErrorRecord)
    try {
        $resp = $ErrorRecord.Exception.Response
        if ($resp -and $resp.StatusCode) { return [int]$resp.StatusCode }
    } catch {}
    return 0
}

function Test-Url {
    param([string]$Url, [int]$TimeoutSec = 4)
    try {
        if ($PSVersionTable.PSVersion.Major -ge 7) {
            $r = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec $TimeoutSec -SkipHttpErrorCheck
        } else {
            $r = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec $TimeoutSec
        }
        return @{ ok = $true; status = [int]$r.StatusCode }
    } catch {
        $status = Get-StatusFromError -ErrorRecord $_
        if ($status -gt 0) { return @{ ok = $true; status = $status } }
        return @{ ok = $false; status = 0; error = $_.Exception.Message }
    }
}

function Test-PostJson {
    param([string]$Url, [string]$Body, [int]$TimeoutSec = 6)
    try {
        if ($PSVersionTable.PSVersion.Major -ge 7) {
            $r = Invoke-WebRequest -Uri $Url -Method Post -ContentType 'application/json' -Body $Body -UseBasicParsing -TimeoutSec $TimeoutSec -SkipHttpErrorCheck
        } else {
            $r = Invoke-WebRequest -Uri $Url -Method Post -ContentType 'application/json' -Body $Body -UseBasicParsing -TimeoutSec $TimeoutSec
        }
        return @{ ok = $true; status = [int]$r.StatusCode; content = $r.Content }
    } catch {
        $status = Get-StatusFromError -ErrorRecord $_
        return @{ ok = ($status -gt 0); status = $status; content = ''; error = $_.Exception.Message }
    }
}

Write-Host ''
Write-Host '=============== pair-gate-and-clipboard 自检 ===============' -ForegroundColor Cyan
Write-Host ('安装目录 : {0}' -f $Root)

Write-Host ''
Write-Host '1) 运行环境'
$node = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
if (-not $node) {
    foreach ($c in @('C:\Program Files\nodejs\node.exe', 'C:\nodejs\node.exe')) { if (Test-Path -LiteralPath $c) { $node = $c; break } }
}
Check -Name 'Node.js' -Ok ([bool]$node) -Detail $(if ($node) { $node } else { '未找到 node.exe' })
Check -Name 'gate 脚本' -Ok (Test-Path -LiteralPath (Join-Path $Root 'services\pair-gate\gate.mjs')) -Detail (Join-Path $Root 'services\pair-gate\gate.mjs')
Check -Name 'chat 脚本' -Ok (Test-Path -LiteralPath (Join-Path $Root 'services\lan-chat\chat.mjs')) -Detail (Join-Path $Root 'services\lan-chat\chat.mjs')

Write-Host ''
Write-Host '2) 配置'
$gateCfg = Read-JsonFile -Path (Join-Path $Root 'config\pair-gate.config.json')
$chatCfg = Read-JsonFile -Path (Join-Path $Root 'config\chat.config.json')
Check -Name 'pair-gate 配置' -Ok ([bool]$gateCfg) -Detail $(if ($gateCfg) { 'port=' + $gateCfg.port + ' password=' + ('*' * ([string]$gateCfg.password).Length) } else { '缺失' })
$chatPwText = if (-not $chatCfg) { '' } elseif ("$($chatCfg.password)" -eq '') { '未设置(设置模式)' } else { '*' * ([string]$chatCfg.password).Length }
Check -Name 'chat 配置' -Ok ([bool]$chatCfg) -Detail $(if ($chatCfg) { 'port=' + $chatCfg.port + ' md=' + $chatCfg.desktopMd + ' 口令=' + $chatPwText } else { '缺失' })
$gatePort = if ($gateCfg -and $gateCfg.port) { [int]$gateCfg.port } else { 18080 }
$chatPort = if ($chatCfg -and $chatCfg.port) { [int]$chatCfg.port } else { 18082 }
$webPort = if ($gateCfg -and $gateCfg.webPort -and [int]$gateCfg.webPort -gt 0) { [int]$gateCfg.webPort } else { 3080 }

Write-Host ''
Write-Host '3) 服务与端口'
foreach ($svc in @(@{ name = 'pair-gate'; port = $gatePort; path = '/' }, @{ name = 'lan-chat'; port = $chatPort; path = '/healthz' })) {
    $owner = 0
    try { $owner = [int](Get-NetTCPConnection -LocalPort $svc.port -State Listen -ErrorAction Stop | Select-Object -First 1).OwningProcess } catch {}
    Check -Name ($svc.name + ' 监听') -Ok ($owner -gt 0) -Detail $(if ($owner -gt 0) { ('port {0} PID {1}' -f $svc.port, $owner) } else { ('port {0} 无监听' -f $svc.port) })
    if ($owner -gt 0) {
        $r = Test-Url -Url ('http://127.0.0.1:{0}{1}' -f $svc.port, $svc.path)
        Check -Name ($svc.name + ' 响应') -Ok ($r.ok -and $r.status -lt 500) -Detail ('HTTP ' + $r.status)
    }
}

Write-Host ''
Write-Host '4) DSH Web 与签发接口（配对门的命脉）'
$web = Test-Url -Url ('http://127.0.0.1:{0}/' -f $webPort)
Check -Name 'DSH web 端口' -Ok $web.ok -Detail $(if ($web.ok) { 'HTTP ' + $web.status } else { ('连不上 127.0.0.1:{0}' -f $webPort) })
if ($web.ok) {
    # 用本机一个真实网卡 IP 试签发：能签出来，说明插件 lanBind 就绪、白名单认得本机地址。
    $lanIp = $null
    try {
        $lanIp = @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction Stop |
            Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' -and $_.AddressState -eq 'Preferred' } |
            Select-Object -ExpandProperty IPAddress) | Select-Object -First 1
    } catch {}
    try {
        $body = if ($lanIp) { (@{ address = $lanIp } | ConvertTo-Json -Compress) } else { '{}' }
        $r = Test-PostJson -Url ('http://127.0.0.1:{0}/api/pair/issue' -f $webPort) -Body $body
        $code = ''
        try { $code = ($r.content | ConvertFrom-Json).code } catch {}
        Check -Name '签发接口' -Ok ($r.status -eq 200) -Detail $(if ($r.status -eq 200) { 'HTTP 200（' + $lanIp + '）' } else { ('HTTP ' + $r.status + ' ' + $code) })
    } catch {
        Check -Name '签发接口' -Ok $false -Detail $_.Exception.Message
    }
    Check -Name 'dsh-remote-web-ui' -Ok (Test-Path -LiteralPath (Join-Path $env:USERPROFILE '.dsh\profiles\web\node_modules\@linxin666\dsh-remote-web-ui')) -Detail '插件包' -WarnOnly
}

Write-Host ''
Write-Host '5) 鉴权补丁（换 IP / 重启后仍免配对）'
$connPaths = @(
    (Join-Path $env:USERPROFILE '.dsh\profiles\web\node_modules\@deepseek-ai\dsh-client-connection\lib\index.js'),
    (Join-Path $env:APPDATA 'npm\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\dsh-client-connection\lib\index.js')
)
$conn = $connPaths | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if ($conn) {
    $text = [IO.File]::ReadAllText($conn)
    Check -Name '稳定 launch token' -Ok ($text.Contains('dsh-web-stable-launch-token-v1')) -Detail '重启后 token 不变' -WarnOnly
    Check -Name '跨地址 cookie' -Ok ($text.Contains('one fixed cookie name')) -Detail '换 IP 不用重新配对' -WarnOnly
} else {
    Check -Name 'connection 源' -Ok $false -Detail '未找到 dsh-client-connection/lib/index.js' -WarnOnly
}
$wsPaths = @(
    (Join-Path $env:USERPROFILE '.dsh\profiles\web\node_modules\@deepseek-ai\dsh-host-webserver\lib\index.js'),
    (Join-Path $env:APPDATA 'npm\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\dsh-host-webserver\lib\index.js')
)
$ws = $wsPaths | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if ($ws) {
    $wstext = [IO.File]::ReadAllText($ws)
    Check -Name '双栈监听' -Ok ($wstext.Contains('ipv6Only')) -Detail 'IPv6 客户端不再 ERR_EMPTY_RESPONSE' -WarnOnly
} else {
    Check -Name 'webserver 源' -Ok $false -Detail '未找到 dsh-host-webserver/lib/index.js' -WarnOnly
}

Write-Host ''
Write-Host '6) 防火墙 / 守护 / 防火墙规则'
foreach ($p in @($gatePort, $chatPort)) {
    $rule = $null
    try { $rule = Get-NetFirewallRule -DisplayName ('pair-gate-and-clipboard-{0}' -f $p) -ErrorAction Stop } catch {}
    Check -Name ('防火墙 TCP ' + $p) -Ok ([bool]$rule) -Detail $(if ($rule) { 'LocalSubnet / Profile Any' } else { '缺规则：别的机器连不上' }) -WarnOnly
}
$supPidFile = Join-Path $Root 'run\supervisor.pid'
$supRunning = $false
if (Test-Path -LiteralPath $supPidFile) {
    try { $spid = [int]([IO.File]::ReadAllText($supPidFile).Trim()); $supRunning = [bool](Get-Process -Id $spid -ErrorAction Stop) } catch {}
}
Check -Name '守护进程' -Ok $supRunning -Detail $(if ($supRunning) { '运行中' } else { '未运行（服务仍可用，但没有崩溃自愈）' }) -WarnOnly
try {
    $t = Get-ScheduledTask -TaskName 'pair-gate-and-clipboard supervisor' -ErrorAction Stop
    Check -Name '开机自启任务' -Ok ($t.State -ne 'Disabled') -Detail $t.State -WarnOnly
} catch { Check -Name '开机自启任务' -Ok $false -Detail '未注册（重启后需手动起）' -WarnOnly }

Write-Host ''
if ($script:Problems -eq 0) {
    Write-Host '结论：硬性检查全部通过。' -ForegroundColor Green
    Write-Host ('入口：http://<本机任意IP>:{0}/   （口令见 config\pair-gate.config.json）' -f $gatePort)
    exit 0
} else {
    Write-Host ('结论：{0} 项硬性检查未通过，请看上面的 [FAIL]。' -f $script:Problems) -ForegroundColor Red
    exit 1
}
