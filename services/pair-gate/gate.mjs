/**
 * pair-gate — 局域网"配对门"（密码授权版）。
 *
 * 解决什么问题
 *   DSH Web 的配对链接（/pair-accept?pair=<32位hex>）默认只活 10 分钟，且插件
 *   同一时刻**只保留一个有效 token**：`PairingService.issue()` 一经调用就作废
 *   上一个链接。因此"定时把链接重写进一个 txt"是反模式 —— 既会互相作废，文件
 *   里的链接也多半已过期。
 *
 * 正确做法（本文件）
 *   别传链接，传**取链接的地址**：外部机器访问本服务并输入密码，本服务当场签发
 *   一个新鲜链接并 302 跳转过去。于是链接永远新鲜、不会误作废别人手上的链接，
 *   对端只需记住一个收藏地址 + 一个密码。
 *
 * 授权模型（owner 选择：输入密码）
 *   * 浏览器：首次访问 GET / 返回一个只有"密码"一个输入框的表单；POST /unlock
 *     校验通过后下发 HttpOnly 会话 cookie，随后 GET / 直接 302 到新鲜配对链接。
 *   * 脚本：也可用 HTTP Basic（用户名随意，密码同款），便于 Invoke-RestMethod。
 *   * 口令来自 gate.config.json 的 password 字段（或用 PAIR_GATE_PASSWORD 覆盖）。
 *   * 失败按来源 IP 限速：15 分钟窗口内 5 次失败则封禁 15 分钟 —— 4 位数字口令
 *     必须挡暴力枚举。日志只记失败事件与 IP，**绝不记密码**。
 *   * 会话 cookie 的密钥是进程内随机数，重启即失效（等同重输一次密码）。
 *
 * 签发安全
 *   签发走 `POST http://127.0.0.1:<webPort>/api/pair/issue` —— 该接口受插件
 *   loopbackFence 保护，**只有本机回环能调**，外部直接调是 403。本服务因此是
 *   本机唯一对外的"签发代理"，配对 token 不会落到外部可读的位置。
 *
 * 配置（gate.config.json）
 *   { "port": 18080, "webPort": 3080, "address": "", "password": "…" }
 *   环境变量覆盖：PAIR_GATE_CONFIG（配置文件路径）/ PAIR_GATE_DATA_DIR（状态落盘
 *   目录）/ PAIR_GATE_PORT / PAIR_GATE_WEB_PORT / PAIR_GATE_ADDRESS /
 *   PAIR_GATE_PASSWORD。
 *
 * "任意本机 IP"（address 留空时的默认行为）
 *   过去 address 写死一个局域网 IP：换网络/换机器后门会签出客户端根本连不上的
 *   链接（实测过：客户端从另一张网卡进来，门却给 192.168.5.55 签发）。现在默认
 *   **按请求的 Host 头当场签发**：客户端用哪个本机 IP 访问门，就拿哪个 IP 去签，
 *   于是本机每张网卡的地址都能用，DHCP 换 IP 也不用改配置。
 *   Host 头只是"候选"：签发接口本身对地址做白名单校验（只接受本机当前网卡 IP），
 *   不合法就退回插件默认地址，因此伪造 Host 不会让门签出指向外部的链接。
 *   需要固定行为时把 address 配上即可（配了优先用配置值）。
 *
 * 端点
 *   GET  /            已授权 → 302 到新鲜配对链接（**每次恒定重签**）；未授权 → 密码表单
 *   POST /unlock      表单校验密码，成功后 Set-Cookie 并 302 回 /
 *   GET  /page        已授权 → 带链接和按钮的小页面（想先看一眼链接）
 *   GET  /pair.txt    已授权 → text/plain 返回链接（脚本/剪贴板用）
 *   GET  /logout      清除会话 cookie
 *   其他路径           404
 *
 * /page 与 /pair.txt 会**复用**仍然有效的链接（避免把已经递出去的链接作废）；
 * 而 / 恒定重签，因为浏览器会立刻消费它。
 *
 * 副作用：每次签发都会把最新链接写入同目录 pair-link.txt / pair-link.json。
 */

