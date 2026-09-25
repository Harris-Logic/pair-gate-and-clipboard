#!/usr/bin/env node
/**
 * push-via-api.mjs — git 传输层不通时的兜底推送（走 GitHub Git Data API）。
 *
 * 为什么需要它
 *   某些网络里 git-over-HTTPS 会被中间设备掐断（CONNECT 502、TLS 握手被重置），
 *   但 api.github.com 仍然可达。本脚本把**本地已经存在的那个提交**原样搬到远端，
 *   效果等价于 git push。
 *
 * 与旧版 scripts/push-via-api.ps1 的区别（旧版做法有问题，已删除）
 *   1. 旧版把工作区文件重新打成一个提交，**丢掉本地提交历史**，于是本地与远端分叉，
 *      之后正常 git push 必然冲突。本脚本推的就是 HEAD 那个提交：git 对象是内容寻址的，
 *      只要 parent / tree / message / author / committer 完全一致，远端算出来的 SHA
 *      与本地一模一样 —— 推完两边仍然同步，可以直接继续用 git push。
 *   2. 旧版按「目录扫描 + 硬编码排除名单」挑文件，**不看 .gitignore**，
 *      会把 config\chat.config.json（含口令）这类未跟踪文件一起传上去。
 *      本脚本的文件清单只来自 git 对象（git ls-tree / git diff-tree），
 *      未跟踪与被忽略的文件天然不在其中。
 *   3. 旧版更新 ref 时写死 force=true，会静默覆盖远端提交。本脚本默认要求**快进**
 *      （远端必须正好在本地 HEAD 的父提交上），不满足就报错退出；
 *      确实要覆盖得显式加 --force。
 *   4. 旧版不做校验。本脚本每一步都比对 SHA（blob / tree / commit），
 *      任何一步对不上就在改 ref 之前中止 —— 远端最多留下几个未被引用的悬空对象。
 *
 * 用法
 *   set GH_TOKEN=ghp_xxx                    # 需要 contents:write 的 PAT
 *   node scripts/push-via-api.mjs --dry-run # 先看会推什么
 *   node scripts/push-via-api.mjs
 *
 * 选项
 *   --repo <owner/name>   默认从 origin 的 URL 推断
 *   --remote <name>       默认 origin
 *   --branch <name>       默认当前分支
 *   --root <dir>          仓库根目录，默认脚本所在目录的上一级
 *   --dry-run             只检查并打印将要发生的事，不在远端创建任何对象
 *   --force               允许非快进（覆盖远端提交）
 *
 * token 只从环境变量 GH_TOKEN / GITHUB_TOKEN 读取，绝不写进任何文件。
 */
import { execFileSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const API = 'https://api.github.com'
const HERE = dirname(fileURLToPath(import.meta.url))

// ---------------------------------------------------------------------------
// 命令行
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = { remote: 'origin', branch: '', root: resolve(HERE, '..'), repo: '', dryRun: false, force: false }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    const next = () => {
      const v = argv[i + 1]
      if (v === undefined || v.startsWith('--')) throw new Error(`${a} 需要一个值`)
      i += 1
      return v
    }
    if (a === '--repo') out.repo = next()
    else if (a === '--remote') out.remote = next()
    else if (a === '--branch') out.branch = next()
    else if (a === '--root') out.root = resolve(next())
    else if (a === '--dry-run') out.dryRun = true
    else if (a === '--force') out.force = true
    else if (a === '-h' || a === '--help') out.help = true
    else throw new Error(`未知参数：${a}`)
  }
  return out
}

const USAGE = `用法：node scripts/push-via-api.mjs [选项]

  --repo <owner/name>   默认从 remote 的 URL 推断
  --remote <name>       默认 origin
  --branch <name>       默认当前分支
  --root <dir>          仓库根目录，默认脚本所在目录的上一级
  --dry-run             只检查并打印将要发生的事，不在远端创建任何对象
  --force               允许非快进（覆盖远端提交），谨慎使用

token 从环境变量 GH_TOKEN 或 GITHUB_TOKEN 读取。`

// ---------------------------------------------------------------------------
// git（只用只读命令；不改变本地仓库状态）
// ---------------------------------------------------------------------------

function git(args, cwd, asBuffer = false) {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: asBuffer ? 'buffer' : 'utf8',
      maxBuffer: 512 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error('找不到 git，请先安装并放进 PATH')
    const detail = String(error.stderr ?? error.message).trim().split('\n')[0]
    throw new Error(`git ${args.join(' ')} 失败：${detail}`)
  }
}

/** git 的 "<unix> <±hhmm>" → GitHub 要的 ISO 8601（保持同一时区偏移）。 */
function toIso(unixSec, tz) {
  const sign = tz.startsWith('-') ? -1 : 1
  const hh = Number(tz.slice(1, 3))
  const mm = Number(tz.slice(3, 5))
  const d = new Date((unixSec + sign * (hh * 60 + mm) * 60) * 1000)
  const p = (n) => String(n).padStart(2, '0')
  return (
    `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}` +
    `T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}` +
    `${sign < 0 ? '-' : '+'}${p(hh)}:${p(mm)}`
  )
}

