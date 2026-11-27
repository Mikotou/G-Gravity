# CLAUDE.md — Gravity 架构说明与硬性合规规定（必读）

欢迎接手 **Gravity** 项目！在对本仓库进行任何代码修改、重构或新增功能之前，请务必完整阅读并严格遵守本文档中的**十大合规红线（Google ToS & 账号安全规定）**与工程架构约束。

---

## 一、核心定位

- **Gravity** 是一个运行在本机的 Electron + React + TypeScript 桌面工作台，后端**唯一**通过官方 CLI 的公开标准协议 **`agy acp`（Agent Client Protocol，JSON-RPC 2.0 over `stdio`）** 与本地 `agy` 进程通信。
- 当前代码处于 **`v0.2` 合规后端基线 + `v0.3` Claude Code / Codex 风格前端重构版**：
  - `src/shared/` 与 `src/main/` 已通过全量安全与合规终审；
  - `src/renderer/` 采用统一的 Claude Code / Codex 三栏桌面工作台架构（左栏 Projects/Threads、中栏 1/2/4 分屏 SessionPane + 统一 Composer、右栏可调宽 Inspector、以及 `Ctrl+,` 呼出的全屏侧栏式 `SettingsView`）。

---

## 二、十大硬性合规规定（Non-Negotiable Compliance Rules）

**任何代码变更严禁突破以下任一红线（自动化回归守卫位于 `tests/security-baseline.test.ts`、`tests/acp-boundaries.test.ts`、`tests/accounts-v02.test.ts`、`tests/v033-backend-architecture.test.ts`、`tests/v033-bundle-and-deadcode.test.ts`）：**

1. **严禁触碰任何私有凭据或认证状态文件**
   - 严禁读取、解析、复制、移动、解密或导出 `~/.gemini`、`antigravity`、`antigravity-cli` 或隔离 Profile 目录下的任何 OAuth Token、`refresh_token`、`access_token`、Cookie、`installation_id`、`*.pbtxt`、`*.pb`、`state.vscdb*`、`.env`、`application_default_credentials.json` 或密钥文件。
   - 路径拦截契约见 `src/shared/accounts-history-contract.ts` 中的 `isForbiddenCredentialOrStatePath()`（按路径作用域精确防护，不误伤普通工程源码与 `SKILL.md`）。

2. **桌面版仅展示 G-Gravity 自有会话，对 `~/.gemini` 严格 0 字节写入**
   - `v0.3.3` 已彻底移除外部只读历史导入链路（`history-importer.ts` / `ReadOnlyHistoryView.tsx`），侧栏仅展示当前 Profile 的 G-Gravity 自有会话登记表并保留旧版自有数据自动升级迁移。
   - `src/main/telemetry/checkpoint-limit-reader.ts` 通过 `src/main/storage/readonly-sqlite-snapshot.ts` 以只读、0 字节写入、防 TOCTOU 方式将目标会话 `conversations/<sessionId>.db` 字节复制到客户端私有临时目录提取 `max_token_limit`（用后即删，绝不读取任何凭据或状态文件）；`src/main/services/local-media-inspector.ts` 与 `src/main/session/plan-artifact-reader.ts` 仅以只读、有界字节上限（`implementation_plan.md` 严格 ≤ 128 KiB UTF-8）与 `lstat` + `realpath` 校验方式检查工作区及当前会话 `brain/<sessionId>` 产物。
   - 对官方目录必须保持 **0 字节写入、0 新增文件**。

3. **多账号隔离仅限官方 `--app-data-dir` + 100% 用户手动切换（严禁自动轮换切号）**
   - 多账号通过为不同 Profile 分配客户端私有空目录并传入官方公开参数 `agy acp --app-data-dir <isolatedDir>` 实现，登录仅能由用户点击按钮拉起可见终端运行 `agy acp [--app-data-dir ...] --login`。
   - **零容忍红线**：严禁在遇到 `429`、`403`、`RESOURCE_EXHAUSTED` 或连接异常时自动切换 Profile 或轮询多个账号绕过单账号配额（Account Rotation 属于严重违规行为）。

