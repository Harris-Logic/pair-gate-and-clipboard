<#
    dsh-web-auth-patch.ps1 — 让 DSH Web 在「换 IP / 重启 DSH」后仍然免配对

    为什么需要它（三条硬事实，都是上游行为）
      1. 上游每个进程用 randomBytes 生成 ?token=，DSH 一重启，所有带 token 的地址
         全部失效 —— 于是每台客户端都得重新配对。
      2. 上游的浏览器鉴权 cookie 名字里带 Host 授权串（dsh-auth-<sha256(host:port)>），
         所以给 192.168.1.5 发的 cookie 在 10.0.0.7 上不认；DHCP 换 IP 等于把所有
         已配对客户端全部踢掉。
      3. 上游把 LAN 监听绑在 0.0.0.0（纯 IPv4）。`.local` 名字解析出 AAAA 记录的
         客户端会连到一个不存在的 IPv6 套接字，浏览器显示 ERR_EMPTY_RESPONSE。

    本脚本做六处**精确字符串**替换（幂等，找不到就跳过并报警，不会改坏文件）：
      * dsh-client-connection: 稳定 launch token / 固定 cookie 名 / 构造器传参 /
        跨地址 cookie 校验 / cookie 有效期 365 天
      * dsh-host-webserver   : 全接口绑定时双栈（IPv6 + IPv4）
    每次改动前备份为 <文件>.dsh-auth-patch.bak，改完用 node --check 校验，失败自动还原。

    用法
      powershell -File dsh-web-auth-patch.ps1              # 打补丁 + 校验
      powershell -File dsh-web-auth-patch.ps1 -Quiet       # 不写日志文件
      powershell -File dsh-web-auth-patch.ps1 -Revert      # 还原上游行为
      powershell -File dsh-web-auth-patch.ps1 -RestartServer  # 补丁后顺手拉起未运行的 dsh web

    退出码：0 成功/无需改动，3 有失败（通常是 DSH 升级后上游源码变了，需要人工看）。
    注意：每次 `npm i -g @deepseek-ai/dsh` 都会覆盖这两个文件，所以升级后要重打一遍
    （install.ps1 会注册一个每日计划任务自动补打）。
#>
[CmdletBinding()]
param(
    [string]$DshHome = '',
    [switch]$Revert,
    [switch]$Quiet,
    [switch]$RestartServer
)

$ErrorActionPreference = 'Continue'
Set-StrictMode -Off

if (-not $DshHome) {
    if ($env:DSH_HOME) { $DshHome = $env:DSH_HOME } else { $DshHome = Join-Path $env:USERPROFILE '.dsh' }
}
$logFile = Join-Path $DshHome 'dsh-web-auth-patch.log'

function Write-Note {
    param([string]$Message, [int]$Level = 0)
    $line = '[{0}] {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message
    if ($Level -gt 0) {
        Write-Host $line -ForegroundColor $(switch ($Level) { 1 { 'Yellow' } 2 { 'Red' } default { 'Gray' } })
    } else { Write-Host $line }
    if (-not $Quiet) {
        try { Add-Content -LiteralPath $logFile -Value $line -Encoding UTF8 -ErrorAction Stop } catch {}
    }
}

