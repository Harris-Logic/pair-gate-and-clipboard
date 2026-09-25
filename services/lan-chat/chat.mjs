/**
 * lan-chat — 局域网"手机剪贴板"通道。
 *
 * 定位：设备之间的传递通道（手机 / 其他 Windows 机器 → 本机），**不经过 agent**。
 *   * 手机/其他设备在浏览器打开 http://<本机IP>:<port>/，输入口令后即可聊天式发送
 *     文本、图片、多文件；文件夹通过"上传 zip，服务端解包成目录树"实现。
 *   * 每条消息按**时间线**写入桌面上的 Markdown：
 *       C:\Users\Administrator\Desktop\手机剪贴板.md
 *     图片/文件落到同级目录 手机剪贴板.assets\，Markdown 里用相对路径引用
 *     （纯文本格式不塞二进制，这是 Markdown 的最佳实践，也更耐手工查看）。
 *
 * 为什么 JSONL 是真相源、.md 是投影：
 *   多台设备并发直接 append .md 会写乱/写坏；服务端每次改动后**原子重建** .md
 *   （临时文件 + 改名），既能随时重排/补格式，也不会损坏文件。
 *
 * 端点
 *   GET  /            未授权 → 口令页；已授权 → 聊天界面
 *   POST /unlock      表单口令 → 下发会话 cookie
 *   GET  /logout
 *   GET  /config      当前可用地址、上限、设备名（前端引导用）
 *   GET  /history     历史消息（JSON，支持 limit/before）
 *   GET  /events      SSE 实时推送
 *   POST /send        发送（multipart：text / files（多文件）/ zip（解包成目录树））
 *   GET  /f/<路径>    下载/内联查看附件（严格校验，防路径穿越）
 *   GET  /d/<目录>    目录树列表页（手机端查看"文件夹"内容）
 *   GET  /healthz     存活探针（不含任何秘密）
 *
 * 安全（因为会往桌面写文件，这几条是硬要求）
 *   * 口令鉴权（cookie 会话 + HTTP Basic），失败按 IP 限速封禁；
 *   * 单文件/单请求/解包总量/条目数上限，防塞满磁盘与 zip 炸弹；
 *     这些上限都可由配置调；配成 0 即"不限"（见下方 limitMB/limitCount）；
 *   * 上传走流式落盘（边收边写临时文件），所以"不限"不等于"爆内存"；
 *     落盘前预检磁盘余量，传大文件时宁可立刻报错也不写满系统盘；
 *   * 文件名消毒 + 路径穿越校验，附件只落在 assets 目录内，拒绝覆盖已有文件；
 *   * 不提供目录索引，不执行任何上传内容；日志绝不记录口令。
 *
 * 配置见同目录 chat.config.json；可用环境变量 LANCHAT_PORT / LANCHAT_PASSWORD 覆盖。
 */

