# dsh-restart

给 **DeepSeek Harness 桌面版**加一个**重启按钮**：位于窗口标题栏最右侧、原生窗口控制按钮（— ❐ ✕）的左边，点一下就**把整个应用重启**（Electron 外壳 + 它的 Host 进程），回到原来的工作区。

* 只有一个按钮，**没有「关闭」**。
* 只走桌面的窗口标题栏；不是桌面版（例如 `dsh web`）时自动回退到会话头部工具区，保证按钮总在。
* 零第三方依赖、零构建工具链、不联网安装。

```
        ┌─────────────────────────────── 标题栏 ───────────────────────────────┐
        │  应用  编辑                                   \[ ↻ ]   —    ❐    ✕     │
        └──────────────────────────────────────────────────────────────────────┘
                                                    ↑ 本插件        ↑ Electron 原生按钮
```

## 安装（本机 desktop profile）

```powershell
$plugin = 'D:\\DSH\\dshworkspace\\restart-button'
$profileDir = 'D:\\DSH\\.dsh\\profiles\\desktop'

# 1) 让 profile 能解析到这个包（junction 等价于 pnpm 的 link: 依赖）
New-Item -ItemType Junction -Path "$profileDir\\node\_modules\\dsh-restart" -Target $plugin
```

然后在 `$profileDir\\package.json` 里加两处：

```jsonc
{
  "dependencies": {
    "dsh-restart": "link:D:\\\\DSH\\\\dshworkspace\\\\restart-button"
  },
  "dsh": { "profile": { "bundles": \[ /\* … 其他 bundle …, \*/ "dsh-restart" ] } }
}
```

最后**重启一次 DSH**（托盘退出后重新打开，或从桌面快捷方式启动）。Host 半侧是 bundle，**不会热重载**：改完 `src/` 重建 `lib/` 之后也必须重启一次应用才会生效（client 半侧刷新页面即可）。

卸载：把上面两处删掉、删掉 `node\_modules\\dsh-restart` 这个 junction，再重启。

## 使用

点标题栏的 ↻ 按钮 → 出现「DSH 正在重启…」整屏提示 → 应用整体退出并在几秒后自动重新打开，回到之前的工作区。

> 为什么不做成「只重启 Host」：桌面版的外壳把 Host 当成子进程管理，Host 自己退出会被判定为崩溃并弹出「崩溃恢复」对话框；而渲染进程拿不到任何重启类 IPC 通道（`preload-app.cjs` 只暴露 `browser/deviceInfo/keyboard/shortcuts/updates`）。因此只能由插件从外部重启整个应用。

## 实现

**Host 半侧**（`src/index.ts` → `lib/index.js`，`inject = \["webServer"]`，在 `ctx.effect()` 内注册并在清理时注销）：

|方法|路径|作用|
|-|-|-|
|`GET`/`HEAD`|`/dsh-restart/ping`|返回 `{ok, plugin, boot, pid, platform, mode}`；`boot` 是每次 Host 加载时生成的 `pid-时间戳`，客户端用它判断「是否真的换了一个进程」。|
|`POST`|`/dsh-restart/restart`|校验同源 → 写助手脚本 → 用 WMI 创建它 → 返回 `200 {ok, boot, mode, port, via}`；并发点击返回 `409`，跨源返回 `403`，其它方法 `405`。|

`via` 说明助手是怎么起来的：`wmi-hidden`（WMI 创建且控制台已隐藏，正常路径）、`wmi-visible`（WMI 创建但 STARTUPINFO 被拒，会有黑窗一闪）、`detached-sh`（POSIX，或 WMI 完全不可用时的 Windows 兜底）。

**Client 半侧**（`src/client/index.ts` → `lib/client.js`，`window.\_\_ModuleLoader\_\_.load({ id: "dsh-restart" })`，`inject = \["slots"]`）：