const PERSON_RE = /^(.*) <(.*)> (\d+) ([+-]\d{4})$/
function parsePerson(line) {
  const m = PERSON_RE.exec(line)
  if (!m) throw new Error(`无法解析 commit 身份行：${line}`)
  return { name: m[1], email: m[2], date: toIso(Number(m[3]), m[4]) }
}

/**
 * 把「本地 HEAD 那个提交」需要的一切读出来。
 * 只读 git 对象，不碰工作区，所以未提交的改动不会被推上去。
 *
 * runGit 可注入：默认就是上面那个 git()，测试时可以换成假的实现，
 * 于是这段解析逻辑不必真的去跑 git 也能被验证。
 */
export function collectFacts(root, branch = '', runGit = git) {
  const head = runGit(['rev-parse', 'HEAD'], root).trim()
  const raw = runGit(['cat-file', 'commit', head], root)
  const sep = raw.indexOf('\n\n')
  if (sep < 0) throw new Error('commit 对象格式异常')

  const headerLines = raw.slice(0, sep).split('\n')
  const pick = (prefix) => {
    const line = headerLines.find((l) => l.startsWith(prefix))
    if (!line) throw new Error(`commit 对象缺少 ${prefix.trim()} 头`)
    return line.slice(prefix.length)
  }

  const tree = pick('tree ')
  const parents = headerLines.filter((l) => l.startsWith('parent ')).map((l) => l.slice(7))
  const author = parsePerson(pick('author '))
  const committer = parsePerson(pick('committer '))
  const message = raw.slice(sep + 2) // 含结尾换行，原样保留

  // 文件清单只来自 git 对象：未跟踪 / 被忽略的文件不会出现
  const changed = runGit(['diff-tree', '--no-commit-id', '--name-only', '-r', '-z', head], root)
    .split('\0')
    .filter(Boolean)

  const treeEntries = new Map()
  for (const line of runGit(['ls-tree', '-r', '-z', head], root).split('\0')) {
    if (!line) continue
    const m = /^(\d+)\s+(\w+)\s+([0-9a-f]+)\t([\s\S]*)$/.exec(line)
    if (m) treeEntries.set(m[4], { mode: m[1], type: m[2], sha: m[3] })
  }

  const blobs = new Map()
  for (const path of changed) {
    const entry = treeEntries.get(path)
    if (!entry) throw new Error(`本地 tree 里找不到 ${path}`)
    blobs.set(entry.sha, runGit(['cat-file', 'blob', entry.sha], root, true))
  }

  const parentTree = parents.length > 0 ? runGit(['rev-parse', `${parents[0]}^{tree}`], root).trim() : null
  const dirty = runGit(['status', '--porcelain'], root).trim()

  const name = branch || runGit(['rev-parse', '--abbrev-ref', 'HEAD'], root).trim()

  return { head, tree, parents, author, committer, message, changed, treeEntries, blobs, parentTree, dirty, branch: name }
}

/** 从 remote URL 里取 owner/name。 */
export function repoFromRemote(url) {
  const m = /github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(String(url).trim())
  return m ? `${m[1]}/${m[2]}` : ''
}

// ---------------------------------------------------------------------------
// GitHub API
// ---------------------------------------------------------------------------