import { createServer } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import {
  appendFileSync,
  closeSync,
  createReadStream,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statfsSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { networkInterfaces } from 'node:os'
import { basename, dirname, extname, join, resolve, sep } from 'node:path'
import { inflateRawSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
/**
 * 配置文件默认与脚本同目录（手工直接跑脚本时零配置即可用）。由 dsh-lan-tools
 * 插件托管时，插件用 LANCHAT_CONFIG 把路径指到 DSH_HOME 下 —— 这样用户配置与
 * 插件代码/升级解耦：升级插件不会覆盖用户改过的口令和落盘路径。
 */
const CONFIG_PATH = process.env.LANCHAT_CONFIG ?? join(HERE, 'chat.config.json')
let CFG
try {
  CFG = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'))
} catch (error) {
  console.error(`lan-chat: 读不到配置文件 ${CONFIG_PATH}：${error.message}`)
  process.exit(2)
}

const PORT = Number(process.env.LANCHAT_PORT ?? CFG.port ?? 18082)
const PASSWORD = String(process.env.LANCHAT_PASSWORD ?? CFG.password ?? '')
if (PASSWORD === '') {
  console.error(`lan-chat: ${CONFIG_PATH} 缺少 password，拒绝启动`)
  process.exit(2)
}

const DATA_DIR = CFG.dataDir ?? join(HERE, 'data')
const MD_PATH = CFG.desktopMd
const ASSETS_DIR = CFG.assetsDir
if (typeof MD_PATH !== 'string' || MD_PATH === '' || typeof ASSETS_DIR !== 'string' || ASSETS_DIR === '') {
  console.error(`lan-chat: ${CONFIG_PATH} 必须给出 desktopMd 与 assetsDir（落盘位置），拒绝启动`)
  process.exit(2)
}
const MESSAGES_PATH = join(DATA_DIR, 'messages.jsonl')
const ASSETS_REL = basename(ASSETS_DIR) // .md 中的相对引用前缀
const MD_ORDER = CFG.mdOrder === 'oldest-first' ? 'oldest-first' : 'newest-first'

/**
 * 上限解析：配置里写 0 / 负数 / null / "unlimited" 一律表示**不限**（返回 Infinity）。
 * 没写这个键才用默认值。所以"去掉限制"只是改配置，不必动代码。
 */
const UNLIMITED_RE = /^(0|unlimited|inf|infinity|none|off|no)$/i
function limitMB(value, defaultMB) {
  if (value === undefined || value === null) return defaultMB * 1048576
  if (typeof value === 'string' && UNLIMITED_RE.test(value.trim())) return Infinity
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return Infinity
  return n * 1048576
}
function limitCount(value, defaultCount) {
  if (value === undefined || value === null) return defaultCount
  if (typeof value === 'string' && UNLIMITED_RE.test(value.trim())) return Infinity
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return Infinity
  return Math.floor(n)
}

const MAX_FILE = limitMB(CFG.maxFileMB, 100)
const MAX_REQUEST = limitMB(CFG.maxRequestMB, 200)
const MAX_ZIP_ENTRIES = limitCount(CFG.maxZipEntries, 5000)
const MAX_ZIP_TOTAL = limitMB(CFG.maxZipTotalMB, 500)
/**
 * zip 解包要在内存里整份读入（inflateRawSync 无法流式），Buffer 上限约 2 GiB。
 * 所以"文件夹"这条路上限不能真的是无限：超过阈值就给出可操作的提示，
 * 让用户改走"直接发文件"（那条路是真流式、不限大小）。
 */
const MAX_ZIP_BUFFER = 1024 * 1024 * 1024
/** 落盘前预检磁盘余量，留出的安全边距（避免刚好写满系统盘）。 */
const DISK_MARGIN = 512 * 1024 * 1024
/** 未完成的临时分片前缀（放在 assets 内，保证与最终文件同卷，rename 才是原子的）。 */
const PART_PREFIX = '.lanchat-part-'

/** 人类可读的上限描述；不限时返回"不限"。 */
const humanLimit = (bytes) => (Number.isFinite(bytes) ? humanSize(bytes) : '不限')

const COOKIE = 'lanchat'
const COOKIE_MAX_AGE = 12 * 3600
const SESSION = randomBytes(24).toString('hex')
const FAIL_WINDOW = 15 * 60_000
const FAIL_MAX = 5
const FAIL_BLOCK = 15 * 60_000

for (const dir of [DATA_DIR, ASSETS_DIR]) mkdirSync(dir, { recursive: true })

// 上次崩溃 / 传输中断可能留下半截临时分片，启动时清掉，别让它堆在桌面。
try {
  for (const name of readdirSync(ASSETS_DIR)) {
    if (name.startsWith(PART_PREFIX)) {
      try {
        unlinkSync(join(ASSETS_DIR, name))
      } catch {}
    }
  }
} catch {}

const log = (msg) => console.log(`${new Date().toISOString()} ${msg}`)
const localUrls = () =>
  Object.values(networkInterfaces())
    .flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
    .map((i) => `http://${i.address}:${PORT}/`)

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

const json = (res, code, obj) => {
  const body = JSON.stringify(obj)
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(body)
}

const escapeHtml = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** 文件名消毒：去掉目录成分与危险字符，绝不产生可用于穿越的名字。 */
function safeName(raw, fallback = 'file') {
  let name = String(raw ?? '')
  name = name.split(/[\\/]/).pop() ?? ''
  name = name.replace(/[\u0000-\u001f<>:"|?*]/g, '_').trim()
  name = name.replace(/^\.+/, '')
  if (name.length > 120) {
    const ext = extname(name).slice(0, 12)
    name = name.slice(0, 120 - ext.length) + ext
  }
  return name === '' ? fallback : name
}

/** 在 assets 目录内生成不冲突的落盘名。 */
function uniqueInAssets(name) {
  let candidate = name
  let n = 1
  while (existsSync(join(ASSETS_DIR, candidate))) {
    const ext = extname(name)
    candidate = `${name.slice(0, name.length - ext.length)}-${n}${ext}`
    n += 1
  }
  return candidate
}

const stamp = (d = new Date()) => {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}
const humanTime = (ms) => {
  const d = new Date(ms)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}
const humanSize = (n) => {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1048576).toFixed(1)} MB`
  return `${(n / 1073741824).toFixed(2)} GB`
}

// ---------------------------------------------------------------------------
// 存储：JSONL 真相源 + Markdown 投影
// ---------------------------------------------------------------------------

function loadMessages() {
  if (!existsSync(MESSAGES_PATH)) return []
  const out = []
  for (const line of readFileSync(MESSAGES_PATH, 'utf8').split('\n')) {
    if (line.trim() === '') continue
    try {
      out.push(JSON.parse(line))
    } catch {
      log(`warn: 跳过损坏的 JSONL 行（${line.slice(0, 60)}…）`)
    }
  }
  return out
}

function appendMessage(record) {
  appendFileSync(MESSAGES_PATH, `${JSON.stringify(record)}\n`, 'utf8')
}

/** 相对链接里的特殊字符要转义，否则 Markdown 链接会断。 */
const mdLink = (relPath) => encodeURI(relPath).replace(/\(/g, '%28').replace(/\)/g, '%29')

function messageMarkdown(rec) {
  const lines = [`## ${humanTime(rec.ts)} · 来自 ${rec.device ?? '未知设备'}`, '']
  if (rec.text) lines.push(rec.text, '')
  for (const f of rec.files ?? []) {
    const rel = `${ASSETS_REL}/${f.stored}`
    if (f.kind === 'image') {
      lines.push(`![${f.name}](${mdLink(rel)})`, '')
    } else if (f.kind === 'folder') {
      lines.push(`📁 **${f.name}**（${(f.entries ?? []).length} 个文件）`, '')
      for (const entry of f.entries ?? []) {
        lines.push(`- [${entry.path}](${mdLink(`${rel}/${entry.path}`)}) · ${humanSize(entry.size)}`)
      }
      lines.push('')
    } else {
      lines.push(`📎 [${f.name}](${mdLink(rel)}) · ${humanSize(f.size)}`, '')
    }
  }
  return lines.join('\n')
}

/** 原子重建 .md：临时文件 + 改名；被占用时退化为直接写。 */
function rebuildMarkdown(messages) {
  const ordered = MD_ORDER === 'oldest-first' ? messages : [...messages].reverse()
  const head = [
    '# 手机剪贴板',
    '',
    '> 本文件由 lan-chat 服务自动维护：每收到一条消息就整体重建一次。',
    '> 手工修改会在下一条消息到达时被覆盖；附件在同级目录 `' + ASSETS_REL + '` 内。',
    '',
  ]
  const body = ordered.length === 0 ? ['（还没有内容）', ''] : ordered.map(messageMarkdown)
  const text = `${head.join('\n')}\n${body.join('\n')}`
  const tmp = `${MD_PATH}.tmp`
  try {
    writeFileSync(tmp, text, 'utf8')
    renameSync(tmp, MD_PATH)
  } catch (error) {
    log(`warn: 原子重建失败（${error.code ?? error.message}），退化为直接写`)
    try {
      writeFileSync(MD_PATH, text, 'utf8')
    } catch (inner) {
      log(`error: 写 .md 失败：${inner.message}`)
    }
  }
}

// ---------------------------------------------------------------------------
// zip 解包（自己实现，零依赖）：仅支持 stored/deflate，带总量与条目数上限
// ---------------------------------------------------------------------------

function readZipEntries(buf) {
  // 从尾部找 EOCD (0x06054b50)
  let eocd = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65558); i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('不是有效的 zip（找不到 EOCD）')
  const count = buf.readUInt16LE(eocd + 10)
  const cdSize = buf.readUInt32LE(eocd + 12)
  const cdOffset = buf.readUInt32LE(eocd + 16)
  if (count === 0xffff || cdOffset === 0xffffffff) throw new Error('不支持 Zip64 格式的 zip')
  if (cdOffset + cdSize > buf.length) throw new Error('zip 目录越界（文件可能损坏）')

  const entries = []
  let p = cdOffset
  for (let i = 0; i < count; i += 1) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('zip 中央目录项签名错误')
    const method = buf.readUInt16LE(p + 10)
    const compSize = buf.readUInt32LE(p + 20)
    const rawSize = buf.readUInt32LE(p + 24)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    const localOffset = buf.readUInt32LE(p + 42)
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8')
    entries.push({ name, method, compSize, rawSize, localOffset })
    p += 46 + nameLen + extraLen + commentLen
  }

  // 解出数据（延迟到调用方做上限检查后再解压）
  for (const entry of entries) {
    if (buf.readUInt32LE(entry.localOffset) !== 0x04034b50) throw new Error('zip 局部头签名错误')
    const nameLen = buf.readUInt16LE(entry.localOffset + 26)
    const extraLen = buf.readUInt16LE(entry.localOffset + 28)
    const start = entry.localOffset + 30 + nameLen + extraLen
    entry.data = buf.subarray(start, start + entry.compSize)
  }
  return entries
}