4. **严禁调用任何非公开 Google 内部端点或传入内部伪装参数**
   - 严禁在代码中出现或请求 `cloudcode-pa.googleapis.com`、`daily-cloudcode-pa` 等非公开内部接口。
   - 启动 `agy` 时必须经过 `validateAgyArgs()` 白名单校验（`src/main/acp/acp-client.ts`），严禁传入 `--dangerously-skip-permissions`、`--override_user_agent_name`、`--cloud_code_endpoint`、`--use_stubby_auth`、`--is_google3_workspace`、`--is_google_internal` 等参数，且 `spawn` / `execFile` 必须固定 `shell: false`。

5. **严禁篡改官方二进制或劫持运行环境**
   - 仅以只读方式定位并拉起原版 `agy` / `agy.exe`，严禁二进制补丁、DLL 注入或注入 `NODE_OPTIONS` / `ELECTRON_RUN_AS_NODE`。

6. **内置翻译、外部复核与 Swarm**
   - 默认用随包的 Bergamot 模型在本机翻译公开的英文思考片段。收起思考只改变显示。模型来源见 assets/local-translation/sources.json。
   - 用户可独立配置外部翻译与外部复核。每项功能须由所选模型成功返回相应测试结果才能启用。两项服务各自通过操作系统加密保存密钥。
   - Swarm 记录所属会话实际报告的协作成员、消息和事件。标题整理通过用户主动触发的官方 Hydrogen (medium) 临时会话完成。

7. **并发活跃会话硬上限（`<= 4`）与 `429`/`403` 退避熔断**
   - `MAX_PARALLEL_ACTIVE_SESSIONS = 4`（前后端与共享层三端强约束）。
   - 收到 `429` / `RESOURCE_EXHAUSTED` 至少冷却 60s，收到 `403` / `PERMISSION_DENIED` 冷却 300s，冷却期内直接本地拦截请求，禁止死循环重试。

8. **Plugins / MCP / Skills 管理必须走官方 CLI 子命令**
   - 启动期禁止冷启动 CLI 刷进程；仅在用户于设置页点击操作时通过 `execFile(..., { shell: false })` 调用 `agy plugin ...` / `agy mcp ...`，禁止直接覆写 `agy` 内部配置文件。

9. **Electron 强沙箱、本机回环限制与防 CSS 注入**
   - `BrowserWindow` 必须保持 `contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true`；`preload.ts` 仅暴露 `Object.freeze` 的最小白名单桥接 `window.gravityDesktop`；`ipc-router.ts` 校验 `sender === webContents && senderFrame === webContents.mainFrame`。
   - 开发服务器与外部加载严格限制为 `127.0.0.1`，禁止监听 `0.0.0.0`。
   - 自定义主题导入必须经过 `validateCustomThemeConfig()` / `isValidCssColorToken()` 校验，防止通过色值注入 `url(...)` 外链请求。

10. **商标与图标合规 & Cost 免责声明**
    - 应用图标必须使用仓库原创的 6 套 **Gravity** 几何引力终端图标（`assets/icons/` 与 `public/icons/`），严禁使用或改色 Anthropic / Claude 官方星芒 Logo 或其他受保护商标图形。
    - Cost 面板必须保留免责声明：「参考 API 价格估算，非实际账单 / Estimated at reference API rates, not an actual bill」（常量见 `src/shared/telemetry-contract.ts:COST_DISCLAIMER`）。

11. **语音听写本地优先、严格零 Web Speech 与按需租约麦克风合规（`v0.3.6`）**
    - 严禁在 `src/` 中引用 Chromium `SpeechRecognition` / `webkitSpeechRecognition`（`tests/security-baseline.test.ts` AST 强守卫）；严禁放宽渲染层严格 CSP（保持 `script-src 'self'`，禁止 `'wasm-unsafe-eval'` / `blob:` / `'unsafe-eval'`）。
    - 本地离线转写默认使用运行于主进程独立 `worker_threads` 的 MIT 许可 `whisper.cpp` Emscripten WASM + OpenCC 繁转简；模型 `ggml-base-q5_1.bin`（`59,707,625 B`，SHA-256 固化于 `assets/local-voice/sources.json`）不入 Git 索引，由发版 CI 通过 `npm run voice:model:fetch` 校验并随包内置，或由用户在设置页显式确认后下载至 `<userData>/voice-models/`（`model.cjs` 严校 `lstat`/`realpath`/防软硬链/防 TOCTOU）。
    - **静息态 0 麦克风权限调用**：冷启动、打开设置页或未触发录音时禁止调用 `getUserMedia` / `enumerateDevices` / `permissions.query` / `askForMediaAccess`；仅在用户主动听写、3 秒试录或点击「选择输入设备」取得显式主进程租约（`voiceArmCapture`）后放行，用毕或失焦/切号/卸载立即 `release-media` 与释放音频轨。
    - **外部语音转写严格 fail-closed & 冷启免唤醒 Keychain**：仅在通过真实短语音转写验证后才可启用 `external-api`，密钥经操作系统安全加密存储且永不向渲染层回传明文、不可加密时硬拒绝且 0 明文落盘；macOS 冷启与未启用外部语音的被动状态快照不得触发 `safeStorage.isEncryptionAvailable()`（防止 `SecKeychainAddGenericPassword` 阻塞主线程或弹出钥匙串授权窗）。