* 注册 `shell.overlay`（官方 shell 级浮层座位，`kind: list` / `scope: root`）→ 绝对定位到 `top: 0; right: 46\*3+6 = 144px`，高度取 `var(--dsh-windows-titlebar-height, 40px)`，并设 `-webkit-app-region: no-drag`（标题栏本身是拖拽区，不加就点不动）。
* 只有 `document.documentElement` 带 `data-windows-titlebar`（Windows 桌面版由 `preload-app.cjs` 写入）时才渲染标题栏按钮；其它环境注册 `conversation.session.header.utilities` 渲染同一个控件的 30×30 版本。两者互斥。

### 重启助手做了什么

助手脚本写在 `%TEMP%\\dsh-restart-helper.ps1`，日志写 `%TEMP%\\dsh-restart.log`（POSIX 为 `-helper.sh`）。它是**由 WMI 创建**的（`Invoke-CimMethod -ClassName Win32\_Process -MethodName Create`），父进程是 `WmiPrvSE.exe` 而不是 DSH，因而脱离了 DSH 的进程树与作业对象，`taskkill /T` 不会连自己一起杀掉；直接 `spawn(detached)` 的子进程在 Windows 上活不过父进程。

1. **先隐藏自己的控制台**：创建时带 `Win32\_ProcessStartup{ ShowWindow = \[uint16] 0 }`（`-WindowStyle Hidden` 来不及，控制台由 WMI 在 PowerShell 起来之前创建）。这一步没做成会看到黑窗一闪。
2. 把宿主的环境做成快照写进脚本，并**剔除 `ELECTRON\_RUN\_AS\_NODE` / `DSH\_DESKTOP\_NODE\_EXECUTABLE`**——外壳是用前者启动 Host 的（`app.asar/lib/main.js:3529`），跟随环境透传会让重拉起的 `DeepSeek Harness.exe` 变成纯 Node：没有脚本参数 → 起 REPL → stdin EOF → **约 400ms 后静默 exit 0**，表现就是「点了重启只是把应用关掉」。
3. 等 **2.0s**，让 HTTP 200 先落到浏览器。
4. 用 `Get-CimInstance Win32\_Process` 核对目标进程的 `ExecutablePath`（防 PID 复用误杀），然后 `taskkill /PID <pid> /T /F`，轮询直到目标真的消失（最多 20s）。
5. **等端口释放**：用 `host` 头里的端口（缺省 19387）查 `Get-NetTCPConnection -State Listen`，等最多 6s；超时只记一行日志照样继续。
6. `Start-Process` 拉起原可执行文件：桌面模式回放外壳原本的命令行参数（`$target.CommandLine` 去掉首 token），Web 模式回放 `execArgv + argv`。
7. **观察 9 秒**：新进程若提前退出（单实例锁没拿到、端口还被占、或环境又出问题），记下退出码间隔 2.5s 重试，最多 **5 次**；成功则 `restart complete (instance pid N)`，全败则 `every launch attempt ended early; start DSH by hand`。桌面模式下「已经在跑的实例」会被认领而不是重复启动——判定依据是**应用窗口**而不是进程树：`DeepSeek Harness.exe` 这一个 exe 同时承载外壳（有窗口）、它的 Host/renderer/GPU 子进程、以及打包版 CLI spawn server 后**被重挂到僵死父进程、没有窗口的孤儿 host**；孤儿因为父进程已死也成了「树根」，只认树根会把它当成「实例已在运行」而放弃拉起，表现就是应用被关掉后**再也回不来**。现在的判据是：属于该 exe 的进程 + `IsWindowVisible` + `GW_OWNER == 0` + 类名恰为 `Chrome_WidgetWin_1`（只有外壳有；`dsh web` 是纯 node，天然不匹配）。窗口探测失败时只记日志并照常拉起，绝不倒向「已有实例」。
8. 任务结束后**删除自己的脚本**（里面是环境快照，不该在 `%TEMP%` 里长期留着）。

POSIX（macOS 桌面 / `dsh web`）用同构的 `sh` 脚本：`unset`、`kill -TERM` → 轮询 → `kill -KILL` → `nohup`/`open -n`，带同样的「拉起后验证 + 重试」。

## 验证