/** 单个 zip 条目名 → 安全的相对路径（拒绝绝对路径与 ..）。 */
function safeZipPath(name) {
  const parts = String(name).split(/[\\/]+/).filter((s) => s !== '' && s !== '.')
  const out = []
  for (const part of parts) {
    if (part === '..') return undefined
    out.push(safeName(part, '_'))
  }
  return out.length === 0 ? undefined : out.join('/')
}

function unpackZip(buf, dirName) {
  const entries = readZipEntries(buf)
  const target = join(ASSETS_DIR, dirName)
  mkdirSync(target, { recursive: true })
  const saved = []
  let total = 0
  for (const entry of entries) {
    if (entry.name.endsWith('/')) continue // 目录项
    const rel = safeZipPath(entry.name)
    if (rel === undefined) {
      log(`warn: zip 内条目被拒绝（疑似穿越）：${entry.name}`)
      continue
    }
    if (saved.length >= MAX_ZIP_ENTRIES) throw new Error(`zip 条目超过上限 ${MAX_ZIP_ENTRIES}`)
    let data
    if (entry.method === 0) data = entry.data
    else if (entry.method === 8) data = inflateRawSync(entry.data)
    else {
      log(`warn: 跳过不支持的压缩方式 ${entry.method}：${rel}`)
      continue
    }
    total += data.length
    if (total > MAX_ZIP_TOTAL) throw new Error(`zip 解包总量超过上限 ${MAX_ZIP_TOTAL / 1048576} MB`)
    const dest = join(target, ...rel.split('/'))
    if (!resolve(dest).startsWith(resolve(target) + sep)) throw new Error('zip 条目路径越界')
    mkdirSync(dirname(dest), { recursive: true })
    writeFileSync(dest, data)
    saved.push({ path: rel, size: data.length })
  }
  saved.sort((a, b) => a.path.localeCompare(b.path))
  return saved
}