import http from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
/**
 * 配置文件与状态目录默认与脚本同目录（手工直接跑脚本时零配置即可用）。
 * 由 dsh-lan-tools 插件托管时，插件用这两个环境变量把路径指到 DSH_HOME 下：
 * 用户配置与插件代码/升级解耦，升级插件不会覆盖用户改过的口令。
 */
const CONFIG_PATH = process.env.PAIR_GATE_CONFIG ?? join(HERE, 'gate.config.json')
const DATA_DIR = process.env.PAIR_GATE_DATA_DIR ?? HERE
const STATE_PATH = join(DATA_DIR, 'pair-link.json')
const TXT_PATH = join(DATA_DIR, 'pair-link.txt')

/**
 * 监督器每次拉起 web 服务都会把新 PID 写进这个文件。配对 token 只存在 web
 * 进程内存里，所以 web 一重启，缓存里"尚未过期"的链接其实已经是死链 —— 拿 PID
 * 当服务实例指纹，一旦变了就立刻重签，避免把死链递出去。
 */
const PID_FILE = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'web-gui.pid.txt')

/** 链接剩余寿命低于此值就重签，避免把"马上要死的链接"递出去。 */
const REUSE_MARGIN_MS = 90_000

const COOKIE_NAME = 'pairgate'
const COOKIE_MAX_AGE_S = 12 * 3600
/** 进程内随机会话密钥：重启即失效，等价于"重输一次密码"。 */
const SESSION_VALUE = randomBytes(24).toString('hex')

/** 失败限速：窗口 / 阈值 / 封禁时长。 */
const FAIL_WINDOW_MS = 15 * 60_000
const FAIL_MAX = 5
const FAIL_BLOCK_MS = 15 * 60_000

/**
 * address 默认留空 = 每次按请求 Host 当场决定（见文件头"任意本机 IP"）。
 */
const DEFAULTS = { port: 18080, webPort: 3080, address: '' }

const log = (message) => console.log(`${new Date().toISOString()} ${message}`)

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
}

function readWebPid() {
  try {
    const pid = Number(readFileSync(PID_FILE, 'utf8').trim())
    return Number.isInteger(pid) && pid > 0 ? pid : undefined
  } catch {
    return undefined
  }
}

function loadConfig() {
  const file = readJson(CONFIG_PATH) ?? {}
  const cfg = {
    port: Number(process.env.PAIR_GATE_PORT ?? file.port ?? DEFAULTS.port),
    webPort: Number(process.env.PAIR_GATE_WEB_PORT ?? file.webPort ?? DEFAULTS.webPort),
    address: process.env.PAIR_GATE_ADDRESS ?? file.address ?? DEFAULTS.address,
    password: String(process.env.PAIR_GATE_PASSWORD ?? file.password ?? ''),
  }
  if (cfg.password === '') {
    throw new Error(`no password configured: set "password" in ${CONFIG_PATH}`)
  }
  return cfg
}

/** 定长比较，避免用响应时间泄露口令。 */
function passwordMatches(expected, given) {
  const a = Buffer.from(expected, 'utf8')
  const b = Buffer.from(given, 'utf8')
  const len = Math.max(a.length, b.length, 1)
  const pa = Buffer.alloc(len)
  const pb = Buffer.alloc(len)
  a.copy(pa)
  b.copy(pb)
  return a.length === b.length && timingSafeEqual(pa, pb)
}

