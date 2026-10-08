# dsh-restart 插件计划

> 由 DSH 插件开发助手（dsh-plugin-studio）流程驱动；本文件记录每个阶段的真实决策、偏离与真机故障复盘。

## 阶段 ①：需求捕获

- [x] 插件名：`dsh-restart`
- [x] 一句话目标：在 DSH 桌面版窗口标题栏最右侧（原生窗口控制按钮 — ❐ ✕ 左侧）放一个重启按钮，点击后整个应用（外壳 + Host）自动重启并回到原工作区。
- [x] 能力面清单：
  - 只保留「重启」一项，**不做「关闭」**（用户明确要求）。
  - 落位：窗口标题栏右侧空白区，紧邻原生 — ❐ ✕ 左侧（用户截图红框，m00114/m00115）。
  - 载体：Electron 桌面版（`@deepseek-ai/dsh-desktop` 0.2.0-rc.2，Windows）。
  - 无第三方依赖、无网络安装、无构建工具链。
- [x] 目标 profile：`desktop`（`D:\DSH\.dsh\profiles\desktop`）。

## 阶段 ②：形态与分发决策

- [x] 形态：`bundle-client`（`dsh.bundle.patch` + `dsh.client.platform: web`）。
- [x] 分发方式：本地目录（`file:`/`link:`），因为要装进用户本机的 desktop profile；`lib/` 产物入库。
- [x] 包管理器：不引入（`file:` 依赖 + junction 即可，见阶段 ⑤）。

### 落位论证（为什么用 `shell.overlay`）

- Electron 主窗口在 Windows 上使用 `titleBarStyle: "hidden"` + `titleBarOverlay: { height: 40 }`（`app.asar\lib\main.js`），因此截图里的 **— ❐ ✕ 是原生按钮，不是 DOM**，任何插槽都插不进它们与窗口边缘之间；能做的只能是**落在它们左侧的空白区**。
- 标题栏条本身是 `dsh-client-ui-layout` 的一条绝对定位伪元素（`[data-windows-titlebar] .BynINW_frame:before{height:var(--dsh-windows-titlebar-height);-webkit-app-region:drag}`），全项目 **没有任何 titlebar 插槽**（92 个插槽名全量扫描确认）。
- 官方提供的 shell 级浮层座位 `shell.overlay`（`kind: "list"`, `scope: "root"`）渲染在 `.BynINW_overlayLayer{z-index:20;position:absolute;inset:0}` 内，覆盖整个 frame（含标题栏条）→ 与 `position:absolute; right:138px` 组合即可精确落在原生按钮左侧。
- 原生按钮区宽度：Electron 不暴露该宽度常量，`@deepseek-ai` 里也只有 `--dsh-windows-titlebar-height`/`--dsh-windows-sidebar-width`/`--dsh-windows-content-radius` 三个变量。按 Windows caption 按钮 ≈46 CSS px × 3 = 138px 计算（用户截图 850×102 为 2× 缩放，按钮中心间距 90px → 45~46px/按钮，吻合）。
- 非 Windows 桌面 / 纯 `dsh web` 没有标题栏，客户端会自动回退到会话头部工具区 `conversation.session.header.utilities`（两个座位互斥，任何情况下只出现一个按钮）。

## 阶段 ③：配方装配

- [x] `src/index.ts` 已生成（Host 半侧：`inject = ["webServer"]` + `ctx.effect()` 内注册两条路由并返回 disposer）。
- [x] `src/client/index.ts` 已生成（Client 半侧：ModuleLoader bundle + `inject = ["slots"]` + 两次 `ctx.slots.inject(...)`）。
- [x] `inject` 已覆盖所有服务：Host 只用 `ctx.webServer`/`ctx.effect`；Client 只用 `ctx.slots`/`ctx.effect`。
- [x] 冒烟功能就绪（**有意偏离见 ④.6**：以 `GET /dsh-restart/ping` + 可见按钮替代技能的 `hello` 命令）。
- [x] 未手改 `lib/`（`lib/` 只由 `scripts/build.mjs` 写出；`npm run gates` 逐字节比对 `src/` 与 `lib/`）。

### 重启机制（关键决策）

桌面版的进程树是 `DeepSeek Harness.exe`(外壳) → `node dsh-desktop-host`(Host) → 插件。三条否决过的路线：