// ---------------------------------------------------------------------------
// 鉴权 / 限速
// ---------------------------------------------------------------------------

const attempts = new Map()

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

function registerFailure(ip) {
  const now = Date.now()
  const entry = attempts.get(ip)
  if (!entry || now - entry.windowStart > FAIL_WINDOW) {
    attempts.set(ip, { count: 1, windowStart: now, blockedUntil: 0 })
    return
  }
  entry.count += 1
  if (entry.count >= FAIL_MAX) {
    entry.blockedUntil = now + FAIL_BLOCK
    log(`auth: 封禁 ${ip} ${FAIL_BLOCK / 60000} 分钟（连续 ${entry.count} 次失败）`)
  }
}

function isBlocked(ip) {
  const entry = attempts.get(ip)
  if (!entry) return false
  if (entry.blockedUntil > Date.now()) return true
  if (Date.now() - entry.windowStart > FAIL_WINDOW) attempts.delete(ip)
  return false
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
    const i = decoded.indexOf(':')
    return i < 0 ? undefined : decoded.slice(i + 1)
  } catch {
    return undefined
  }
}

function isAuthorized(req) {
  if (cookieValue(req, COOKIE) === SESSION) return true
  const pw = basicPassword(req)
  return pw !== undefined && passwordMatches(PASSWORD, pw)
}

function readBody(req, limit) {
  return new Promise((resolvePromise, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error(`请求体超过上限 ${Math.round(limit / 1048576)} MB`))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolvePromise(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

// ---------------------------------------------------------------------------
// 流式 multipart/form-data 解析
//
// 为什么不用 readBody(req) + new Response(buf).formData()：
//   那条路要把整个请求体、解析结果、以及每个文件的 arrayBuffer 在内存里复制
//   2~3 份；200 MB 的请求就要几百 MB 堆，单文件上百 MB 必然 OOM ——
//   这正是原来"单文件 100 MB / 单次 200 MB"限制的技术根源。
//   这里改成边收边落盘：文件字节直接 write 进临时文件，内存里只留很小的字段。
// ---------------------------------------------------------------------------

/** 从 content-type 里取 multipart 边界。 */
function boundaryOf(contentType) {
  const m = /;\s*boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(String(contentType ?? ''))
  const b = m?.[1] ?? m?.[2]
  return b && b.length <= 200 ? b : undefined
}

/**
 * 极简流式 multipart 解析器（零依赖）。
 * 只在内存里保留"可能承载边界的一小段尾巴"，其余字节立刻交给 onPartData。
 */
function createMultipartParser(boundary, handlers) {
  const B = Buffer.from(`--${boundary}`)
  const DASHB = Buffer.from(`\r\n--${boundary}`)
  let pending = Buffer.alloc(0)
  let state = 'preamble' // preamble → afterBoundary → headers → body → done
  let part = null
  let headerRaw = ''

  const startPart = (raw) => {
    const headers = {}
    for (const line of raw.split('\r\n')) {
      const i = line.indexOf(':')
      if (i < 0) continue
      headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim()
    }
    const disp = {}
    for (const m of String(headers['content-disposition'] ?? '').matchAll(/([A-Za-z-]+)="([^"]*)"/g)) {
      disp[m[1].toLowerCase()] = m[2]
    }
    part = {
      name: disp.name ?? '',
      filename: disp.filename, // undefined → 普通文本字段
      contentType: headers['content-type'] ?? '',
    }
    handlers.onPartStart?.(part)
  }

  function step() {
    for (;;) {
      if (state === 'preamble') {
        const i = pending.indexOf(B)
        if (i < 0) {
          if (pending.length > B.length + 4) pending = pending.subarray(pending.length - (B.length + 4))
          return
        }
        pending = pending.subarray(i + B.length)
        state = 'afterBoundary'
        continue
      }
      if (state === 'afterBoundary') {
        if (pending.length < 2) return
        if (pending[0] === 0x2d && pending[1] === 0x2d) {
          state = 'done' // "--" → 结束边界
          pending = Buffer.alloc(0)
          return
        }
        if (pending[0] === 0x0d && pending[1] === 0x0a) pending = pending.subarray(2)
        state = 'headers'
        headerRaw = ''
        continue
      }
      if (state === 'headers') {
        const i = pending.indexOf('\r\n\r\n')
        if (i < 0) {
          if (pending.length > 256 * 1024) throw new Error('multipart 头部异常大')
          return
        }
        headerRaw += pending.subarray(0, i).toString('utf8')
        pending = pending.subarray(i + 4)
        startPart(headerRaw)
        state = 'body'
        continue
      }
      if (state === 'body') {
        const i = pending.indexOf(DASHB)
        if (i < 0) {
          // 尾巴里可能藏着跨块的边界，留够 DASHB.length - 1 字节继续攒
          const keep = DASHB.length - 1
          if (pending.length > keep) {
            handlers.onPartData?.(part, pending.subarray(0, pending.length - keep))
            pending = pending.subarray(pending.length - keep)
          }
          return
        }
        if (i > 0) handlers.onPartData?.(part, pending.subarray(0, i))
        handlers.onPartEnd?.(part)
        part = null
        pending = pending.subarray(i + DASHB.length)
        state = 'afterBoundary'
        continue
      }
      pending = Buffer.alloc(0) // done：丢掉 epilogue
      return
    }
  }

  return {
    write(chunk) {
      if (state === 'done') return
      pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk])
      step()
    },
    end() {
      step()
      if (state !== 'done' && part) {
        // 结束边界缺失（客户端中断）：把残留交出去，由上层判定为失败
        if (pending.length > 0) handlers.onPartData?.(part, pending)
        handlers.onPartEnd?.(part)
        part = null
      }
      state = 'done'
      pending = Buffer.alloc(0)
    },
  }
}