/** 向本机 Web 服务的 loopback-only 签发接口要一个新链接。 */
async function mint(cfg, hostAddress) {
  const endpoint = `http://127.0.0.1:${cfg.webPort}/api/pair/issue`
  /** 候选地址：显式配置 > 本次请求的 Host（仅取 IP/主机名，去掉端口）。 */
  const candidate = cfg.address !== '' ? cfg.address : hostAddress
  // 不传 address 时插件用"第一张网卡"的地址兜底；传了就按该地址签发。
  const attempt = async (address) => {
    const body = address === undefined ? {} : { address }
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    const data = await res.json().catch(() => undefined)
    return { res, data }
  }

  let address = candidate
  let { res, data } = await attempt(address)
  // 客户端用的 IP 不在插件白名单里（例如虚拟网卡、或插件尚未感知新地址）时，
  // 退回插件的默认地址，至少保证门本身不 503。
  if (address !== undefined && !res.ok && data?.code === 'unknown-address') {
    log(`host address ${address} not in the plugin allowlist; falling back to the default LAN address`)
    address = undefined
    ;({ res, data } = await attempt(undefined))
  }
  if (!res.ok || typeof data?.url !== 'string') {
    throw new Error(`issue failed: HTTP ${res.status}${data?.code ? ` ${data.code}` : ''}`)
  }
  const state = {
    url: data.url,
    token: data.token,
    expiresAt: data.expiresAt,
    mintedAt: Date.now(),
    webPid: readWebPid(),
    /** 本次签发刻意使用的地址（诊断用）。 */
    address: address ?? null,
    /** 本次签发时客户端用的地址（若走了 Host 派生），供复用/重签时保持一致。 */
    hostAddress: hostAddress ?? null,
  }
  writeFileSync(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  writeFileSync(TXT_PATH, `${data.url}\n`, 'utf8')
  log(`minted ${data.url} (expires ${new Date(data.expiresAt).toISOString()})`)
  return state
}

/**
 * 从请求的 Host 头解析出"客户端实际用来访问本机的地址"。
 * 返回 undefined 表示无法解析/没有 Host —— 交给插件用默认地址兜底。
 */
function hostAddressOf(req) {
  const raw = req.headers.host
  if (typeof raw !== 'string' || raw === '') return undefined
  // IPv6 字面量形如 [fe80::1]:18080
  const value = raw.startsWith('[') ? raw.slice(1, raw.indexOf(']')) : raw.split(':')[0]
  const address = value.trim().toLowerCase()
  if (address === '' || address === 'localhost' || address === '127.0.0.1' || address === '::1') return undefined
  // 只接受 IP 字面量或主机名里安全的一小撮字符，避免把任意字符串塞进链接。
  if (!/^[0-9a-z.\-]+$/.test(address)) return undefined
  return address
}

/** 缓存里的链接还有余量就复用，否则重签 —— 复用可避免作废已发出去的链接。 */
async function currentLink(cfg, hostAddress) {
  const state = readJson(STATE_PATH)
  const pidNow = readWebPid()
  const instanceChanged = state?.webPid !== undefined && pidNow !== undefined && state.webPid !== pidNow
  const alive = typeof state?.expiresAt === 'number' && state.expiresAt - Date.now() > REUSE_MARGIN_MS
  if (state?.url && alive && !instanceChanged) {
    return { ...state, reused: true }
  }
  if (instanceChanged) log(`web server restarted (pid ${state.webPid} -> ${pidNow}); re-minting`)
  // 重签时优先沿用本次请求的地址；没有请求上下文（如 /pair.txt 直接调用）则沿用
  // 上次签发时记录的地址，避免签出与缓存里不一致的另一张网卡的链接。
  const fresh = await mint(cfg, hostAddress ?? state?.hostAddress ?? undefined)
  return { ...fresh, reused: false }
}

// ---------------------------------------------------------------------------
// 失败限速
// ---------------------------------------------------------------------------

/** ip -> { count, windowStart, blockedUntil } */
const attempts = new Map()

function registerFailure(ip) {
  const now = Date.now()
  const entry = attempts.get(ip)
  if (entry === undefined || now - entry.windowStart > FAIL_WINDOW_MS) {
    attempts.set(ip, { count: 1, windowStart: now, blockedUntil: 0 })
    return
  }
  entry.count += 1
  if (entry.count >= FAIL_MAX) {
    entry.blockedUntil = now + FAIL_BLOCK_MS
    log(`auth: blocking ${ip} for ${FAIL_BLOCK_MS / 60000} min after ${entry.count} failures`)
  }
}

function isBlocked(ip) {
  const entry = attempts.get(ip)
  if (entry === undefined) return false
  if (entry.blockedUntil > Date.now()) return true
  if (Date.now() - entry.windowStart > FAIL_WINDOW_MS) attempts.delete(ip)
  return false
}

// ---------------------------------------------------------------------------
// 请求解析 / 认证
// ---------------------------------------------------------------------------

function readBody(req, maxBytes = 4096) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > maxBytes) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function cookieValue(req, name) {
  const header = req.headers.cookie
  if (typeof header !== 'string') return undefined
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=')
    if (key === name) return rest.join('=')
  }
  return undefined
}

