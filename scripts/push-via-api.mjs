#!/usr/bin/env node
/**
 * push-via-api.mjs — git 传输层不通时的兜底推送（走 GitHub Git Data API）。
 *
 * 为什么需要它
 *   某些网络里 git-over-HTTPS 会被中间设备掐断（CONNECT 502、TLS 握手被重置），
 *   但 api.github.com 仍然可达。本脚本把**本地已经存在的那些提交**原样搬到远端，
 *   效果等价于 git push。
 *
 * 与旧版 scripts/push-via-api.ps1 的区别（旧版做法有问题，已删除）
 *   1. 旧版把工作区文件重新打成一个提交，**丢掉本地提交历史**，于是本地与远端分叉，
 *      之后正常 git push 必然冲突。本脚本逐个复刻本地已有的提交（含它们之间的父子
 *      关系）：git 对象是内容寻址的，只要 parent / tree / message / author / committer
 *      完全一致，远端算出来的 SHA 就与本地一模一样 —— 推完两边仍然同步，
 *      可以直接继续用 git push。
 *   2. 旧版按「目录扫描 + 硬编码排除名单」挑文件，**不看 .gitignore**，
 *      会把 config\chat.config.json（含口令）这类未跟踪文件一起传上去。
 *      本脚本的文件清单只来自 git 对象（git ls-tree / git diff），
 *      未跟踪与被忽略的文件天然不在其中。
 *   3. 旧版更新 ref 时写死 force=true，会静默覆盖远端提交。本脚本默认要求**快进**
 *      （远端提交必须是本地 HEAD 的祖先），不满足就报错退出；确实要覆盖得显式 --force。
 *   4. 旧版不做校验。本脚本每个提交都比对 SHA（blob / tree / commit），
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
 * 限制
 *   远端如果有本地没有的提交（远端领先、或历史被改写过），本脚本无法工作 ——
 *   它只能搬本地已有的对象。这种情况请先用别的方式 git fetch。
 *
 * token 只从环境变量 GH_TOKEN / GITHUB_TOKEN 读取，绝不写进任何文件。
 */
import { execFileSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const API = 'https://api.github.com'
const HERE = dirname(fileURLToPath(import.meta.url))
/** 空 tree 的 SHA —— 给根提交做 diff 时的基线。 */
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'

// ---------------------------------------------------------------------------
// 命令行
// ---------------------------------------------------------------------------

const USAGE = `用法：node scripts/push-via-api.mjs [选项]

  --repo <owner/name>   默认从 remote 的 URL 推断
  --remote <name>       默认 origin
  --branch <name>       默认当前分支
  --root <dir>          仓库根目录，默认脚本所在目录的上一级
  --dry-run             只检查并打印将要发生的事，不在远端创建任何对象
  --force               允许非快进（覆盖远端提交），谨慎使用

token 从环境变量 GH_TOKEN 或 GITHUB_TOKEN 读取。`

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

/** 只问「行不行」、不要输出的场合用它。 */
function gitOk(args, cwd, runGit = git) {
  try {
    runGit(args, cwd)
    return true
  } catch {
    return false
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
 * 读出一个提交在推送时需要的全部信息。只读 git 对象，不碰工作区，
 * 所以未提交的改动不会被推上去。
 *
 * runGit 可注入（默认就是上面那个 git()），测试时可以换成假实现，
 * 于是这段解析逻辑不必真的执行 git 也能被验证。
 */
export function collectCommit(root, sha, runGit = git) {
  const raw = runGit(['cat-file', 'commit', sha], root)
  const sep = raw.indexOf('\n\n')
  if (sep < 0) throw new Error(`commit ${sha} 的对象格式异常`)

  const headerLines = raw.slice(0, sep).split('\n')
  const pick = (prefix) => {
    const line = headerLines.find((l) => l.startsWith(prefix))
    if (!line) throw new Error(`commit ${sha} 缺少 ${prefix.trim()} 头`)
    return line.slice(prefix.length)
  }

  const tree = pick('tree ')
  const parents = headerLines.filter((l) => l.startsWith('parent ')).map((l) => l.slice(7))
  const author = parsePerson(pick('author '))
  const committer = parsePerson(pick('committer '))
  const message = raw.slice(sep + 2) // 含结尾换行，原样保留

  // base_tree 取第一个父提交的 tree（根提交则没有），配合下面的 changed 增量建树，
  // 结果 tree 的 SHA 必然等于本地这个提交的 tree。
  const baseTree = parents.length > 0 ? runGit(['rev-parse', `${parents[0]}^{tree}`], root).trim() : null

  // 文件清单只来自 git 对象：未跟踪 / 被忽略的文件不会出现。
  // --no-renames：改名按「删+增」处理，正是建树需要的语义。
  const changed = runGit(['diff', '--name-only', '-z', '--no-renames', baseTree ?? EMPTY_TREE, sha], root)
    .split('\0')
    .filter(Boolean)

  const treeEntries = new Map()
  for (const line of runGit(['ls-tree', '-r', '-z', sha], root).split('\0')) {
    if (!line) continue
    const m = /^(\d+)\s+(\w+)\s+([0-9a-f]+)\t([\s\S]*)$/.exec(line)
    if (m) treeEntries.set(m[4], { mode: m[1], type: m[2], sha: m[3] })
  }

  // 建树时要提交的条目。三种情况：
  //   普通文件 → 上传 blob
  //   子模块等非 blob 条目 → 直接把 SHA 交给 API，不需要上传内容
  //   本提交删掉的文件 → 用 sha=null 让 API 从 base_tree 里删掉同名条目
  const entries = []
  const blobs = new Map()
  for (const path of changed) {
    const entry = treeEntries.get(path)
    if (!entry) {
      entries.push({ path, mode: '100644', type: 'blob', sha: null })
      continue
    }
    if (entry.type !== 'blob') {
      entries.push({ path, mode: entry.mode, type: entry.type, sha: entry.sha })
      continue
    }
    blobs.set(entry.sha, runGit(['cat-file', 'blob', entry.sha], root, true))
    entries.push({ path, mode: entry.mode, type: 'blob', sha: entry.sha })
  }

  return { sha, tree, parents, author, committer, message, changed, entries, blobs, baseTree }
}

/**
 * 取「远端还没有、本地有」的那串提交，由旧到新。
 * fromSha 为 null 表示远端还没有这个分支 → 从根提交开始，整条链都要发。
 */
export function collectChain(root, fromSha, toSha, runGit = git) {
  const range = fromSha ? `${fromSha}..${toSha}` : toSha
  const shas = runGit(['rev-list', '--reverse', range], root)
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
  if (shas.length === 0) throw new Error('没有需要推送的提交（本地与远端已经一致）')
  return shas.map((s) => collectCommit(root, s, runGit))
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

/** 远端分支当前指向哪个提交；分支不存在返回 null。 */
export async function fetchRemoteSha(token, repo, branch) {
  const { ok, status, json } = await api(token, 'GET', `/repos/${repo}/git/ref/heads/${branch}`)
  if (ok) return json.object.sha
  if (status === 404) return null
  throw new Error(`读取远端 ${branch} 失败：HTTP ${status} ${json.message ?? ''}`)
}

/** 把单个提交复刻到远端，返回远端算出的 SHA（必须与本地一致）。 */
async function replicateCommit(commit, repo, token) {
  const entries = []
  for (const entry of commit.entries) {
    if (entry.sha === null || entry.type !== 'blob') {
      // 删除（sha=null）或子模块等非 blob 条目：原样交给 API
      entries.push(entry)
      continue
    }
    const bytes = commit.blobs.get(entry.sha)
    const { ok, json } = await api(token, 'POST', `/repos/${repo}/git/blobs`, {
      content: bytes.toString('base64'),
      encoding: 'base64',
    })
    if (!ok) throw new Error(`建 blob 失败（${entry.path}）：${json.message ?? ''}`)
    if (json.sha !== entry.sha) {
      throw new Error(`blob SHA 不一致：本地 ${entry.sha} / 远端 ${json.sha}（${entry.path}）`)
    }
    entries.push({ path: entry.path, mode: entry.mode, type: 'blob', sha: entry.sha })
  }

  const treeBody = { tree: entries }
  if (commit.baseTree) treeBody.base_tree = commit.baseTree
  const { ok: tok, json: tree } = await api(token, 'POST', `/repos/${repo}/git/trees`, treeBody)
  if (!tok) throw new Error(`建 tree 失败（${commit.sha.slice(0, 10)}）：${tree.message ?? ''}`)
  if (tree.sha !== commit.tree) {
    throw new Error(
      `tree SHA 不一致（提交 ${commit.sha.slice(0, 10)}）：本地 ${commit.tree} / 远端 ${tree.sha}。已中止，ref 未改动。`,
    )
  }

  const { ok: cok, json: made } = await api(token, 'POST', `/repos/${repo}/git/commits`, {
    message: commit.message,
    tree: tree.sha,
    parents: commit.parents,
    author: commit.author,
    committer: commit.committer,
  })
  if (!cok) throw new Error(`建 commit 失败（${commit.sha.slice(0, 10)}）：${made.message ?? ''}`)
  if (made.sha !== commit.sha) {
    throw new Error(
      `commit SHA 复刻失败：本地 ${commit.sha} / 远端 ${made.sha}。已中止，ref 未改动` +
        `（远端只多了未被引用的悬空对象，无副作用）。`,
    )
  }
  return made.sha
}

/**
 * 把 chain（由旧到新的一串提交）推到远端。
 * 任何一步 SHA 对不上都会在改 ref 之前抛错。
 */
export async function pushViaApi(chain, opts) {
  const { repo, branch, token, remoteSha, dryRun, force, log = console.log } = opts
  const target = chain[chain.length - 1]
  const firstBase = chain[0].parents[0] ?? null

  log(`仓库        : ${repo}`)
  log(`分支        : ${branch}`)
  log(`远端 HEAD   : ${remoteSha ?? '(分支不存在)'}`)
  log(`本地 HEAD   : ${target.sha}`)
  log(`待推送提交  : ${chain.length} 个`)
  for (const c of chain) {
    log(`  ${c.sha.slice(0, 10)}  ${String(c.changed.length).padStart(2)} 个文件  ${c.message.split('\n')[0]}`)
  }

  if (firstBase !== remoteSha && !force) {
    throw new Error(
      `提交链与远端对不上，这不是快进推送，已中止。\n` +
        `  远端 ${remoteSha ?? '(分支不存在)'}\n  链首 ${chain[0].sha.slice(0, 10)} 的父提交 ${firstBase ?? '(根提交)'}\n` +
        `  先 git fetch/pull 对齐，或确认要覆盖时加 --force。`,
    )
  }

  if (dryRun) {
    log('\n--dry-run：以上是计划，未在远端创建任何对象。')
    return { dryRun: true }
  }

  // 复刻期间远端可能被人挪动，改 ref 前再确认一次
  const nowSha = await fetchRemoteSha(token, repo, branch)
  if (nowSha !== remoteSha) {
    throw new Error(`远端 ${branch} 在准备期间被改动（${remoteSha ?? '空'} → ${nowSha ?? '空'}），已中止。`)
  }

  for (const c of chain) {
    await replicateCommit(c, repo, token)
    log(`  ✓ ${c.sha.slice(0, 10)}  ${c.message.split('\n')[0]}`)
  }

  const refPath = `/repos/${repo}/git/refs/heads/${branch}`
  const { ok, json } = remoteSha === null
    ? await api(token, 'POST', `/repos/${repo}/git/refs`, { ref: `refs/heads/${branch}`, sha: target.sha })
    : await api(token, 'PATCH', refPath, { sha: target.sha, force: Boolean(force) })
  if (!ok) throw new Error(`更新 ref 失败：${json.message ?? ''}`)

  log(`\n✓ 已推送：https://github.com/${repo}/tree/${branch}`)
  log(`  本地与远端 HEAD 一致：${target.sha}`)
  return { pushed: true, sha: target.sha }
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

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
  const repo = opts.repo || repoFromRemote(git(['remote', 'get-url', opts.remote], root))
  if (!repo) {
    console.error(`无法从 remote "${opts.remote}" 的 URL 推断 owner/name，请用 --repo 指定。`)
    return 2
  }

  const branch = opts.branch || git(['rev-parse', '--abbrev-ref', 'HEAD'], root).trim()
  const headSha = git(['rev-parse', 'HEAD'], root).trim()
  const dirty = git(['status', '--porcelain'], root).trim()
  if (dirty) {
    console.log('注意：工作区有未提交的改动，它们**不会**被推送（本脚本只推已提交的 HEAD）。\n')
  }

  const remoteSha = await fetchRemoteSha(token, repo, branch)
  if (remoteSha !== null) {
    if (!gitOk(['cat-file', '-e', `${remoteSha}^{commit}`], root)) {
      throw new Error(
        `远端 ${branch} 指向 ${remoteSha}，本地没有这个提交（远端领先或历史被改写过）。\n` +
          `  本脚本只能搬本地已有的对象，这种情况请先用别的方式 git fetch。`,
      )
    }
    if (!gitOk(['merge-base', '--is-ancestor', remoteSha, headSha], root) && !opts.force) {
      throw new Error(
        `远端 ${branch} 不是本地 HEAD 的祖先，这不是快进推送，已中止。\n` +
          `  远端 ${remoteSha}\n  本地 ${headSha}\n` +
          `  先 git fetch/pull 对齐，或确认要覆盖时加 --force。`,
      )
    }
  }

  const chain = collectChain(root, remoteSha, headSha)
  await pushViaApi(chain, {
    repo,
    branch,
    token,
    remoteSha,
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