/** 目标目录所在卷的可用字节数（拿不到就返回 undefined，不阻断上传）。 */
function freeBytesOf(dir) {
  try {
    const st = statfsSync(dir)
    return Number(st.bavail) * Number(st.bsize)
  } catch {
    return undefined
  }
}

// ---------------------------------------------------------------------------
// 页面
// ---------------------------------------------------------------------------

const LOGIN_CSS = `:root{color-scheme:light dark}
body{font:16px/1.6 system-ui,"Segoe UI",sans-serif;max-width:40rem;margin:4rem auto;padding:0 1.25rem}
h1{font-size:1.25rem}
input[type=password]{font-size:1.3rem;padding:.6rem .8rem;border-radius:.4rem;border:1px solid #8886;width:12rem;letter-spacing:.35rem}
button{font-size:1.05rem;padding:.65rem 1.3rem;border-radius:.5rem;border:0;background:#2563eb;color:#fff;font-weight:600;cursor:pointer;margin-left:.6rem}
code{background:#8881;padding:.15rem .35rem;border-radius:.25rem}
.err{color:#c0392b;margin-top:1rem}
p.hint{opacity:.7;font-size:.85rem;margin-top:1.5rem}
ul{opacity:.8;font-size:.9rem}`

function loginPage(failed) {
  const urls = localUrls()
  return `<!doctype html>
<html lang="zh-CN"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>手机剪贴板</title><style>${LOGIN_CSS}</style>
<h1>输入口令，进入手机剪贴板</h1>
<form method="post" action="/unlock">
  <input type="password" name="password" inputmode="numeric" autofocus autocomplete="current-password" required>
  <button type="submit">进入</button>
</form>
${failed ? '<p class="err">口令不对，再试一次。</p>' : ''}
<p class="hint">发来的文本/图片/文件会自动写进电脑桌面的 <code>手机剪贴板.md</code>。</p>
${urls.length > 1 ? `<p class="hint">本机当前可用的入口（换网络后可能变）：</p><ul>${urls.map((u) => `<li><code>${escapeHtml(u)}</code></li>`).join('')}</ul>` : ''}
</html>`
}

function dirListing(dirName, entries, reqQuery) {
  const rows = entries
    .filter((e) => e.isFile())
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((e) => {
      const rel = `${dirName}/${e.name}`
      return `<li><a href="/f/${encodeURI(rel)}">${escapeHtml(e.name)}</a> <span class="s">${humanSize(e.size ?? 0)}</span></li>`
    })
    .join('\n')
  return `<!doctype html>
<html lang="zh-CN"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(dirName)}</title>
<style>${LOGIN_CSS}li{margin:.35rem 0}.s{opacity:.6;font-size:.85rem}</style>
<h1>📁 ${escapeHtml(dirName)}</h1>
<ul>${rows || '<li>（空目录）</li>'}</ul>
<p class="hint"><a href="/">← 回到聊天</a></p>
</html>`
}

// ---------------------------------------------------------------------------
// SSE
// ---------------------------------------------------------------------------

const sseClients = new Set()