# --------------------------------------------------------------------------
# 定位两个目标文件（profile 本地安装优先，其次全局 npm 安装）
# 注意：路径里的 '@deepseek-ai' 不要写进单引号串 —— PowerShell 会把 @ 当 splat
# 操作符（'...\@deepseek-ai\...' 实际变成 '...\pdsh-...'），于是永远找不到文件。
# 用变量拼（或双引号串），别用单引号内联。
# --------------------------------------------------------------------------
$DshScope = '@deepseek-ai'
function Resolve-Target {
    param([string]$Relative)
    $candidates = @(
        (Join-Path $DshHome (Join-Path ('profiles\web\node_modules\' + $DshScope) $Relative)),
        (Join-Path $env:APPDATA ('npm\node_modules\' + $DshScope + '\dsh\node_modules\' + $DshScope + '\' + $Relative))
    )
    foreach ($c in $candidates) { if ($c -and (Test-Path -LiteralPath $c)) { return $c } }
    return $null
}

# --------------------------------------------------------------------------
# 精确替换片段：上游 -> 补丁
# --------------------------------------------------------------------------
$TOKEN_UPSTREAM = @'
function processLaunchToken(owner) {
	const existing = PROCESS_LAUNCH_TOKENS.get(owner);
	if (existing !== void 0) return existing;
	const created = encodeBase64Url(randomBytes(SECRET_BYTES));
	PROCESS_LAUNCH_TOKENS.set(owner, created);
	return created;
}
'@
$TOKEN_PATCHED = @'
function processLaunchToken(owner, secret) {
	const existing = PROCESS_LAUNCH_TOKENS.get(owner);
	if (existing !== void 0) return existing;
	/* dsh-web-auth-patch: derive a stable launch token from the persisted browser-session
	   secret instead of randomBytes, so one tokenised URL keeps working across restarts. */
	const created = secret === void 0
		? encodeBase64Url(randomBytes(SECRET_BYTES))
		: encodeBase64Url(createHmac("sha256", secret).update("dsh-web-stable-launch-token-v1").digest()).slice(0, 43);
	PROCESS_LAUNCH_TOKENS.set(owner, created);
	return created;
}
'@

$COOKIE_UPSTREAM = @'
function cookieName(authority) {
	return COOKIE_PREFIX + encodeBase64Url(createHash("sha256").update(authority).digest());
}
'@
$COOKIE_PATCHED = @'
function cookieName(authority) {
	/* dsh-web-auth-patch: one fixed cookie name so a cookie minted on any address
	   (loopback, LAN IP, host name) authenticates every address reaching this server. */
	void authority;
	return COOKIE_PREFIX + "session";
}
'@

$CTOR_UPSTREAM = '		this.launchToken = processLaunchToken(processOwner);'
$CTOR_PATCHED = '		this.launchToken = processLaunchToken(processOwner, secret);'

$VERIFY_UPSTREAM = '		if (payload === void 0 || payload.authority !== authority) return false;'
$VERIFY_PATCHED = @'
		/* dsh-web-auth-patch: authority comparison dropped; the HMAC signature and the
		   absolute lifetime remain the gate. */
		if (payload === void 0) return false;
'@

$LIFETIME_UPSTREAM = '	cookieMaxAgeDays: z.natural().min(1).default(30),'
$LIFETIME_PATCHED = @'
	/* dsh-web-auth-patch: one year instead of the 30-day default. */
	cookieMaxAgeDays: z.natural().min(1).default(365),
'@

$LISTEN_UPSTREAM = '			this.server.listen(this.config.port, this.config.host, () => {'
$LISTEN_PATCHED = @'
			/* dsh-web-auth-patch: an all-interfaces bind must also answer IPv6, or a
			   client that resolved an AAAA record (typical for `<name>.local`) connects
			   to nothing and the browser reports ERR_EMPTY_RESPONSE. */
			const listenOptions = this.config.host === "0.0.0.0" ? {
				port: this.config.port,
				host: "::",
				ipv6Only: false
			} : this.config.port;
			this.server.listen(listenOptions, this.config.host === "0.0.0.0" ? void 0 : this.config.host, () => {
'@

function ConvertTo-Lf { param([string]$Text) return ($Text -replace "`r`n", "`n") }
function Get-FileText { param([string]$Path) return [IO.File]::ReadAllText($Path) }
function Set-FileText { param([string]$Path, [string]$Text) [IO.File]::WriteAllText($Path, $Text, [Text.UTF8Encoding]::new($false)) }

$node = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
if (-not $node) { foreach ($c in @('C:\Program Files\nodejs\node.exe', 'C:\nodejs\node.exe')) { if (Test-Path -LiteralPath $c) { $node = $c; break } } }

$script:text = ''
$script:changes = @()
$script:alreadyApplied = 0
$script:skipped = 0
$script:failures = 0

function Invoke-Edit {
    param([string]$Label, [string]$From, [string]$To)
    $fromN = ConvertTo-Lf -Text $From
    $toN = ConvertTo-Lf -Text $To
    if ($script:text.Contains($toN) -and -not $script:text.Contains($fromN)) {
        $script:alreadyApplied++
        Write-Note ("  = {0}: already patched" -f $Label)
        return
    }
    if (-not $script:text.Contains($fromN)) {
        Write-Note ("  ! {0}: pattern not found (upstream changed?) - skipped" -f $Label) 1
        $script:skipped++
        return
    }
    $script:text = $script:text.Replace($fromN, $toN)
    $script:changes += $Label
    Write-Note ("  + {0}" -f $Label)
}

function Invoke-Target {
    param([string]$Path, [string]$Label, [array]$Edits)
    if (-not $Path -or -not (Test-Path -LiteralPath $Path)) {
        Write-Note ("target : {0} NOT FOUND - skipped ({1})" -f $Path, $Label) 2
        $script:failures++
        return
    }
    Write-Note ("target : {0} ({1})" -f $Path, $Label)
    $original = Get-FileText -Path $Path
    $script:text = ConvertTo-Lf -Text $original
    $before = $script:changes.Count
    foreach ($edit in $Edits) { Invoke-Edit -Label $edit.Label -From $edit.From -To $edit.To }
    if ($script:changes.Count -eq $before) { return }

    $backup = "$Path.dsh-auth-patch.bak"
    try {
        if (-not (Test-Path -LiteralPath $backup)) { Set-FileText -Path $backup -Text $original }
        Set-FileText -Path $Path -Text $script:text
    } catch {
        Write-Note ("FATAL: could not write {0}: {1}" -f $Path, $_.Exception.Message) 2
        $script:failures++
        return
    }
    if (Test-Path -LiteralPath $node) {
        $check = & $node --check $Path 2>&1
        if ($LASTEXITCODE -ne 0) {
            Write-Note ("FATAL: patched file fails `node --check`: {0}" -f ($check -join ' ')) 2
            Write-Note 'restoring backup ...' 1
            Set-FileText -Path $Path -Text $original
            $script:failures++
            return
        }
        Write-Note '  verify : node --check OK'
    }
}

$connectionEdits = @(
    @{ Label = 'stable launch token';               From = $TOKEN_UPSTREAM;    To = $TOKEN_PATCHED }
    @{ Label = 'authority-independent cookie name'; From = $COOKIE_UPSTREAM;   To = $COOKIE_PATCHED }
    @{ Label = 'constructor wiring';                From = $CTOR_UPSTREAM;     To = $CTOR_PATCHED }
    @{ Label = 'authority-independent cookie check'; From = $VERIFY_UPSTREAM;  To = $VERIFY_PATCHED }
    @{ Label = 'cookie lifetime default (365d)';    From = $LIFETIME_UPSTREAM; To = $LIFETIME_PATCHED }
)
$connectionRevert = @(
    @{ Label = 'stable launch token';               From = $TOKEN_PATCHED;     To = $TOKEN_UPSTREAM }
    @{ Label = 'authority-independent cookie name'; From = $COOKIE_PATCHED;    To = $COOKIE_UPSTREAM }
    @{ Label = 'constructor wiring';                From = $CTOR_PATCHED;      To = $CTOR_UPSTREAM }
    @{ Label = 'authority-independent cookie check'; From = $VERIFY_PATCHED;   To = $VERIFY_UPSTREAM }
    @{ Label = 'cookie lifetime default (365d)';    From = $LIFETIME_PATCHED;  To = $LIFETIME_UPSTREAM }
)
$webserverEdits = @(
    @{ Label = 'dual-stack listen (IPv4 + IPv6)';   From = $LISTEN_UPSTREAM;   To = $LISTEN_PATCHED }
)
$webserverRevert = @(
    @{ Label = 'dual-stack listen (IPv4 + IPv6)';   From = $LISTEN_PATCHED;    To = $LISTEN_UPSTREAM }
)

$connectionSource = Resolve-Target -Relative 'dsh-client-connection\lib\index.js'
$webserverSource = Resolve-Target -Relative 'dsh-host-webserver\lib\index.js'

if ($connectionSource) {
    Invoke-Target -Path $connectionSource -Label 'client-connection: browser auth' -Edits $(if ($Revert) { $connectionRevert } else { $connectionEdits })
} else {
    Write-Note 'FATAL: dsh-client-connection/lib/index.js not found; nothing patched.' 2
    $failures++
}
Invoke-Target -Path $webserverSource -Label 'host-webserver: listen socket' -Edits $(if ($Revert) { $webserverRevert } else { $webserverEdits })

if ($failures -gt 0) {
    Write-Note ("result : {0} failure(s); see the log above." -f $failures) 2
    exit 3
}
if ($changes.Count -eq 0) {
    if ($alreadyApplied -gt 0 -and $skipped -eq 0) { Write-Note 'result : already patched, nothing to do.'; exit 0 }
    if ($skipped -gt 0) { Write-Note ("result : {0} pattern(s) missing - this dsh build needs a manual look." -f $skipped) 2; exit 3 }
    Write-Note 'result : no change (files already in the requested state).'
    exit 0
}

# 可选：补丁后把没在跑的 web 交回给系统（这里只做提示，不擅自拉起别的服务）
if ($RestartServer -and -not $Revert) {
    $listening = $null
    try { $listening = Get-NetTCPConnection -LocalPort 3080 -State Listen -ErrorAction Stop } catch {}
    if ($listening) { Write-Note ("restart : port 3080 already served (PID {0}) - restart dsh yourself to apply." -f $listening[0].OwningProcess) }
    else { Write-Note 'restart : start `dsh web` yourself to apply the patch.' 1 }
}

Write-Note ("result : applied {0} edit(s): {1}" -f $script:changes.Count, ($script:changes -join ', '))
exit 0