function basicPassword(req) {
  const header = req.headers.authorization
  if (typeof header !== 'string' || !header.startsWith('Basic ')) return undefined
  try {
    const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8')
    const index = decoded.indexOf(':')
    return index < 0 ? undefined : decoded.slice(index + 1)
  } catch {
    return undefined
  }
}

/** 会话 cookie 或 HTTP Basic，任一通过即可。 */
function isAuthorized(req, cfg) {
  if (cookieValue(req, COOKIE_NAME) === SESSION_VALUE) return true
  const pw = basicPassword(req)
  return pw !== undefined && passwordMatches(cfg.password, pw)
}

// ---------------------------------------------------------------------------
// 页面
// ---------------------------------------------------------------------------

const escapeHtml = (s) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const CSS = `:root{color-scheme:light dark}
body{font:16px/1.6 system-ui,"Segoe UI",sans-serif;max-width:44rem;margin:4rem auto;padding:0 1.25rem}
h1{font-size:1.25rem}
a.big{display:inline-block;padding:.8rem 1.4rem;border-radius:.5rem;background:#2563eb;color:#fff;text-decoration:none;font-size:1.1rem;font-weight:600}
code{display:block;margin-top:1.5rem;padding:.75rem;border-radius:.4rem;background:#8881;word-break:break-all;user-select:all;font-size:.9rem}
p.hint{opacity:.7;font-size:.85rem;margin-top:1.5rem}
input[type=password]{font-size:1.3rem;padding:.6rem .8rem;border-radius:.4rem;border:1px solid #8886;width:12rem;letter-spacing:.35rem}
button{font-size:1.05rem;padding:.65rem 1.3rem;border-radius:.5rem;border:0;background:#2563eb;color:#fff;font-weight:600;cursor:pointer;margin-left:.6rem}
.err{color:#c0392b;margin-top:1rem}`

function loginHtml(failed) {
  return `<!doctype html>
<html lang="zh-CN">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>DSH Web 配对</title>
<style>${CSS}</style>
<h1>输入密码以配对这台机器</h1>
<form method="post" action="/unlock">
  <input type="password" name="password" inputmode="numeric" autofocus autocomplete="current-password" required>
  <button type="submit">配对</button>
</form>
${failed ? '<p class="err">密码不对，再试一次。</p>' : ''}
<p class="hint">配对成功后浏览器会记住本机，之后直接打开收藏的 DSH Web 地址即可。</p>
</html>
`
}

function linkHtml(link) {
  const left = Math.max(0, Math.round((link.expiresAt - Date.now()) / 1000))
  return `<!doctype html>
<html lang="zh-CN">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>DSH Web 配对</title>
<style>${CSS}</style>
<h1>在这台机器上配对本机的 DSH Web</h1>
<p><a class="big" href="${escapeHtml(link.url)}">点这里完成配对</a></p>
<code>${escapeHtml(link.url)}</code>
<p class="hint">链接由本机（客户端访问用的那个地址：${escapeHtml(link.address ?? '插件默认地址')}）现场签发，约 ${left} 秒后过期（过期无妨：重新打开本页会再签一个）。<br>
${link.reused ? '本次复用了一个仍然有效的链接。' : '本次新签发了链接（上一个已被作废）。'}</p>
</html>
`
}

// ---------------------------------------------------------------------------

let cfg
try {
  cfg = loadConfig()
} catch (error) {
  log(`fatal: ${error.message}`)
  process.exit(2)
}