1. **从渲染进程调 IPC** —— 不可行：`lib/preload-app.cjs` 通过 `contextBridge` 只暴露 `browser/deviceInfo/keyboard/shortcuts/updates` 等（`createProductApi()`），**没有任何 restart/relaunch 通道**；`DESKTOP_IPC` 全量清单里也没有。
2. **Host 自己 `process.exit(0)`** —— 不可行：外壳的 `DesktopHostProcess` 只接受 `ready/platform-session/shutdown-complete/fatal` 与控制应答，其它任何退出都会走 `fail()` → `reportFatal` → **弹出崩溃恢复对话框**，不是「重启」。
3. **`ctx.get("desktopActions").requestRestart()`**（第三方插件 StabCut/dsh-plugin-restart-desktop 的做法）—— 本机 0.2.0-rc.2 对整个 asar grep `desktopActions|requestRestart` **零命中**，该服务尚不存在。

采用的方案：Host 在 `%TEMP%` 写一个 PowerShell 助手，用 **WMI `Invoke-CimMethod -ClassName Win32_Process -MethodName Create`** 创建它（父进程变成 `WmiPrvSE.exe`，脱离 DSH 进程树与作业对象，`taskkill /T` 不会连带杀死）。助手：隐藏自己的控制台 → 环境快照（剔除 Node 模式变量）→ 等 2.0s（HTTP 200 落地）→ `Get-CimInstance Win32_Process` 校验目标进程可执行文件路径（防 PID 复用误杀）→ `taskkill /PID <pid> /T /F` → 轮询等它真正退出（最多 20s）→ 等端口释放（`Get-NetTCPConnection -State Listen`，最多 6s）→ `Start-Process` 重新拉起 → 观察 9s、最多重试 5 次（单实例锁竞态）→ 删除自己的脚本。WMI 失败时回退 detached `spawn`；macOS 用 `kill -TERM/-KILL` + `open -n <.app>`。

- 桌面模式目标 PID = `process.ppid`（外壳进程），并回放外壳原来的命令行参数（`$target.CommandLine` 去掉首 token），保证快捷方式参数不丢。
- Web 模式（`dsh web`，纯 Node）目标 PID = 自身，用 `process.execArgv + process.argv.slice(1)` 重放命令行。
- **新旧实例不能共存**（外壳内置文案 `startupAddressInUse`），所以助手必须等旧进程真正消失后才拉起新进程。

## 阶段 ④：本地验证

- [x] `npm run bundle`（= `node scripts/build.mjs`，零依赖）→ `lib/index.js` 29223 B、`lib/client.js` 11444 B。
- [x] `node --check lib/index.js && node --check lib/client.js` 通过。
- [x] `npm run gates` → **31 gates passed**（`scripts/gates/run.mjs`）。
- [x] `npm test` → **31 项**：`test/host.test.mjs` 16 + `test/integration.test.mjs` 8 + `test/client.test.mjs` 4 + `test/helper-syntax.test.mjs` 3（POSIX `sh -n` 因本机无 sh → skip）。
- [x] `npm run test:e2e` → `test/e2e/helper-selfdelete.mjs` 真机跑一次助手（throwaway node 进程当靶子，不碰 DSH）：脚本被写出 → 含环境快照 → 末行自删 → `restart complete` → 脚本已消失 → 重拉起进程存活 → 靶子已被杀 = **PASS**。
- [x] `python D:\DSH\skills\dsh-plugin-studio\scripts\verify_plugin.py .` → **11/11 PASS**。
- [x] `npm install` —— **不适用**：零依赖。

### 偏离说明（相对技能的默认配方）

技能的默认配方是「TypeScript 源码 + esbuild 打包 + `pnpm install && pnpm run bundle && pnpm run gates`」。本机 github.com 不可达、也不适合为了一个按钮去装 esbuild 工具链，因此：

- 源码为**无类型注解的 ECMAScript**，按合同路径命名为 `src/index.ts` / `src/client/index.ts`；`scripts/build.mjs` 按**文本**处理它们，所以不需要 TypeScript 工具链（`tsconfig.json` 仅供编辑器使用，`types: []`，未安装 `@types/node`）。
- 用 `scripts/build.mjs`（零依赖，仅 Node 内置模块）替代 esbuild：它把两个半侧原样发射到 `lib/`，并断言「ModuleLoader id == 包名」「React 保持 external」「不 require 官方包」等合同事实。
- `scripts/gates/run.mjs` 是自己写的零依赖门禁（技能只给了概念，未提供可直接用的实现），覆盖技能自检清单的全部条目。
- 本地先例 `D:\DSH\dshworkspace\dsh-sidebar-panel`（已装进同一个 desktop profile 并正常工作）同样没有构建步骤，证明该形态被平台接受。