```powershell
npm run bundle                       # src/ → lib/（零依赖，仅 Node 内置模块）
npm run gates                        # 31 条一致性门禁（命名、导出、注入、座位、安全栏）
npm run check                        # bundle + node --check 两个产物 + gates
npm test                             # 31 项：Host 16 + 集成 8 + Client 4 + 助手脚本语法 3
npm run test:e2e                     # 真机跑一次助手（拿 throwaway node 进程当靶子，不碰 DSH）
python D:\\DSH\\skills\\dsh-plugin-studio\\scripts\\verify\_plugin.py .
```

* `src/` 是唯一的手写来源，`lib/` 只由 `scripts/build.mjs` 写出，不要手改（`npm run gates` 会逐字节比对 `src/` 与 `lib/`）。
* `test/client.test.mjs` 会在桩浏览器里真实求值 `lib/client.js` 并渲染两个座位，因此「ModuleLoader id 不对」「忘记声明 `module`」「把 react-dom 打进包里」这类错误会在测试里炸出来。
* `test/helper-syntax.test.mjs` 用**真实的 PowerShell 解析器**检查生成的助手脚本，`test/e2e/helper-selfdelete.mjs` 实跑一次助手（含「脚本自删后仍能跑完」）。
* `docs/plan.md` 记录了落位论证、三条被否决的重启路线、2026-10-04 的两轮真机故障与根因，以及相对技能默认配方（TS + esbuild）的偏离原因。
* 2026-10-06 的第三次真机故障（点重启只关掉应用、不再拉起）根因见「重启助手做了什么」第 7 条：日志停在 `an instance is already running (pid 16780); not launching another`，而 16780 正是一个**没有窗口的孤儿 host**。改用窗口枚举后，同一份进程表下只返回真外壳这一个 PID，`dsh web` 也不会被误判。

## 安全与威胁模型

* 路由只放行「无 `Origin`」、`dsh-app://app`、以及同 host 的请求。桌面主窗口的页面 origin 就是 `dsh-app://app`，外壳的协议代理转发时会**删掉** `Origin`，所以两者都必须接受。
* 插件路由**不经过**宿主 Web 服务自身的 token 校验（实测未带 token 也能命中，返回 405/403 而非 401）。浏览器对任何跨源 POST 都会带上 `Origin`，因此上面的同源守卫足以挡掉「访问某个网页就把本机 DSH 重启掉」这类 CSRF；它挡不住的是**以当前用户身份运行的本机程序**——那种程序本来就能直接杀进程。
* 助手脚本含宿主的**环境变量快照（含值）**，因此：它写在当前用户的 `%TEMP%`（只有该用户可读），任务结束即自删，下一次重启会覆盖它。若想彻底避免落盘，需要改成白名单透传，但那样一旦漏掉应用真正需要的变量，重启后的实例就会带着错误的环境启动——本插件选择「保真 + 尽快删除」。

## 已知限制

* 重启是**整应用级**的：所有窗口、未保存的输入框内容都会一起没掉。
* **Host 半侧不热重载**：`npm run bundle` 之后必须重启一次 DSH，改动才生效（判断依据：`%TEMP%\\dsh-restart.log` 里的 `routes registered (…, boot=…)`）。
* 标题栏按钮区宽度按 Windows caption 按钮 46px×3 估算；若系统用了超大字号或非默认 DPI 缩放导致原生按钮变宽，按钮会与原生按钮重叠或留缝——改 `src/client/index.ts` 里的 `CAPTION\_BUTTON\_WIDTH` / `CAPTION\_BUTTON\_COUNT` 即可。
* macOS 桌面走同样的 `shell.overlay` 落位（`titleBarStyle: hiddenInset`，红绿灯在左侧），但重启路径（`kill` + `open -n`）**未在真机验证过**。
* Windows 需要 PowerShell 5.1+（系统自带）与 WMI 服务可用。
* 与社区插件 `PangXitong/dsh-restart-button` 同时安装时会有两个重启入口（它的 ⏻ 在会话头部，它的「关闭」会触发外壳的崩溃恢复对话框，它的「重启」会踩上面第 2 步的环境泄漏坑）。建议只留本插件。

## 许可证

MIT。落位与重启思路参考了社区插件 `PangXitong/dsh-restart-button` 的公开实现（Apache-2.0），本仓库为独立重写，只保留重启功能。