async function api(token, method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'pair-gate-and-clipboard/push-via-api',
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let json
  try {
    json = JSON.parse(text)
  } catch {
    throw new Error(`${method} ${path} -> HTTP ${res.status}，响应不是 JSON：${text.slice(0, 200)}`)
  }
  return { ok: res.ok, status: res.status, json }
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

/**
 * 把 facts 描述的那个提交推到远端。任何一步 SHA 对不上就抛错，且不会改 ref。
 * 拆出来是为了可单独测试（HTTP 部分不依赖 git）。
 */
export async function pushViaApi(facts, opts) {
  const { repo, branch, token, dryRun, force, log = console.log } = opts

  const { ok, status, json: ref } = await api(token, 'GET', `/repos/${repo}/git/ref/heads/${branch}`)
  let remoteSha = null
  if (ok) {
    remoteSha = ref.object.sha
  } else if (status !== 404) {
    throw new Error(`读取远端 ${branch} 失败：HTTP ${status} ${ref.message ?? ''}`)
  }

  const parent = facts.parents[0] ?? null
  const isFastForward = remoteSha === parent
  const isFirstPush = remoteSha === null && facts.parents.length === 0

  log(`仓库        : ${repo}`)
  log(`分支        : ${branch}`)
  log(`本地 HEAD   : ${facts.head}`)
  log(`远端 HEAD   : ${remoteSha ?? '(分支不存在)'}`)
  log(`父提交      : ${parent ?? '(根提交)'}`)
  log(`改动文件    : ${facts.changed.length} 个`)
  for (const path of facts.changed) {
    log(`  ${facts.treeEntries.get(path).mode}  ${facts.blobs.get(facts.treeEntries.get(path).sha).length.toString().padStart(8)} B  ${path}`)
  }
  if (facts.dirty) log(`\n注意：工作区有未提交的改动，它们**不会**被推送（本脚本只推 HEAD）。`)

  if (!isFastForward && !isFirstPush && !force) {
    throw new Error(
      `远端 ${branch} 不在本地 HEAD 的父提交上，这不是快进推送，已中止。\n` +
        `  远端 ${remoteSha}\n  期望 ${parent}\n` +
        `  先 git pull 对齐，或确认要覆盖时加 --force。`,
    )
  }

  if (dryRun) {
    log('\n--dry-run：以上是计划，未在远端创建任何对象。')
    return { dryRun: true }
  }

  // 1) 每个改动文件建 blob（内容取自 git 对象，SHA 必然一致，顺带当校验）
  const entries = []
  for (const path of facts.changed) {
    const entry = facts.treeEntries.get(path)
    const bytes = facts.blobs.get(entry.sha)
    const { ok: bok, json: blob } = await api(token, 'POST', `/repos/${repo}/git/blobs`, {
      content: bytes.toString('base64'),
      encoding: 'base64',
    })
    if (!bok) throw new Error(`建 blob 失败（${path}）：${blob.message ?? ''}`)
    if (blob.sha !== entry.sha) {
      throw new Error(`blob SHA 不一致：本地 ${entry.sha} / 远端 ${blob.sha}（${path}）`)
    }
    entries.push({ path, mode: entry.mode, type: 'blob', sha: entry.sha })
  }
  log(`\nblob        : ${entries.length} 个已就绪（SHA 全部一致）`)

  // 2) 建 tree：以父 tree 为 base，只替换改动项 → 结果应与本地 tree 完全相同
  const treeBody = { tree: entries }
  if (facts.parentTree) treeBody.base_tree = facts.parentTree
  const { ok: tok, json: tree } = await api(token, 'POST', `/repos/${repo}/git/trees`, treeBody)
  if (!tok) throw new Error(`建 tree 失败：${tree.message ?? ''}`)
  if (tree.sha !== facts.tree) {
    throw new Error(`tree SHA 不一致：本地 ${facts.tree} / 远端 ${tree.sha}（已中止，ref 未改动）`)
  }
  log(`tree        : ${tree.sha}（与本地一致）`)

  // 3) 建 commit：精确复刻，SHA 必须与本地 HEAD 相同
  const commitBody = {
    message: facts.message,
    tree: tree.sha,
    parents: facts.parents,
    author: facts.author,
    committer: facts.committer,
  }
  const { ok: cok, json: commit } = await api(token, 'POST', `/repos/${repo}/git/commits`, commitBody)
  if (!cok) throw new Error(`建 commit 失败：${commit.message ?? ''}`)
  if (commit.sha !== facts.head) {
    throw new Error(
      `commit SHA 复刻失败：本地 ${facts.head} / 远端 ${commit.sha}。\n` +
        `  已中止，ref 未改动（远端只多了一个未被引用的悬空对象，无副作用）。`,
    )
  }
  log(`commit      : ${commit.sha}（与本地一致）`)

  // 4) 更新 ref
  const refBody = { sha: commit.sha, force: Boolean(force) }
  const refPath = isFirstPush ? `/repos/${repo}/git/refs` : `/repos/${repo}/git/refs/heads/${branch}`
  const refMethod = isFirstPush ? 'POST' : 'PATCH'
  const { ok: rok, json: refRes } = isFirstPush
    ? await api(token, refMethod, refPath, { ref: `refs/heads/${branch}`, sha: commit.sha })
    : await api(token, refMethod, refPath, refBody)
  if (!rok) throw new Error(`更新 ref 失败：${refRes.message ?? ''}`)

  log(`\n✓ 已推送：https://github.com/${repo}/tree/${branch}`)
  log(`  本地与远端 HEAD 一致：${commit.sha}`)
  return { pushed: true, sha: commit.sha }
}

export async function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv)
  if (opts.help) {
    console.log(USAGE)
    return 0
  }

  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN
  if (!token) {
    console.error('缺少 token：请设置环境变量 GH_TOKEN（或 GITHUB_TOKEN），需要 contents:write 权限。')
    return 2
  }

  const root = opts.root
  const repo =
    opts.repo ||
    repoFromRemote(git(['remote', 'get-url', opts.remote], root))
  if (!repo) {
    console.error(`无法从 remote "${opts.remote}" 的 URL 推断 owner/name，请用 --repo 指定。`)
    return 2
  }

  const facts = collectFacts(root, opts.branch)
  await pushViaApi(facts, {
    repo,
    branch: facts.branch,
    token,
    dryRun: opts.dryRun,
    force: opts.force,
  })
  return 0
}

// 只有直接运行才执行 main；被 import 时不执行（便于测试）
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main()
    .then((code) => process.exit(code ?? 0))
    .catch((error) => {
      console.error(`\n✗ ${error.message}`)
      process.exit(1)
    })
}
