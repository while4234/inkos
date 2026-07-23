# InkOS 本地开发与上游同步

## 仓库结构

| 名称 | 作用 |
| --- | --- |
| `origin` | `while4234/inkos`，保存个人定制代码 |
| `upstream` | `Narcooo/inkos`，只读且只跟踪 `master` |
| `master` | 个人定制和可部署主线 |
| `upstream-sync` | `upstream/master` 的无本地修改镜像 |
| `feature/*` | 日常功能开发分支 |
| `sync/upstream-*` | 上游主线更新的临时集成分支 |

## 环境与首次安装

要求 Node.js 20 或更高版本，并使用与上游 CI 一致的 pnpm 9。当前锁文件不应由 pnpm 11 重写。

首次安装或重新下载依赖时，双击 `Setup-InkOS.cmd`，或者执行：

```powershell
& 'D:\lnkos\Setup-InkOS.ps1'
```

脚本会在临时目录准备 pnpm 9.15.9，随后按锁文件安装依赖并构建，不修改全局 pnpm。需要运行完整验证时使用：

```powershell
& 'D:\lnkos\Setup-InkOS.ps1' -FullValidation
```

对应的底层验证命令是：

```powershell
corepack pnpm@9.15.9 install --frozen-lockfile
corepack pnpm@9.15.9 build
corepack pnpm@9.15.9 typecheck
corepack pnpm@9.15.9 test
corepack pnpm@9.15.9 verify:publish-manifests
```

LLM 密钥和创作内容属于运行时数据，不属于代码仓库。建议在仓库外创建内容目录，例如 `D:\inkos-data\my-project`。

## 启动本地 Studio

初始化完成后，可以直接双击仓库根目录的 `Start-InkOS.cmd`，或者在 PowerShell 中执行：

```powershell
& 'D:\lnkos\Start-InkOS.ps1'
```

默认运行数据目录是 `D:\inkos-data\default`，默认端口是 `4567`。需要覆盖时：

```powershell
& 'D:\lnkos\Start-InkOS.ps1' -ProjectRoot 'D:\inkos-data\my-project' -Port 4567
```

完成构建后，在内容目录中调用本仓库构建出的 CLI：

```powershell
Set-Location -LiteralPath 'D:\inkos-data\my-project'
node 'D:\lnkos\packages\cli\dist\index.js' studio -p 4567
```

浏览器访问 `http://localhost:4567`。服务配置和密钥保存在内容项目的 `.inkos/` 运行时目录中，不要提交到代码仓库。

需要分别观察前后端时，可使用独立 PowerShell 窗口：

```powershell
pnpm --filter @actalk/inkos-core dev
pnpm --filter @actalk/inkos dev
pnpm --filter @actalk/inkos-studio dev:client
```

Studio API 调试窗口：

```powershell
$env:INKOS_STUDIO_PORT = '4569'
$env:INKOS_PROJECT_ROOT = 'D:\inkos-data\my-project'
pnpm --filter @actalk/inkos-studio dev:server
```

## 修改个人功能

```powershell
git switch master
git pull --ff-only origin master
git switch -c feature/<功能名>
```

完成修改和验证后，创建原子提交并合入 `master`。不要在 `upstream-sync` 上开发功能。

## “更新代码”

该指令只更新个人仓库：

```powershell
git status --short
git fetch origin --prune
git switch master
git merge --ff-only origin/master
```

工作区不干净或历史分叉时停止，不使用 reset、force push 或覆盖式更新。

## “更新原始代码”

该指令只处理已经进入 `Narcooo/inkos` 的 `master` 的代码：

```powershell
git fetch upstream --prune
git switch upstream-sync
git merge --ff-only upstream/master
git push origin upstream-sync
git switch master
```

随后先用 `git merge-tree` 进行无工作区改动的冲突预检，并审查依赖、配置、接口和行为影响。无冲突时才创建 `sync/upstream-YYYYMMDD` 集成分支进行合并和验证。

发现文本冲突、功能行为冲突、潜在回退或无法确定的交互时，必须先向用户说明冲突范围和建议方案，获得明确确认后才能继续。不得从上游其他分支或标签提前获取功能。

## 回滚与恢复

- 查看近期提交：`git log --oneline --decorate -20`
- 撤销尚未推送的单个新提交时，优先使用 `git revert <sha>`，保留可审计历史。
- 已发布提交不得通过强制推送或重写历史移除。
- `upstream-sync` 出现本地提交时停止操作，先比较它与 `upstream/master`，不得直接覆盖。