function broadcast(record) {
  const payload = `id: ${record.id}\ndata: ${JSON.stringify(record)}\n\n`
  for (const res of sseClients) {
    try {
      res.write(payload)
    } catch {
      sseClients.delete(res)
    }
  }
}

setInterval(() => {
  for (const res of sseClients) {
    try {
      res.write(': ping\n\n')
    } catch {
      sseClients.delete(res)
    }
  }
}, 25_000).unref()

// ---------------------------------------------------------------------------
// 路由
// ---------------------------------------------------------------------------

const MIME_IMAGE = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://lan-chat.invalid')
  const path = url.pathname
  const ip = req.socket.remoteAddress ?? '?'
  const ua = String(req.headers['user-agent'] ?? '')

  const unauthorized = () => {
    res.writeHead(401, {
      'content-type': 'text/plain; charset=utf-8',
      'www-authenticate': 'Basic realm="lan-chat", charset="UTF-8"',
      'cache-control': 'no-store',
    })
    res.end('unauthorized\n')
  }

  if (path !== '/events') log(`req ${ip} ${req.method} ${path}`)

  if (path === '/healthz') {
    json(res, 200, { ok: true, service: 'lan-chat', port: PORT })
    return
  }

  if (path === '/unlock' && req.method === 'POST') {
    if (isBlocked(ip)) {
      res.writeHead(429, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('too many attempts\n')
      return
    }
    let given = ''
    try {
      given = new URLSearchParams((await readBody(req, 4096)).toString('utf8')).get('password') ?? ''
    } catch {
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('bad request\n')
      return
    }
    if (passwordMatches(PASSWORD, given)) {
      attempts.delete(ip)
      log(`auth: ok from ${ip}`)
      res.writeHead(302, {
        location: '/',
        'set-cookie': `${COOKIE}=${SESSION}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${COOKIE_MAX_AGE}`,
        'cache-control': 'no-store',
      })
      res.end()
      return
    }
    registerFailure(ip)
    log(`auth: 口令错误来自 ${ip}`)
    res.writeHead(401, { 'content-type': 'text/html; charset=utf-8' })
    res.end(loginPage(true))
    return
  }

  if (path === '/logout') {
    res.writeHead(302, {
      location: '/',
      'set-cookie': `${COOKIE}=; HttpOnly; Path=/; Max-Age=0`,
      'cache-control': 'no-store',
    })
    res.end()
    return
  }

  if (isBlocked(ip)) {
    res.writeHead(429, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('too many attempts\n')
    return
  }

  if (path === '/') {
    if (!isAuthorized(req)) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      res.end(loginPage(false))
      return
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    res.end(readFileSync(join(HERE, 'ui.html'), 'utf8'))
    return
  }

  if (!isAuthorized(req)) {
    unauthorized()
    return
  }

  if (path === '/config') {
    json(res, 200, {
      urls: localUrls(),
      port: PORT,
      limits: {
        // null = 不限（前端据此显示"不限"）
        maxFileMB: Number.isFinite(MAX_FILE) ? MAX_FILE / 1048576 : null,
        maxRequestMB: Number.isFinite(MAX_REQUEST) ? MAX_REQUEST / 1048576 : null,
        maxZipEntries: Number.isFinite(MAX_ZIP_ENTRIES) ? MAX_ZIP_ENTRIES : null,
        maxZipTotalMB: Number.isFinite(MAX_ZIP_TOTAL) ? MAX_ZIP_TOTAL / 1048576 : null,
      },
      mdPath: MD_PATH,
      assetsRel: ASSETS_REL,
    })
    return
  }

  if (path === '/history') {
    const limit = Math.min(Number(url.searchParams.get('limit') ?? 200) || 200, 1000)
    const before = url.searchParams.get('before')
    let all = loadMessages()
    if (before) {
      const idx = all.findIndex((m) => m.id === before)
      if (idx >= 0) all = all.slice(0, idx)
    }
    const slice = all.slice(Math.max(0, all.length - limit))
    json(res, 200, { messages: slice, hasMore: all.length > slice.length })
    return
  }

  if (path === '/events') {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    res.write(': connected\n\n')
    sseClients.add(res)
    req.on('close', () => sseClients.delete(res))
    return
  }

  if (path === '/send' && req.method === 'POST') {
    const boundary = boundaryOf(req.headers['content-type'])
    if (boundary === undefined) {
      json(res, 400, { ok: false, error: '缺少 multipart 边界（content-type 不对）' })
      return
    }

    // 磁盘余量预检：宁可立刻报错，也不要传到一半把系统盘写满。
    const declared = Number(req.headers['content-length'] ?? 0)
    if (Number.isFinite(declared) && declared > 0) {
      const free = freeBytesOf(ASSETS_DIR)
      if (free !== undefined && declared + DISK_MARGIN > free) {
        json(res, 400, {
          ok: false,
          error: `磁盘空间不足：本次 ${humanSize(declared)}，目标盘可用 ${humanSize(free)}`,
        })
        return
      }
    }

    const ts = Date.now()
    const base = `${stamp()}-${randomBytes(2).toString('hex')}`
    const files = []
    const fieldChunks = new Map()
    let fieldBytes = 0
    let received = 0
    let seq = 0
    let failure = null
    let open = null // { tmpPath, fd, size }

    /** 关闭当前分片；keep=false 时连临时文件一起删掉。 */
    const closeOpen = (keep) => {
      if (!open) return
      const { fd, tmpPath } = open
      open = null
      try {
        closeSync(fd)
      } catch {}
      if (!keep) {
        try {
          unlinkSync(tmpPath)
        } catch {}
      }
    }

    /** 出错即回响应并掐断连接，避免客户端继续把几个 GB 灌进来。 */
    const abort = (error) => {
      if (failure) return
      failure = error
      closeOpen(false)
      try {
        json(res, 400, { ok: false, error: error.message })
      } catch {}
      res.on('finish', () => {
        try {
          req.destroy()
        } catch {}
      })
      if (res.writableFinished) {
        try {
          req.destroy()
        } catch {}
      }
    }

    // 连接断掉时别留下半截临时文件
    res.on('close', () => closeOpen(false))

    const parser = createMultipartParser(boundary, {
      onPartStart(p) {
        if (failure || p.filename === undefined) return
        const tmpPath = join(ASSETS_DIR, `${PART_PREFIX}${randomBytes(6).toString('hex')}`)
        try {
          open = { tmpPath, fd: openSync(tmpPath, 'w'), size: 0 }
        } catch (error) {
          abort(new Error(`无法创建临时文件：${error.message}`))
        }
      },
      onPartData(p, chunk) {
        if (failure || chunk.length === 0) return
        if (p.filename === undefined) {
          fieldBytes += chunk.length
          if (fieldBytes > 4 * 1024 * 1024) {
            abort(new Error('表单字段过大'))
            return
          }
          const arr = fieldChunks.get(p.name) ?? []
          arr.push(Buffer.from(chunk)) // 复制：chunk 只是内部缓冲的视图
          fieldChunks.set(p.name, arr)
          return
        }
        if (!open) return
        open.size += chunk.length
        if (open.size > MAX_FILE) {
          abort(new Error(`单个文件超过 ${humanLimit(MAX_FILE)}：${p.filename}`))
          return
        }
        try {
          writeSync(open.fd, chunk)
        } catch (error) {
          abort(new Error(`写入失败（磁盘可能已满）：${error.message}`))
        }
      },
      onPartEnd(p) {
        if (p.filename === undefined || !open) return
        const { tmpPath, size } = open
        closeOpen(true) // 关 fd，保留临时文件
        if (failure) {
          try {
            unlinkSync(tmpPath)
          } catch {}
          return
        }
        seq += 1
        const original = safeName(p.filename, p.name === 'zip' ? 'archive.zip' : 'file')
        let moved = false
        try {
          if (p.name === 'zip') {
            if (size > MAX_ZIP_BUFFER) {
              throw new Error(
                `zip 有 ${humanSize(size)}，服务端解包需整份读入内存（上限 ${humanSize(MAX_ZIP_BUFFER)}）：` +
                  '请直接发送文件（单文件已不限大小），或分卷压缩后当普通文件发送。',
              )
            }
            const folderName = uniqueInAssets(original.replace(/\.zip$/i, '') || `目录-${base}-${seq}`)
            const entries = unpackZip(readFileSync(tmpPath), folderName)
            files.push({ name: original.replace(/\.zip$/i, ''), stored: folderName, size, kind: 'folder', entries })
          } else {
            const stored = uniqueInAssets(`${base}-${seq}-${original}`)
            renameSync(tmpPath, join(ASSETS_DIR, stored)) // 同卷改名，原子生效
            moved = true
            const ext = extname(stored).toLowerCase()
            files.push({ name: original, stored, size, kind: MIME_IMAGE[ext] ? 'image' : 'file' })
          }
        } catch (error) {
          abort(error)
        } finally {
          if (!moved) {
            try {
              unlinkSync(tmpPath)
            } catch {}
          }
        }
      },
    })

    try {
      await new Promise((resolvePromise, reject) => {
        req.on('data', (chunk) => {
          if (failure) return
          received += chunk.length
          if (received > MAX_REQUEST) {
            abort(new Error(`单次请求超过 ${humanLimit(MAX_REQUEST)}`))
            return
          }
          try {
            parser.write(chunk)
          } catch (error) {
            abort(error)
          }
        })
        req.on('end', resolvePromise)
        req.on('error', reject)
        req.on('aborted', () => reject(new Error('客户端中断')))
      })
      parser.end()
    } catch (error) {
      abort(error)
    }

    if (failure) {
      log(`send 失败：${failure.message}`)
      return // abort() 里已经回过响应了
    }

    const text = Buffer.concat(fieldChunks.get('text') ?? []).toString('utf8').trim()
    const deviceField = Buffer.concat(fieldChunks.get('device') ?? []).toString('utf8')
    const device = safeName(deviceField || deviceNameFromUa(ua), '未命名设备')
    if (text === '' && files.length === 0) {
      json(res, 400, { ok: false, error: '内容为空' })
      return
    }
    const record = { id: `m-${ts}-${randomBytes(3).toString('hex')}`, ts, device, text, files }
    appendMessage(record)
    rebuildMarkdown(loadMessages())
    broadcast(record)
    log(`recv ${files.length} 个附件 / ${text.length} 字 · ${device} · ${humanSize(received)}`)
    json(res, 200, { ok: true, message: record })
    return
  }

  if (path.startsWith('/f/')) {
    const rel = decodeURIComponent(path.slice(3))
    const parts = rel.split('/').filter((s) => s !== '')
    if (parts.length === 0 || parts.some((s) => s === '.' || s === '..' || s.includes('\\') || s.includes('\u0000'))) {
      res.writeHead(400).end('bad path\n')
      return
    }
    const target = resolve(join(ASSETS_DIR, ...parts))
    if (!target.startsWith(resolve(ASSETS_DIR) + sep)) {
      res.writeHead(403).end('forbidden\n')
      return
    }
    let stat
    try {
      stat = statSync(target)
    } catch {
      res.writeHead(404).end('not found\n')
      return
    }
    if (!stat.isFile()) {
      res.writeHead(404).end('not found\n')
      return
    }
    const ext = extname(target).toLowerCase()
    const image = MIME_IMAGE[ext]
    const total = stat.size
    // 必须流式发送：readFileSync 会把整份文件读进内存，大文件直接 OOM。
    // 同时支持 Range，大文件下载中断后可以续传。
    let start = 0
    let end = total - 1
    let code = 200
    const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? '').trim())
    if (range && (range[1] !== '' || range[2] !== '')) {
      if (range[1] !== '') {
        start = Number(range[1])
        end = range[2] !== '' ? Number(range[2]) : total - 1
      } else {
        start = Math.max(0, total - Number(range[2]))
        end = total - 1
      }
      if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= total) {
        res.writeHead(416, { 'content-range': `bytes */${total}`, 'cache-control': 'no-store' })
        res.end()
        return
      }
      end = Math.min(end, total - 1)
      code = 206
    }
    res.writeHead(code, {
      'content-type': image ?? 'application/octet-stream',
      'content-length': end - start + 1,
      'accept-ranges': 'bytes',
      'cache-control': 'private, max-age=300',
      'x-content-type-options': 'nosniff',
      ...(image
        ? {}
        : { 'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(basename(target))}` }),
      ...(code === 206 ? { 'content-range': `bytes ${start}-${end}/${total}` } : {}),
    })
    if (req.method === 'HEAD') {
      res.end()
      return
    }
    const stream = createReadStream(target, { start, end })
    stream.on('error', () => {
      try {
        res.destroy()
      } catch {}
    })
    stream.pipe(res)
    return
  }

  if (path.startsWith('/d/')) {
    const dirName = safeName(decodeURIComponent(path.slice(3)), '')
    if (dirName === '' || dirName !== decodeURIComponent(path.slice(3)).split('/').pop()) {
      res.writeHead(400).end('bad path\n')
      return
    }
    const target = resolve(join(ASSETS_DIR, dirName))
    if (!target.startsWith(resolve(ASSETS_DIR) + sep)) {
      res.writeHead(403).end('forbidden\n')
      return
    }
    try {
      const entries = readdirSync(target, { withFileTypes: true }).map((e) => ({
        name: e.name,
        isFile: () => e.isFile(),
        size: e.isFile() ? statSync(join(target, e.name)).size : 0,
      }))
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      res.end(dirListing(dirName, entries, ''))
    } catch {
      res.writeHead(404).end('not found\n')
    }
    return
  }

  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
  res.end('not found\n')
})

/**
 * Node 18+ 默认 requestTimeout = 300s，指的是"收完整个请求"的时限。
 * 大文件在 WiFi 上传几分钟到几十分钟很常见，不关掉就会传到一半被掐断 ——
 * 这是"大文件传不完"的隐藏原因，和体积上限无关，但同样致命。
 */
server.requestTimeout = 0
server.headersTimeout = 60_000
server.keepAliveTimeout = 5_000

function deviceNameFromUa(ua) {
  if (/Android/i.test(ua)) return 'Android 设备'
  if (/iPhone|iPad/i.test(ua)) return 'iOS 设备'
  if (/Windows/i.test(ua)) return 'Windows 设备'
  return '未知设备'
}

server.listen(PORT, '0.0.0.0', () => {
  // 启动即重建一次：手工改过 JSONL、或上次写到一半崩了，都能自愈。
  rebuildMarkdown(loadMessages())
  log(`ready on http://0.0.0.0:${PORT}/ · 入口 ${localUrls().join(' , ') || '(仅回环)'}`)
  log(`markdown -> ${MD_PATH}`)
  log(`assets   -> ${ASSETS_DIR}`)
})