---

## 三、前后端架构速查

### 1. 三层职责边界
- **`src/shared/`**：23 个纯 TypeScript 契约与无副作用校验模块（0 循环依赖，供 `tsconfig.main.json` 与 `tsconfig.renderer.json` 共同编译），定义 **93 条唯一 IPC 通道**（73 `invoke` + 20 `event`，与 `preload.ts` / `ipc-router.ts` / `macos-menu.ts` 93/93 1:1 对齐）。
- **`src/main/`**：Electron 主进程（5 层零环 DAG，`v0.3.6` 共 **118 个 TS 文件、323 条内部静态边、0 循环依赖、0 `acp/ → services/` 反向依赖**）。薄外观入口为 `CoreService`（`src/main/core-service.ts`，420 行 ≤ 420），入口 `src/main/index.ts`（143 行），全仓主进程单文件硬上限 ≤ 650 行（当前最长 633 行）；新增 `src/main/voice/` 子系统（`voice-service` / `voice-settings` / `voice-capture` / `local-voice` / `external-voice` / `voice-ledger`）与 `assets/local-voice/`（`whisper.cjs`/`whisper.wasm`/`worker.cjs`/`model.cjs`/OpenCC 词表/7 份许可），并保留 `security/redaction.ts`、`llm/external-llm-transport.ts`、`storage/readonly-sqlite-snapshot.ts` 与 `telemetry/external-service-ledger.ts` 共享基础设施。
- **`src/renderer/`**：React 19 单页工作台，所有跨进程调用统一收敛在 `src/renderer/services/desktop-bridge.ts`（生产包 0 演示 Mock）。

### 2. 前端关键组件地图（`v0.3.6` 当前结构）
- **布局骨架**：`App.tsx` → `TopBar.tsx` + `ActivityRail.tsx` + `ProjectSidebar.tsx` + `SessionWorkspaceGrid.tsx` + `RightInspector.tsx`
- **会话与输入**：
  - `SessionPane.tsx`：单个会话窗格（空状态引导、消息时间线、工具卡片流、内联审批聚焦管理、Plan 多题提问卡 `QuestionBar`、划词批注/引用、底部 Composer 挂载）。
  - `Composer.tsx` + `VoiceControls.tsx`：多行自适应输入框、`/` Slash 菜单（含 `/voice`、`/record`）、`@` 文件/会话补全、剪贴板贴图、语音听写按钮与状态条（窗格 `≤ 460px` 自动收进 `+` 溢出菜单）、顶部 `ContextStatusBar`、左下 Mode & 审批档位切换、右下 Model & Effort 选择（语音快捷键 Windows `Ctrl+Shift+M` / macOS `⌘⇧M`，`Esc` 捕获阶段优先中止录音不穿透中断 AI）。
  - `Markdown.tsx`：安全自研 GFM Markdown 渲染器（不启用原始 HTML 注入，代码块带语言栏、超 40 行折叠与复制按钮，表格与代码块支持键盘横向滚动）。
  - `InlineRequestView.tsx`：Claude Code 风格 `1–4` 快捷键内联审批卡片（`SessionPane` 保证同一时刻仅首张待审卡片响应数字快捷键）。
  - `ToolCallCard.tsx` / `UnifiedDiffBlock.tsx` / `ThinkingBlock.tsx`：工具调用折叠行、红绿行级 Diff、双轨思考折叠块。
