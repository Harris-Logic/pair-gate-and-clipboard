# pair-gate-and-clipboard

两个**独立运行**的局域网服务，搬到你另一台 Windows 11 机器上就能用：

| 服务 | 默认端口 | 干什么 |
| --- | --- | --- |
| **pair-gate**（配对门） | 18080 | 别的机器/手机浏览器打开 `http://<本机任意IP>:18080/`，输一次口令 → 当场签发一个新鲜的 DSH Web 配对链接并 302 跳过去。**不用走过来看这台机器的屏幕**，也不用传链接。 |
| **lan-chat**（手机剪贴板） | 18082 | 手机/别的机器在浏览器里发文本、图片、文件（文件夹走 zip，服务端解包成目录树），每条按时间线写进桌面的 `手机剪贴板.md`。**不经过 agent、不触发模型调用**。 |

两者都是**零 npm 依赖**的纯 Node 脚本（只用 `node:http/crypto/fs/os/path/zlib`），
不需要联网安装任何东西、不需要编译。

> **这不是 DSH 插件。** 它们是普通的常驻服务，自带守护、防火墙规则和计划任务，
> 不会注册进 DSH 的插件系统，也不会出现在插件管理器里。唯一与 DSH 的耦合是：
> 配对门要调一个 DSH Web 的 loopback-only 接口来签发配对链接（见第 4 节）。

---

## 1. 快速开始（新机器上）

前置条件（三条，缺一条就得看第 4 节）：

1. **Node.js ≥ 18**（本机实测 Node 20/22 都行）
2. 那台机器上 **DSH 已安装且 `dsh web` 在跑**（配对门的签发接口是本机回环上的 DSH Web 插件提供的）
3. DSH 里装了 **`@linxin666/dsh-remote-web-ui`** 插件并把 `lanBind` 设为 true（否则没有可签发的 LAN 地址）

然后：把整个仓库目录拷到新机器，运行

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1
```

> 脚本会自动定位源码树（`$PSScriptRoot` → 父目录 → 祖父目录，以 `services\pair-gate\gate.mjs`
> 为判定）。如果你的目录结构比较特殊，用 `-Source <仓库路径>` 显式指定即可。
> 注意 `install.ps1` 已被复制到 `scripts\` 下时也能直接运行（会自动往上一层找）。

安装脚本会做 7 件事（幂等，重复运行安全）：

1. 检查 Node.js 与 DSH 位置
2. 复制 `services\` `scripts\` 到安装目录（默认 `%LOCALAPPDATA%\pair-gate-and-clipboard`）
3. 生成 `config\*.json`：桌面落盘路径按**当前用户**自动推导，口令/端口沿用已有配置（首次 18080/18082、口令 `0322`）
4. 给 DSH Web 打鉴权补丁（**换 IP / 重启后仍然免配对**的前提，见第 4 节）
5. 加防火墙规则（TCP，远端范围 `LocalSubnet`，`Profile Any` —— 热点/咖啡厅也能用）
6. 注册计划任务：**开机自启** + **每天补打一次鉴权补丁**（DSH 升级会覆盖补丁文件）
7. 立刻拉起服务并跑自检

装完看现场信息 / 自检：

```powershell
powershell -File "$env:LOCALAPPDATA\pair-gate-and-clipboard\scripts\supervisor.ps1" -Info
powershell -File "$env:LOCALAPPDATA\pair-gate-and-clipboard\scripts\doctor.ps1"
```

---

## 2. 任意本机 IP 都能用（这是本次搬迁的核心修正）

老版本的门把签发地址**写死**成一个局域网 IP（例如 `192.168.5.55`），换网络或换机器后，
门会给客户端签出一个**客户端根本连不上的地址**（实测确实发生过：客户端从另一张网卡进来，
门却按旧 IP 签发）。

现在的默认行为（`address` 留空）：

* 客户端**用哪个本机 IP 访问门，门就拿哪个 IP 去签发**对应链接 —— 于是本机每张网卡的
  地址都能用，DHCP 换地址、换 WiFi、换热点都不用改配置。
* Host 头只是"候选"：签发接口本身对地址做白名单校验（只接受**本机当前网卡**的 IP），
  不合法就自动退回插件默认地址，不会 503、也不会签出指向外部的链接。
* 需要固定行为时，把 `config\pair-gate.config.json` 的 `address` 填上即可（填了优先用配置值）。

---

## 3. 文件布局

```
pair-gate-and-clipboard\
├─ install.ps1                     一键安装/卸载（-Uninstall）
├─ config\
│   ├─ pair-gate.config.example.json   模板（安装时生成实际配置，不覆盖你改过的口令）
│   └─ chat.config.example.json
├─ services\
│   ├─ pair-gate\gate.mjs          配对门（零依赖）
│   └─ lan-chat\chat.mjs + ui.html 剪贴板通道（零依赖）
├─ scripts\
│   ├─ supervisor.ps1              守护/自启（幂等拉起 + 15s 巡检自愈 + -Info/-Stop/-Once）
│   ├─ doctor.ps1                  只读自检（端口/签发接口/补丁/防火墙/守护/任务）
│   └─ dsh-web-auth-patch.ps1      DSH Web 鉴权补丁（幂等，失败自动还原）
└─ LICENSE
```

安装后的目录会多出 `state\`（消息真相源 + 门的签发状态）、`logs\`、`run\`（PID）。

---

## 4. 硬依赖与「无损」的边界（诚实说明）

| 事项 | 说明 |
| --- | --- |
| DSH Web 必须在本机跑 | 配对门唯一的功能耦合：调 `POST http://127.0.0.1:<webPort>/api/pair/issue` 取链接。该接口是 loopback-only，门是唯一对外的签发代理。端口用 `webPort` 指定，写 0 则自动用 `dsh web --dump-config` 探测，最后退回 3080。 |
| 必须装 `dsh-remote-web-ui` | 提供上面的签发接口和"本机 LAN 地址白名单"。没装 → 门能起，但签发会失败（自检会明确报出来）。 |
| 必须打 DSH Web 鉴权补丁 | 否则：上游每个进程用随机 token（DSH 一重启所有链接失效）、cookie 名绑定 Host 地址（换个 IP 就要重新配对）、监听是纯 IPv4（`.local` 解析出 AAAA 的客户端报 `ERR_EMPTY_RESPONSE`）。补丁是**幂等精确字符串替换**，改前备份 `.dsh-auth-patch.bak`，改后用 `node --check` 校验，失败自动还原。 |
| 每次 `npm i -g @deepseek-ai/dsh` 会冲掉补丁 | 所以安装脚本注册了每日自动补打任务；也能随时手跑 `scripts\dsh-web-auth-patch.ps1`。 |
| 防火墙 | 安装脚本加规则（需要一次管理员/UAC）。不加规则 → 本机能访问，别的机器连不上。 |
| 明文 HTTP | 局域网内明文（口令鉴权 12 小时 cookie + 失败按 IP 限速封禁）。要加密走 SSH 隧道。 |

