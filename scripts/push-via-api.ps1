# push-via-api.ps1 — 用 GitHub Git Data API 推送本地提交（不依赖 git 传输层）
#
# 场景：这台机器上 git-over-HTTPS 连 github.com:443 不稳定（时而 Connection was reset /
# Could not connect），但 api.github.com 正常。本脚本把工作区的所有文件作为一次提交
# 推到指定分支，效果等价于 git push（**注意：只推工作区当前内容为单个提交，不保留本地
# 多提交历史**）。
#
# 用法
#   $env:GH_TOKEN = '<classic PAT with repo scope>'
#   powershell -File push-via-api.ps1 -Repo Harris-Logic/pair-gate-and-clipboard -Root . -Branch main
#
# 说明
#   * token 只从环境变量读，不写进任何文件。
#   * 每个文件先建 blob（UTF-8 原字节 base64），再建 tree（保留目录结构），
#     然后 commit（父提交取远端当前 HEAD，首次推送无父），最后强制更新 ref。
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Repo,       # owner/name
    [string]$Root = '.',
    [string]$Branch = 'main',
    [string]$Message = '',
    [string]$Token = ''
)

$ErrorActionPreference = 'Stop'
if (-not $Token) { $Token = $env:GH_TOKEN }
if (-not $Token) { throw 'no token: set $env:GH_TOKEN or pass -Token' }

$Root = (Resolve-Path -LiteralPath $Root).Path
$api = 'https://api.github.com'
$headers = @{
    Authorization          = "Bearer $Token"
    'User-Agent'           = 'push-via-api'
    Accept                 = 'application/vnd.github+json'
    'X-GitHub-Api-Version' = '2022-11-28'
}

function Invoke-Api {
    param([string]$Method, [string]$Path, $Body)
    $uri = "$api$Path"
    $params = @{ Method = $Method; Uri = $uri; Headers = $headers; TimeoutSec = 60 }
    if ($Body -ne $null) {
        $params.Body = ($Body | ConvertTo-Json -Depth 20 -Compress)
        $params.ContentType = 'application/json'
    }
    return Invoke-RestMethod @params
}

# 上传的文件集合（排除 VCS 与运行期产物）
$exclude = @('.git', 'state', 'logs', 'run', 'node_modules')
$files = Get-ChildItem -LiteralPath $Root -Recurse -File -Force | Where-Object {
    $rel = $_.FullName.Substring($Root.Length).TrimStart('\')
    $top = ($rel -split '\\')[0]
    $exclude -notcontains $top
}

Write-Host ("repo   : {0}" -f $Repo)
Write-Host ("root   : {0}" -f $Root)
Write-Host ("files  : {0}" -f $files.Count)

# 1) 远端当前分支 HEAD（首次推送时不存在）
$parentSha = $null
try {
    $ref = Invoke-Api -Method Get -Path "/repos/$Repo/git/ref/heads/$Branch"
    $parentSha = $ref.object.sha
    Write-Host ("parent : {0}" -f $parentSha)
} catch {
    Write-Host 'parent : (无，首次推送)'
}

# 2) 每个文件建 blob
$entries = @()
foreach ($f in $files) {
    $rel = $f.FullName.Substring($Root.Length).TrimStart('\').Replace('\', '/')
    $bytes = [IO.File]::ReadAllBytes($f.FullName)
    $blob = Invoke-Api -Method Post -Path "/repos/$Repo/git/blobs" -Body @{
        content  = [Convert]::ToBase64String($bytes)
        encoding = 'base64'
    }
    $entries += @{ path = $rel; mode = '100644'; type = 'blob'; sha = $blob.sha }
    Write-Host ("  blob  {0,-46} {1}" -f $rel, $blob.sha.Substring(0, 8))
}

# 3) 建 tree
$tree = Invoke-Api -Method Post -Path "/repos/$Repo/git/trees" -Body @{ tree = $entries }
Write-Host ("tree   : {0}" -f $tree.sha)

# 4) 建 commit
if (-not $Message) { $Message = "push via API: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')" }
$commitBody = @{ message = $Message; tree = $tree.sha }
if ($parentSha) { $commitBody.parents = @($parentSha) }
$commit = Invoke-Api -Method Post -Path "/repos/$Repo/git/commits" -Body $commitBody
Write-Host ("commit : {0}" -f $commit.sha)

# 5) 更新/创建 ref
if ($parentSha) {
    Invoke-Api -Method Patch -Path "/repos/$Repo/git/refs/heads/$Branch" -Body @{ sha = $commit.sha; force = $true } | Out-Null
    Write-Host 'ref    : 已更新'
} else {
    Invoke-Api -Method Post -Path "/repos/$Repo/git/refs" -Body @{ ref = "refs/heads/$Branch"; sha = $commit.sha } | Out-Null
    Write-Host 'ref    : 已创建'
}
Write-Host ("`n完成：https://github.com/{0}/tree/{1}" -f $Repo, $Branch)