- **右侧检视器**：
  - `RightInspector.tsx`：`Changes`（二级切换 `Diff` / `Files`）、`Plan`（统一 4 态视图：`empty / unavailable / outline / execution` + 底部常驻摘要条 + 按需展开只读 `PlanSourceDrawer` 原文抽屉）、`Terminal`、`Context`（含二级分支树 `Tree`）、`Swarm` 五个一级 Tab 切换、键盘方向键漫游与拖拽调宽。
  - `ContextCostInspectorView.tsx` & `context/TokenHeatmapView.tsx`：上下文构成条、统一双轴公式 `computeHeatLevel` 驱动的 `24h` 柱图 / `7d` 按日卡片 / `30d` Codex 周行 7 格方格热力图（OKLCH 5 阶色阶 + WCAG AA 对比度）、分模型四维费用构成（堆叠条 + SVG 环形图）。
  - `SwarmPanel.tsx`：多智能体拓扑与消息流面板。
- **统一全屏设置中心（`Ctrl+,` / `⌘,` 打开，`Escape` 关闭）**：
  - `SettingsView.tsx`：左侧 8 项分组导航（通用、外观［内含主题/自定义配色/应用图标二级页签］、账号、Approve for me、Plugins、Cost 单价、更新、关于；不暴露超规的 Orchestrator 自定义项）。
  - `settings/AppearancePanels.tsx` & `settings/VoiceSettingsCard.tsx`：语言/思考轨/进程隔离开关、语音听写卡片（本地模型状态与确认安装、按需设备枚举与 3 秒本机试录、独立外部 STT 配置与费用汇总）、6 套预设主题卡片、23 色 Token 自定义取色与 JSON 导入导出、顶部独立自动切换行 + 下方 3×2 原创图标网格。
  - `settings/WorkspacePanels.tsx`：ACP 连接状态与官方登录 + 多 Profile 手动隔离管理、`Approve for me` 规则与审计日志（行内二次确认削除）、`Plugins / MCP / Skills` 面板、模型单价表编辑。
- **设计系统与响应式分屏**：
  - `styles/theme.ts` 将当前主题的 23 个基础颜色、WCAG AA 派生色与 OKLCH 热力图 5 阶色阶（`deriveHeatmapRamp`）写入 `:root` CSS 变量；
  - 渲染层单入口模块化样式系统（`styles/index.css` → `tokens.css` → `base.css` → `components/*.css` → `platform/{win,mac}.css`，生产构建 **`214,294 B <= 215,040 B`**、0 死类、0 跨文件重复选择器、0 非合成动画；注：早年 `global.css` / `design-system.css` / `claude-studio.css` 已于 `v0.3.4` 合并收敛至该模块化目录）基于主题变量与 `color-mix(in srgb, ...)` 派生视觉层级，并通过容器查询（`@container pane` / `@container insp` / `@container hm`）适配窄窗格与窄检视器布局。

---

## 四、开发与验证流程

每次修改代码后，请按顺序执行以下三条门禁命令，确保 **0 类型错误、全量测试通过、生产构建成功**：

```bash
npm run typecheck
npm test
npm run build
```

> **提示**：
> - `AGY_OFFICIAL_SMOKE=1` 开启官方握手测试。另设 `GRAVITY_SWARM_SMOKE=1` 会通过当前官方账号真实创建测试会话和蜂群成员，并进行一轮问答及翻译。
> - 修改 UI 快捷键交互时，请注意当全屏设置中心 `SettingsView` 打开时，工作区全局 `Shift+Tab` 会被有意屏蔽，按 `Escape` 可关闭设置视图。


---

## 五、v0.7 信息层级与设计系统（前端约定）