## 阶段 ④.5：真机故障、根因与复验（2026-10-04）

安装后用户首次点击 ↻ 的真实结果（原文 m00551「没有办法重启，就是打开了一下，然后就自动关闭了」、m00743「还是不行，点了重启按钮，但是没有重启」、m00754「只是关了dsh桌面端」）暴露出三个独立缺陷，全部已修复：

1. **黑窗一闪（体验）**：WMI 创建的助手控制台先于 PowerShell 出现，`-WindowStyle Hidden` 来不及。→ 创建时带 `Win32_ProcessStartup{ ShowWindow = [uint16] 0 }`。注意 `ShowWindow` 必须是 `[uint16] 0`（Int32 会让 `Invoke-CimMethod` 报「类型不匹配」/ `HRESULT 0x80041005` 并静默回退到会闪黑窗的老路径）；A/B 实测（`EnumWindows` + `IsWindowVisible` 前后差集）：SW_HIDE → 新增可见窗口 0 个，不带 STARTUPINFO → 新增可见窗口 2 个。
2. **点击后应用不回来（致命）**：宿主 `process.env` 带 `ELECTRON_RUN_AS_NODE=1`（外壳在 `app.asar/lib/main.js:3529-3538` 用它启动 `dsh-desktop-host`，插件正跑在其中）。助手把环境逐条透传 → 重拉起的 `DeepSeek Harness.exe` 变成**纯 Node**：没有脚本参数 → 起 REPL → stdin EOF → **约 400ms 后静默 exit 0**。真机日志里 5 次尝试的耗时 401/404/407/411/417 ms、exit code 全 0，与此完全吻合。判据：带该标志时 `"...\DeepSeek Harness.exe" --version` 打印 `v24.18.1`（Node 版本）。→ 修复：`NODE_MODE_VARS = ["ELECTRON_RUN_AS_NODE", "DSH_DESKTOP_NODE_EXECUTABLE"]`、`relaunchEnv()` 剔除、助手 `Remove-Item 'Env:<key>'` 兜底、POSIX `unset`。
   - **被推翻的错误诊断**：最初判定为「硬杀后 1.8s 就拉起，新实例输掉 `claimDesktopSingleInstance` 竞态而静默退出」。单实例锁确实存在（`app.asar/lib/main.js:6862-6877`），但不是本次的病因；保留 9s 观察 + 重试作为对该竞态的防御。
3. **web 模式助手不启动（次要）**：`Get-DshShells`（「exe 且父进程不是同名 exe」的进程树根启发式）在 `dsh web` 下会把任意无关的 `node.exe` 当成「已在运行的实例」，从而完全跳过重启。→ 该判定只在桌面（`spec.relaunch === "shell"`）时发射。

**复验（真机，无需人工干预）**：`%TEMP%\dsh-restart.log` 11:08:17 `restart requested (mode=desktop, port=19387), helper pid 29260 via wmi-hidden` → 11:08:20 `terminating the desktop shell process tree` → 11:08:23 `launch attempt 1: started pid 2964` → 11:08:25 新宿主 `routes registered (…, mode=desktop, boot=20156-1791083305144)` → 11:08:32 `launch attempt 1: pid 2964 is still running` + `restart complete (instance pid 2964)`；进程表里外壳 **2964 的父进程 = 29260（助手）**，当前宿主 20156 是它的子进程。→ 点击 ↻ 现在真的会重启整个应用。

## 阶段 ④.6：技能合规审查（2026-10-04，用户要求用 dsh-plugin-studio 复查）