---

## 5. 配置

`config\pair-gate.config.json`

| 字段 | 默认 | 含义 |
| --- | --- | --- |
| `port` | 18080 | 门监听端口（防火墙按这个放行） |
| `webPort` | 0 | 本机 DSH Web 端口；0 = 自动探测；探测不到用 3080 |
| `address` | `""` | 空 = 按访问方用的本机 IP 当场签发（推荐）；填了 = 固定用它 |
| `password` | `0322` | 进门口令（失败限速：15 分钟 5 次封 15 分钟） |

`config\chat.config.json`

| 字段 | 默认 | 含义 |
| --- | --- | --- |
| `port` | 18082 | 监听端口 |
| `password` | `0322` | 进入口令 |
| `desktopMd` / `assetsDir` | 安装时按当前用户桌面推导 | 时间线 Markdown 与附件目录（同级） |
| `dataDir` | `<安装目录>\state\lan-chat` | 消息真相源（`.md` 由它原子重建） |
| `maxFileMB` / `maxRequestMB` | `0` / `0`（不限） | 单文件 / 单请求上限（MB）。**写 0 = 不限** |
| `maxZipEntries` / `maxZipTotalMB` | `0` / `0`（不限） | zip 炸弹防护。同样 0 = 不限 |
| `mdOrder` | `newest-first` | 或 `oldest-first` |

> 上限写成 `0`（或 `null` / `"unlimited"`）即该项不限。单文件与单次传输走**流式落盘**
> （边收边写临时文件、完成后原子改名），所以"不限"不会撑爆内存，实际只受目标盘剩余空间约束；
> 落盘前会预检磁盘余量，空间不够会立刻返回明确错误，而不是传到一半失败。
> 唯一的例外是 zip（文件夹上传）：解包要整份读进内存，服务端硬阈值 1 GB，超过会提示改用
> 「直接发文件」或分卷压缩后当普通文件发。

环境变量可覆盖：`PAIR_GATE_CONFIG` `PAIR_GATE_DATA_DIR` `PAIR_GATE_PORT` `PAIR_GATE_WEB_PORT`
`PAIR_GATE_ADDRESS` `PAIR_GATE_PASSWORD` / `LANCHAT_CONFIG` `LANCHAT_PORT` `LANCHAT_PASSWORD`。