- **`src/renderer/styles/design-system.css`**：在 `global.css` 之后加载的设计系统层。定义动效节奏（`--dur-*` / `--ease-*`）、排版尺度（`--fs-*`）、语义色（`--info`）与工具类别色（`--tool-explore / edit / exec / web / agent`，按明暗极性分别校准）。新增或调整组件样式优先写在这里，并复用这些变量。
- **信息层级原则**：只读探索（Read/Grep/Glob）降权为灰阶并自动合并；文件改动（琥珀）、命令执行（紫）、失败（红）、待审批（橙黄）始终高对比。同一语义在标签页、窗格头、工具行、Inspector 中使用同一套颜色。
- **`src/renderer/lib/turn-insights.ts`**：纯函数模块（无副作用），负责工具分类、连续探索分组、回合汇总（改动文件 / 命令 / 失败 / 耗时）。新增统计逻辑请放在这里并补单测（`tests/v07-hierarchy.test.tsx`）。
- **`src/renderer/components/TurnActivity.tsx`**：`ToolActivityStream`（工具流分组）、`TurnOutcomeBar`（回合结果条）、`PaneStatusChip`（窗格状态与实时计时）。
- 后端仅新增 `ChatMessageItem.completedAt`（`CoreService.finishMessage` 写入），用于计算回合耗时；不涉及任何凭据、外部目录或审批链路。
- 所有动效遵循 `prefers-reduced-motion`；`ToolCallCard` 折叠态必须保持**单一** `role="button"` 行（测试依赖）。

---

## 六、v0.1.5 可调整工作台（前端约定）

- **拖拽调整**：`src/renderer/components/ResizeHandle.tsx` 是唯一的分隔条组件（鼠标拖动实时预览、释放提交一次、双击复位、方向键 / Home / End / Enter 键盘调整，`role="separator"`）。
  - 左侧栏（`sidebar-resize-handle`）→ `layout.leftSidebarWidth`；右侧检视器（`inspector-resize-handle`，280–680px，宽屏最高可到窗口一半 / 1000px）→ `layout.rightInspectorWidth`；
  - 双栏分隔条（`split-resize-handle`，挂在左栏右缘，保证 `workspace-grid` 只有两个子节点）→ `layout.splitRatio`；
  - 输入框高度（`composer-resize-*`）只影响本机界面，存于 `localStorage['gravity.composer.minHeight']`。
- **后端契约**：`WorkspaceLayoutState.splitRatio?`（0.25–0.75）与 `ClientPreferences.uiScale?`（0.8–1.6）。边界常量 `LAYOUT_LIMITS` / `UI_SCALE_LIMITS` 与钳制函数 `clampSplitRatio()` / `clampUiScale()` 位于 `src/shared/`，`CoreService` 保存时校验、启动时修复越界旧值；`uiScale` 通过 `CoreServiceOptions.setZoom` 写入窗口 `zoomFactor`（`did-finish-load` 时重新应用）。回归守卫：`tests/v015-layout-core.test.ts`、`tests/v015-workbench.test.tsx`。
- **高分辨率**：首次窗口尺寸按主显示器可用区域取比例；`Ctrl+=` / `Ctrl+-` / `Ctrl+0` 或「设置 → 通用 → 界面缩放」调整整体缩放；阅读列随窗格宽度（`@container pane`）放宽到 940 / 1080 / 1200px；检视器在宽时显示全部页签文字（`@container insp`）。
- **信息分级**：检视器一级页签为 Changes / Plan / Terminal / Context / Swarm，`diff` 与 `files` 是 Changes 下的二级视图（`inspector-subtab-diff` / `inspector-tab-files`）；模型与推理强度合并为输入框右下的二级菜单（`model-select-*` → `model-menu-*`）；账号、设置与语言收进侧栏底部账户菜单（`account-menu-btn` → `account-menu`）；审批卡一级只展示用意，作用范围 / 转交原因 / AI 说明收进「详情」。
- **反馈**：生成中在输入框按 `Esc` 中断当前回合；等待首个分片时显示计时与中断提示（`WorkingIndicator`）；轻提示分 `info / success / error` 三种语气，带剩余时间条与关闭按钮。
- 新增样式统一写在 `design-system.css` 末尾的「v0.1.5 工作台精修层」，复用 `--dur-*` / `--ease-*` / `--hairline*` 变量。

---

## 七、v0.1.6 Claude Code Studio 前端架构（前端约定）