const send = (res, status, headers, body) => {
  res.writeHead(status, { 'cache-control': 'no-store', ...headers })
  res.end(body)
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://pair-gate.invalid')
  const path = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, '') : url.pathname
  const ip = req.socket.remoteAddress ?? '?'
  /** 客户端实际用来访问本机的地址；用作签发地址（见文件头"任意本机 IP"）。 */
  const hostAddress = hostAddressOf(req)
  log(`req ${ip} ${req.method} ${url.pathname}${hostAddress === undefined ? '' : ` host=${hostAddress}`}`)

  const fail = (error) => {
    log(`error: ${error.message}`)
    send(res, 503, { 'content-type': 'text/plain; charset=utf-8' }, `pair-gate: ${error.message}\n`)
  }
  const unauthorized = () => {
    send(
      res,
      401,
      {
        'content-type': 'text/plain; charset=utf-8',
        'www-authenticate': 'Basic realm="DSH pair gate", charset="UTF-8"',
      },
      'unauthorized\n',
    )
  }
  const throttled = () =>
    send(res, 429, { 'content-type': 'text/plain; charset=utf-8' }, 'too many attempts, try later\n')

  // 表单提交：校验密码 -> 下发会话 cookie
  if (path === '/unlock' && req.method === 'POST') {
    if (isBlocked(ip)) {
      throttled()
      return
    }
    let given = ''
    try {
      given = new URLSearchParams(await readBody(req)).get('password') ?? ''
    } catch {
      send(res, 400, { 'content-type': 'text/plain; charset=utf-8' }, 'bad request\n')
      return
    }
    if (passwordMatches(cfg.password, given)) {
      attempts.delete(ip)
      log(`auth: ok from ${ip}`)
      send(
        res,
        302,
        {
          location: '/',
          'set-cookie': `${COOKIE_NAME}=${SESSION_VALUE}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${COOKIE_MAX_AGE_S}`,
        },
        '',
      )
      return
    }
    registerFailure(ip)
    log(`auth: failed attempt from ${ip}`)
    send(res, 401, { 'content-type': 'text/html; charset=utf-8' }, loginHtml(true))
    return
  }

  if (path === '/logout') {
    send(res, 302, { location: '/', 'set-cookie': `${COOKIE_NAME}=; HttpOnly; Path=/; Max-Age=0` }, '')
    return
  }

  // 根路径：授权了就发链接，没授权就给密码表单
  if (path === '/') {
    if (req.method !== 'GET') {
      send(res, 405, { 'content-type': 'text/plain; charset=utf-8' }, 'method not allowed\n')
      return
    }
    if (isBlocked(ip)) {
      throttled()
      return
    }
    if (!isAuthorized(req, cfg)) {
      send(res, 200, { 'content-type': 'text/html; charset=utf-8' }, loginHtml(false))
      return
    }
    try {
      // 浏览器拿到这个 302 会立刻跟过去配对，所以主路径**恒定重签**：这样永远
      // 不会递出死链，哪怕 web 是被监督器之外的方式重启的（那种重启不会更新
      // web-gui.pid.txt，指纹判不出来）。同时按本次请求的 Host 重签 —— 客户端
      // 用哪个本机 IP 进来，就拿哪个 IP 签，于是每张网卡都能用。
      const link = await mint(cfg, hostAddress)
      send(res, 302, { location: link.url, 'referrer-policy': 'no-referrer' }, '')
    } catch (error) {
      fail(error)
    }
    return
  }

  if (path === '/page' || path === '/pair.txt') {
    if (isBlocked(ip)) {
      throttled()
      return
    }
    if (!isAuthorized(req, cfg)) {
      unauthorized()
      return
    }
    try {
      const link = await currentLink(cfg, hostAddress)
      if (path === '/pair.txt') {
        send(res, 200, { 'content-type': 'text/plain; charset=utf-8' }, `${link.url}\n`)
      } else {
        send(res, 200, { 'content-type': 'text/html; charset=utf-8' }, linkHtml(link))
      }
    } catch (error) {
      fail(error)
    }
    return
  }

  send(res, 404, { 'content-type': 'text/plain; charset=utf-8' }, 'not found\n')
})

server.on('error', (error) => {
  log(`listen failed: ${error.code} ${error.message}`)
  process.exit(1)
})

server.listen(cfg.port, '0.0.0.0', () => {
  const mode = cfg.address === '' ? 'per-request Host (any local IP)' : `fixed ${cfg.address}`
log(`ready on http://0.0.0.0:${cfg.port}/ -> mints via 127.0.0.1:${cfg.webPort} (signing address: ${mode}; password auth on)`)
})