| # | 发现 | 级别 | 处置 |
| --- | --- | --- | --- |
| 1 | `%TEMP%\dsh-restart-helper.ps1` 落盘**宿主环境变量全量明文快照**，且长期驻留 | 高 | 助手任务结束即自删脚本（`Remove-Item -LiteralPath $PSCommandPath`）+ JSDoc/README 明示；不改白名单（见下） |
| 2 | 原插件 `@pangxitong/dsh-restart-button` 仍在 profile 里：它的「关闭」触发崩溃恢复框、它的「重启」踩同一个环境透传坑 | 高 | 建议从 profile 移除（待用户决定） |
| 3 | 缺技能的 `scripts/gates/run.mjs` + `bundle`/`gates` 脚本 + `.gitignore` | 中 | 已补齐：31 条门禁 + 三条脚本 + `.gitignore`（`lib/` 有意入库） |
| 4 | README 过期（助手步骤/1.5s/24 项测试/`client/client` 路径） | 中 | README 整篇重写 |
| 5 | plan.md 无真机故障与根因记录、计数过期 | 中 | 本节 + 阶段④/⑤ 更新 |
| 6 | 插件路由绕过宿主 token 门，理论上可被跨源 POST 触发 | 低 | **不改代码**：浏览器跨源请求必带 `Origin`，同源守卫已覆盖；写入 README 威胁模型 |
| 7 | POSIX（macOS / `dsh web`）重启路径未真机验证 | 低 | 文档标注；POSIX 脚本不含环境值，无落盘问题 |
| 8 | 技能冒烟要求含「一条 hello 命令」 | 低 | **有意偏离**：单用途插件用 `GET /dsh-restart/ping` + 可见按钮承担冒烟；已在此记录 |
| 9 | 探针脚本原先放在工作区外的 scratch 目录，已随目录清理而消失 | 低 | 把真机 e2e 收进仓库：`test/e2e/helper-selfdelete.mjs`（`npm run test:e2e`） |

**为什么不做环境变量白名单**：白名单一旦漏掉应用真正需要的变量（代理、证书、`DSH_*`、自定义凭据变量等），重启后的实例就会带着错误的环境启动——这是本插件唯一不可接受的失败模式。权衡后选择「保真透传 + 任务结束立即删除 + 明示风险」。

## 阶段 ⑤：安装与浏览器冒烟

- [x] 安装成功：`D:\DSH\.dsh\profiles\desktop\package.json` 的 `dependencies` 加了 `"dsh-restart": "link:D:/DSH/dshworkspace/restart-button"`、`dsh.profile.bundles` 末尾加了 `"dsh-restart"`（原文件已备份为 `package.json.bak-before-dsh-restart`），并建了 junction `node_modules\dsh-restart` → 本目录；`require.resolve("dsh-restart")` 与 `require.resolve("dsh-restart/client")` 均解析到本目录的 `lib/*.js`。
- [x] 生效：需要重启一次 DSH 才载入 Host 半侧（**bundle 的 Host 半边不热重载**，`dsh.profile.patchReload: "live"` 只重放 profile patch）。已按此复验。
- [x] 启动日志无 `plugin tree failed to load`。
- [x] 渲染进程无本插件相关的 `slot entry crashed`（另有两个既存问题：`billion-context` / `dsh-science-skill` 的 client 加载失败，与本插件无关）。
- [x] 冒烟功能可用：点标题栏 ↻ → 应用整体退出并自动重新打开（真机证据见 ④.5）。

### 旧插件共存

原插件 `@pangxitong/dsh-restart-button`（带「关闭 / 重启」菜单）仍在 desktop profile 的 `dependencies` 里且会被加载，它的 ⏻ 按钮在**会话头部工具区**，本插件的 ↻ 在**标题栏**，两者位置不同、路由前缀不同（`/dsh-restart-button/*` vs `/dsh-restart/*`）。**审查结论：建议删掉它**——它的「关闭」走 `process.exit(0)` → 外壳弹崩溃恢复框；它的「重启」同样全量透传环境 → 踩 ④.5 的 Node 模式坑。移除方式：把该包从 `dependencies` 与 `dsh.profile.bundles` 里删掉（`node_modules` 可留）后重启。

## 阶段 ⑥：发布

- [ ] git 仓库与 remote 就绪（尚未初始化）。
- [x] README 使用真实安装方式（本地目录）。
- [x] 构建产物已入库（`lib/` 由 `npm run bundle` 生成后保留在工作区；`.gitignore` 不排除 `lib/`）。

## 备注

- 决策变更记录：最初计划把按钮放在会话头部工具区（原插件的位置）；用户在 m00114/m00115 用截图明确指定「标题栏原生窗口控制按钮左侧」，故改用 `shell.overlay` + 绝对定位，会话头部仅作为非桌面环境的回退。
- 路由前缀用 `/dsh-restart/*` 而非 `/dsh-restart-button/*`：`webserver.register` 对重复 `(kind,path)` 直接抛错，而原插件 `@pangxitong/dsh-restart-button` 仍占着后者的两条路由。
- 版本：`0.1.0` 初版 → `0.1.1`（2026-10-04：Node 模式环境泄漏修复、隐藏控制台、端口门 + 拉起验证重试、自删脚本、门禁与 e2e 补齐）。