- **布局范式重构**：在 100% 保留原有前后端功能契约、合规守卫与可调整/高分屏适配能力的前提下，前端升级为 **48px 常驻极窄活动栏（`ActivityRail`）+ 可展开/拖拽调宽的会话抽屉（`ProjectSidebar`）+ 超宽居中画布（单栏 / 左右双栏 + 悬浮岛 Composer）+ 可停靠/悬浮切换的右侧检视器（`RightInspector`）**。
- **关键组件与样式**：
  - `src/renderer/components/ActivityRail.tsx`：左侧常驻 48px 活动栏，统一承载 Gravity 品牌图标（`topbar-app-icon`）、暖陶土色主操作 `+` 新建会话按钮（`sidebar-new-session-btn`）、会话抽屉开关（`toggle-left-sidebar-btn`）、项目/插件入口、底部账号头像与浮层菜单（账号管理、语言切换）、以及设置入口（`open-theme-modal-btn`）。
  - `src/renderer/components/ProjectSidebar.tsx`：紧邻 `ActivityRail` 的聚焦式会话抽屉，顶部保留线程计数、整理/筛选/新建/折叠控制与药丸搜索栏（带一键清除按钮），右侧保留 `sidebar-resize-handle` 拖拽调宽；修复了实时会话选中高亮（仅在历史会话才传入 `selectedHistoryId`）。
  - `src/renderer/components/RightInspector.tsx`：新增「停靠 ↔ 悬浮（Docked / Floating）」切换按钮（`inspector-float-toggle`，通过 `data-inspector-mode` 区分，偏好持久化至 `localStorage['gravity.inspector.floating']`）与收起按钮（`inspector-close-btn`），两者置于 `.inspector-head-actions`，保持 `.inspector-head` 为纯净的 `role="tablist"`（0 个 `role="button"`，v0.3.4 D1 决策将分支树 `Tree` 下沉为 `Context` 二级视图，一级页签回归 5 项：Changes / Plan / Terminal / Context / Swarm）。
  - `src/renderer/components/SessionPane.tsx` / `TurnActivity.tsx` / `InlineRequestView.tsx`：重构 `WelcomePane`（柔和陶土光晕 + 衬线编辑风问候 + 快捷键栏）、在收起态 `Activity · N` 摘要条中加入工具语义色微点（`.tool-cat-dot`），并将审批卡片的 `1.`–`4.` 前缀升级为触感键帽（`.option-num`）且保持 `.textContent` 与旧版完全一致。
  - `src/renderer/styles/claude-studio.css`：在 `design-system.css` 之后加载的 Claude Code Studio 视觉层（暖炭黑/羊皮纸阶梯表面、暖陶土强调色、悬浮岛输入卡片、双栏窄窗格 Composer 防溢出容器查询、悬浮检视器玻璃拟态层），同步在 `src/renderer/main.tsx` 与 `tests/desktop-layout.fixture.tsx` 引入。
- **自动化守卫**：`tests/v016-claude-studio.test.tsx` 覆盖活动栏、抽屉选中高亮与清除搜索、检视器停靠/悬浮切换及纯净 tablist、工具语义微点与审批键帽。

---

## 八、v0.2.0 体验与内置 AI 标题整理升级（前后端约定）

