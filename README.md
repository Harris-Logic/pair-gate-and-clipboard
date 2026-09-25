# pair-gate-and-clipboard

Two **standalone** LAN services for Windows. Copy them to another Windows 11 machine and they work —
no npm dependencies, no build step (plain Node, `node:http/crypto/fs/os/path/zlib` only).

> **Not a DSH plugin.** These are ordinary background services with their own supervisor, firewall
> rules and scheduled tasks. They do not register themselves into DSH's plugin system and do not
> appear in the plugin manager. The only DSH coupling is that `pair-gate` calls a loopback-only DSH
> Web endpoint to mint pairing links (see [Hard dependencies](#hard-dependencies)).

[中文说明 → README.zh.md](README.zh.md)

| Service | Default port | What it does |
| --- | --- | --- |
| **pair-gate** | 18080 | A phone or another machine opens `http://<any-local-IP>:18080/`, types the password once, and is immediately redirected into DSH Web via a freshly minted pairing link. No walking over to read a 10-minute token off the laptop, and no link to copy around. |
| **lan-chat** | 18082 | Phones / other machines push text, images and files (folders as zip, unpacked server-side) through a password-gated chat page; every message is appended to a timeline Markdown file on the Desktop. It never goes through the agent and never triggers a model call. |

## Quick start

Prerequisites (see [Dependencies](#hard-dependencies) below):

1. **Node.js >= 18**
2. **DSH installed and `dsh web` running** on that machine (the gate mints links through a loopback-only DSH Web endpoint)
3. The **`@linxin666/dsh-remote-web-ui`** plugin installed in DSH, with `lanBind` enabled

Then, from the repository root:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1
```

`install.ps1` is idempotent and:

1. checks Node.js and locates DSH
2. copies `services\` and `scripts\` to `%LOCALAPPDATA%\pair-gate-and-clipboard`
3. writes `config\*.json` — desktop paths derived from the *current* user, ports/password preserved from any existing config (first run: ports 18080/18082, password **randomly generated** and printed)
4. applies the DSH Web auth patch (required for "works from any IP, survives restarts")
5. adds firewall rules (TCP, `LocalSubnet`, `Profile Any`)
6. registers scheduled tasks: **start at boot** + **re-apply the auth patch daily** (a DSH upgrade overwrites it)
7. starts the services and runs a self-check

```powershell
powershell -File "$env:LOCALAPPDATA\pair-gate-and-clipboard\scripts\supervisor.ps1" -Info
powershell -File "$env:LOCALAPPDATA\pair-gate-and-clipboard\scripts\doctor.ps1"
```

## Works from any local IP

The old gate had the signing address **hardcoded** to one LAN IP, so after moving networks or machines
it handed clients a link they could not reach (observed in practice: the client arrived on one NIC while
the gate signed for a stale address).

Now (`address` left empty) the gate **signs per request, using the IP the client actually reached it on** —
every NIC address works, and a DHCP change needs no config edit. The `Host` header is only a candidate:
the issue endpoint whitelists real local interface addresses, and anything else falls back to the plugin
default, so a spoofed Host cannot make the gate hand out a link pointing elsewhere.

## Hard dependencies

| Item | Why |
| --- | --- |
| `dsh web` running locally | The gate calls `POST http://127.0.0.1:<webPort>/api/pair/issue` (loopback-only). Set `webPort` explicitly, or leave 0 to auto-detect via `dsh web --dump-config` (falls back to 3080). |
| `dsh-remote-web-ui` plugin | Provides that issue endpoint and the local-address allowlist. |
| DSH Web auth patch | Upstream mints a random `?token=` per process (every DSH restart invalidates links), binds the auth cookie name to the request authority (a new IP means re-pairing), and listens IPv4-only (`.local` clients that resolve AAAA get `ERR_EMPTY_RESPONSE`). The patch is six idempotent exact-string replacements, backed up before editing and verified with `node --check`. |
| Firewall rules | Without them the services are reachable only from the machine itself. Adding them needs one elevation prompt. |

Re-apply `scripts\dsh-web-auth-patch.ps1` after any `npm i -g @deepseek-ai/dsh`; the installer registers
a daily task for that.

## Operations

```powershell
$svc = "$env:LOCALAPPDATA\pair-gate-and-clipboard\scripts\supervisor.ps1"
powershell -File $svc -Info        # every entry URL, password, port + daemon status
powershell -File $svc -Once        # start once, do not supervise
powershell -File $svc -Stop        # stop both services
powershell -File install.ps1 -Uninstall [-Force]
```

The supervisor starts the services idempotently and re-checks every 15 seconds, so a crashed service
comes back on its own. Logs live in `<install>\logs\`, runtime state in `<install>\state\` and `run\`.

### Pushing when git transport is blocked (`scripts\push-via-api.mjs`)

On some networks `git push` gets cut off mid-handshake (`CONNECT tunnel failed, response 502`, reset
TLS) while `api.github.com` stays reachable. This script moves the local commit over the GitHub Git
Data API instead:

```powershell
$env:GH_TOKEN = '<PAT with contents:write>'
node scripts\push-via-api.mjs --dry-run   # show the plan, create nothing on the remote
node scripts\push-via-api.mjs             # push for real
```

It pushes **the commit that HEAD already points at**. Git objects are content-addressed, so if
parent / tree / message / author / committer all match, the remote derives exactly the same SHA —
afterwards the two sides are still in sync and a normal `git push` keeps working (no divergence).

Deliberate constraints:

* The file list comes only from git objects (`git ls-tree` / `git diff-tree`), so untracked and
  `.gitignore`d files — e.g. `config\chat.config.json`, which holds the password — are never uploaded.
* Every step verifies its SHA (blob / tree / commit) and aborts **before** touching the ref if anything
  mismatches; the remote may be left with a few unreferenced dangling objects at most.
* Fast-forward is required by default (the remote must sit exactly on the local parent); a
  non-fast-forward fails loudly. Overriding takes an explicit `--force`.
* The token is read from `GH_TOKEN` / `GITHUB_TOKEN` only, never written to disk.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Another machine cannot reach 18080/18082 | `doctor.ps1`: is the port listening, is the firewall rule present? Working on the local machine does not imply LAN reachability. |
| Login page unreachable although the port listens | Firewall `RemoteAddress` must be `LocalSubnet` and `Profile` must be `Any` (a `Private`-only rule does not apply on a Public network such as a phone hotspot). |
| Password accepted but pairing is requested again | Auth patch missing: run `scripts\dsh-web-auth-patch.ps1`, then restart `dsh web`. |
| Gate returns 503 `issue failed` | DSH Web not running, plugin missing, or wrong `webPort`. See section 4 of `doctor.ps1`. |
| A `.local` name fails while the IP works | Dual-stack patch missing, or the client has no mDNS resolver. |
| Entry address changed after switching networks | Expected: run `supervisor.ps1 -Info`. Both services bind `0.0.0.0` and never hardcode an address. |

## Security model

* Password auth: 12-hour browser session cookie, HTTP Basic for scripts, per-IP rate limiting
  (5 failures in 15 minutes blocks for 15 minutes). Passwords are never logged.
* Pairing tokens are minted in loopback memory only; the gate is the single outward-facing issuer,
  and each page load mints a fresh 10-minute link.
* lan-chat enforces per-file / per-request / unpack-total / entry-count limits, sanitizes file names,
  verifies unpacked paths stay inside `assetsDir`, exposes no directory index, and forces non-image
  downloads to `attachment`.
* Known trade-offs: plain HTTP on the LAN, and the password is stored in clear text in the config.
  A fresh install gets a **randomly generated 8-character password**; the repo ships no usable default
  (the example configs carry the placeholder `CHANGE-ME`). Use a longer password, narrow the firewall
  rule and/or an SSH tunnel if you need more.

## License

MIT