**改完配置要重启服务**（`supervisor.ps1 -Stop` 后重跑守护，或重启机器）。

---

## 6. 日常运维

```powershell
$svc = "$env:LOCALAPPDATA\pair-gate-and-clipboard\scripts\supervisor.ps1"

powershell -File $svc -Info          # 现场信息：所有入口地址 + 口令 + 端口状态 + 守护状态
powershell -File $svc -Once          # 只拉一次（不用常驻守护时）
powershell -File $svc -Stop          # 停掉两个服务
powershell -File $svc -HealthCheck   # 探针模式（退出码 0=都在跑）

Get-Content "$env:LOCALAPPDATA\pair-gate-and-clipboard\logs\supervisor.log" -Tail 30
Get-Content "$env:LOCALAPPDATA\pair-gate-and-clipboard\logs\pair-gate.log"  -Tail 30
```

卸载：

```powershell
powershell -File install.ps1 -Uninstall           # 停服务、删任务、删防火墙规则
powershell -File install.ps1 -Uninstall -Force    # 连安装目录一起删
```

---

## 7. 本机（旧机）切到这套包的可选步骤

本机现在这两个服务仍由 `~\.dsh\dsh-web-autostart.ps1` 拉起（旧写法：地址写死、无自愈）。
想让本机也用上这套（Host 派生签发 + 守护自愈），需要先摘掉旧的启动块，否则两边抢同一个端口：

1. `install.ps1`（生成配置、加规则、注册任务、起守护）
2. 在 `~\.dsh\dsh-web-autostart.ps1` 里删掉 `pair-gate` / `lan-chat` 两段启动块
3. 停掉旧进程（`Get-NetTCPConnection -LocalPort 18080,18082 -State Listen` 取 PID 后 `Stop-Process`）
4. 重跑 `install.ps1`，再 `doctor.ps1` 确认

> 这套包**不会**自己动那个旧脚本；第 2 步必须人工确认。

---

## 8. 故障排查

| 现象 | 先查什么 |
| --- | --- |
| 别的机器打不开 18080/18082 | `doctor.ps1` → 端口是否在听、防火墙规则是否在。**本机能开≠局域网能开**。 |
| 打不开口令页但端口在听 | 防火墙 `RemoteAddress` 是否是 `LocalSubnet`、`Profile` 是否是 `Any`（Public 网络下 `Private` 规则不生效）。 |
| 输了口令但跳转后要求重新配对 | 鉴权补丁没打上：跑 `scripts\dsh-web-auth-patch.ps1`，再重启 `dsh web`。 |
| 门返回 503 `issue failed` | DSH Web 没跑 / 没装 `dsh-remote-web-ui` / `webPort` 配错。用 `doctor.ps1` 第 4 节看。 |
| `.local` 名字打不开、IP 能开 | 双栈补丁没打（客户端拿到 AAAA 却连不上），或客户端没有 mDNS 解析。 |
| 换网络后入口变了 | 正常的：用 `supervisor.ps1 -Info` 查当前所有 IP。门和剪贴板都绑 `0.0.0.0`，不写死地址。 |
| 服务莫名停了 | 守护进程应 15s 内拉起。看 `logs\supervisor.log`；守护也没跑就是计划任务没注册上。 |

---

## 9. 安全模型

* 口令鉴权：浏览器 12 小时会话 cookie；脚本可用 HTTP Basic；失败按来源 IP 限速（15 分钟 5 次封 15 分钟）。日志**从不记口令**。
* 配对 token 只在本机回环内存里生成，门是唯一对外签发代理；门签出的链接 10 分钟过期，但门本身"每次打开现签"，所以永远新鲜。
* lan-chat：单文件/单请求/解包总量/条目数上限（可由配置调整，`0` = 不限），文件名消毒，解包路径强制校验在 `assetsDir` 内，附件目录无索引，非图片强制 `attachment` 下载。
* lan-chat 的大文件路径：上传流式落盘（不整份进内存），落盘前预检磁盘余量，下载走流式并支持 `Range` 续传；`server.requestTimeout` 已关闭，避免长传输被 Node 默认 300 秒掐断。临时分片在传输中断/崩溃后由下一次启动清理。
* 已知取舍：明文 HTTP（局域网）；口令明文存在配置里（4 位数字属"够用就好"级；要更严就换长口令 + 收窄防火墙到单机 IP + 走 SSH 隧道）。

---

## License

MIT