- **右下角独立色系额度条与重设计弹层**：`AccountQuotaView.tsx` 移除 `ctx` 左侧的独立额度按钮，统一收拢至对话框右下角以「百分比 + 进度条（`--quota-fill` 钴蓝独立色系，区别于 `ctx` 绿条）」展示；弹层重设计为右下锚定玻璃卡片 + 2 列 Bento 仪表格。
- **实时速率、会话平均速率和缓存命中率**。底栏 `ContextStatusBar` 展示实时滑窗速率。右侧检视器读取 `TelemetryStore` 的会话平均速率和可选的 `averageCacheHitRate`。服务上报的缓存读取量和总输入用于计算会话命中率，缺少完整证据时显示「未知」，确认零命中时显示 0%。重启时从会话用量记录恢复统计。
- **内置 Hydrogen (medium) 标题整理与共享冷却**：`CoreService.organizeTitles` 严禁自动触发，仅在用户主动点击侧栏「全部整理 / 单项目整理 / 单会话整理」按钮时执行；通过官方 `agy acp` 临时只读会话（遵守 4 路并发上限，标记 `[Gravity Title Organizer]` 防污染，用毕立即关闭）切换 `gemini-4-hydrogen` + `thought_level=medium`，界面实时提示正在使用 `Hydrogen (medium)`；「全部整理」自动跳过已整理会话（`titleOrganizedAt` 持久化于 `titles.json`），单项目与单会话按钮可显式重整；三个入口共享 1 分钟最多 4 次滑动窗口冷却（`TITLE_ORGANIZE_RATE_LIMIT`）。
- **中文思考显影动效**：`useFluidStreamText` 的 `morph` 模式按公共前缀推进，修复英文被更短中文替换时的瞬时闪切；`ThinkingBlock` 外层在翻译/切换轨道时叠加流光左轨与 260ms 柔和显影，不改动内部 `<p>` 节点与排布尺寸。
- **正文图片复制与分屏焦点美化**：`openLinkOrFileTarget` 支持 `action: 'copy-image'`（主进程通过 `nativeImage` + `clipboard.writeImage` 写入系统位图剪贴板，仍经敏感凭据路径校验），支持缩略图悬浮按钮、大图预览工具栏 / `Ctrl+C` 与右键菜单复制；双栏聚焦窗格去除两标题间生硬横线，改用与活动栏/侧栏统一的「标题左侧 3px 柔砂竖胶囊 + 前景/退后表面景深 + 非聚焦输入区柔和退隐」（不影响 `.pane[data-pane-state="streaming"]::before` 动画接缝）。
- **自动化守卫**：`tests/v020-features.test.ts` 与 `tests/v020-ui.test.tsx`。

---

## 九、v0.3.1 正文排版、图文文件分区混排、暂停/错误诊断与跨平台适配约定

- **本地媒体只读校验与严格分区混排**：
  - `src/shared/media-contract.ts` 集中维护扩展名过滤（`isBareExtensionOrFragment` / `isPlausibleLocalFileCandidate`，过滤 `.svg`/`.png`/`.ico`/`-mac.png` 等裸后缀噪音）与文件名/行号徽章提取（`extractTargetBaseName` / `extractLineAnchorBadge`）。
  - `src/main/services/local-media-inspector.ts` 与 `src/main/workspace/local-path-safety.ts` 提供只读、有界字节上限（64KB 头部尺寸嗅探、4MB 单图预览、24MB 总预算、48 目标/批、32MB LRU 缓存）与符号链接/挂载点规范化校验的本地目标检查（IPC `APP_INSPECT_LOCAL_TARGETS`），阻断全部敏感凭据路径并将可执行脚本/macOS `.app` 降级为「在文件夹/访达中显示」。
  - `src/renderer/components/Markdown.tsx` 与 `src/renderer/components/MediaGallery.tsx` 实现行内干净文件链接胶囊（不再把原始 `file:///` URI 拼进可见文案）、独立成段图片原位 `<figure data-testid="md-inline-figure">` 渲染与去重，以及底部 `data-testid="message-previews"` 的严格两区分离：Zone A（`.md-media-gallery` 显式 `@container pane` 2/3/4 列网格 + 多图宽幅 Hero 铺展 + 格式/分辨率元信息 + `>6` 折叠展开）与 Zone B（`.md-files-tray` 非图片文件/目录托盘，绝不与图片混格）。
- **结构化对话暂停、截断与错误恢复诊断**：
  - `src/shared/diagnostic-contract.ts` 与 `src/main/services/session-diagnostics.ts` 统一 14 类中断/暂停/断连/限流诊断模型（`TurnStopState` / `SessionDiagnosticBanner`），配合 `EVENT_CONNECTION_UPDATED` 实时广播连接状态与 `429`（≥60s）/ `403`（≥300s）冷却截止时间。
  - `src/renderer/components/TurnDiagnosticCard.tsx` 提供中英双语标题、原因、可执行建议、可折叠技术详情、实时冷却倒计时（冷却期自动禁用重试/继续）与一键合规恢复动作（绝不自动切号）。
- **WCAG 2.1 AA 主题与 macOS 原生适配**：
  - 6 套预设主题与 `deriveAccessibleTokens()` 全部校准至 WCAG 2.1 AA（≥ 4.5:1）；`src/renderer/lib/platform-keys.ts` 与 `I18nContext` 统一管理 macOS 严格 `⌘` 快捷键、IME 组合态保护、POSIX 绝对路径/`~/` 解码、全链路「在访达中显示 / Show in Finder」与交通灯安全区 Lightbox。
- **自动化守卫**：`tests/v031-media-inspector.test.ts`、`tests/v031-pause-error-lifecycle.test.ts`、`tests/v031-backend-plugin-bugs.test.ts`、`tests/v031-markdown-mixed-media.test.tsx`、`tests/v031-pause-error-ux.test.tsx`、`tests/v031-frontend-plugin-bugs.test.tsx`、`tests/v031-macos-compat.test.ts`、`tests/v031-visual-e2e-and-screenshots.cjs`。

---

## 十、v0.3.6 本地优先离线语音、Plan 四态检视器、统一批注协议与跨端精修约定

- **本地优先离线语音听写**：
  - 共享契约 `src/shared/voice-contract.ts` 与主进程 `src/main/voice/` 实现租约制单槽独占采音（`VOICE_ARM_CAPTURE` / `VOICE_APPEND_PCM` / `VOICE_FINISH_CAPTURE` / `VOICE_ABORT_CAPTURE` / `VOICE_TEST_CONNECTION` 等共 12 条新语音 IPC），单次上限 210s / 6.72 MB（16 kHz 单声道 PCM16）与 `3s` 本机采音试录（`mic-test` 0 外联 / 0 `voiceFinish`）；
  - 渲染层 `src/renderer/lib/voice/pcm-worklet.ts` + `controller.ts` + `hooks/useVoiceCapture.ts` 经独立构建的 `AudioWorklet` 模块（`pcm-worklet-*.js`）在 `file://` + 严格 `script-src 'self'` CSP 下采集 PCM16 并仅在 `voiceAppend` 白名单通道校验传输；支持断连麦克风 `OverconstrainedError` / `NotFoundError` 自动回退默认设备、组件卸载立即释放音频轨与 `AudioContext`；
  - 外部转写（OpenAI 兼容 / Gemini Developer API）强制实测短语音转写通过后方可启用，支持清空单价（`null` / `undefined` / 空串持久化恢复为未设置，保留 `0` 为有效单价）、独立费用账本与 401 失验 / 403 / 429 双序熔断。
- **Plan 检视器统一 4 态与按需原文抽屉**：
  - `src/main/session/plan-outline.ts` 与 `plan-artifact-reader.ts` 拆出独立 `summaryRevision` / `contentRevision` 轻量摘要与完整正文双视图，避免轮询正文开销；
  - `RightInspector.tsx` + `PlanTimeline.tsx` + `PlanArtifactPanel.tsx` 统一为 `empty / unavailable / outline / execution` 四态，仅在点击底部摘要条时展开只读 `PlanSourceDrawer`（Mermaid 围栏折叠、GFM 提示框、窗口捕获阶段 `Esc` + IME 防护、0 `<img>`）。
- **批注与引用统一展示顺序（`src/shared/message-annotation.ts`）**：
  - 新发送消息将用户自由正文置于顶部、附带划词批注卡紧随其后展示，并由共享元数据与解析器统一同步至历史消息展示与 `EditUserMessage` 原地编辑回显，零重复拼接。
- **macOS 原生细节与发版链路加固**：
  - `App.tsx` 交通灯安全区按 `14 + 64 / scale` 对齐主进程 `macButtonPosition(scale)`，`mac.css` 全覆盖 `.popover`/`.settings`/`.modal`/`.quota-view` `no-drag` 与 `.composer-more-menu` 玻璃态一致，`.settings`/`.modal` 高度严格约束于 `.overlay` 内不侵入顶栏拖拽条；
  - `assets/quota/read-quota-macos.sh` 看门狗改由独立 `/bin/sh -c` 启动以避免 SIGKILL 自杀，彻底清理 PTY 进程组与 `.tmp`；`.github/workflows/release.yml` 使用单引号 `cat <<'EOF'` 防反引号命令替换。
- **自动化守卫**：`tests/v036-backend-voice-and-security.test.ts`、`tests/v036-backend-plan-annotation-and-fixes.test.ts`、`tests/v036-frontend-voice-and-ui.test.tsx`、`tests/v036-frontend-plan-and-annotations.test.tsx`、`tests/v036-visual-e2e.cjs`、`tests/windows-package-smoke.cjs`（`PKG-V1..V4`）。
