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

**任何代码变更严禁突破以下任一红线（自动化回归守卫位于 `tests/security-baseline.test.ts`、`tests/acp-boundaries.test.ts`、`tests/accounts-v02.test.ts`、`tests/history-import-v02.test.ts`）：**

1. **严禁触碰任何私有凭据或认证状态文件**
   - 严禁读取、解析、复制、移动、解密或导出 `~/.gemini`、`antigravity`、`antigravity-cli` 或隔离 Profile 目录下的任何 OAuth Token、`refresh_token`、`access_token`、Cookie、`installation_id`、`*.pbtxt`、`state.vscdb*`、`application_default_credentials.json` 或密钥文件。
   - 路径拦截契约见 `src/shared/accounts-history-contract.ts` 中的 `isForbiddenCredentialOrStatePath()`。

2. **本地历史会话同步必须 100% 纯只读、零写入**
   - `src/main/history/history-importer.ts` 仅允许读取 `isAllowedReadOnlyHistoryFile()` 白名单内的用户对话记录（`transcript.jsonl`、历史日志、`conversation_summaries.db` 临时副本只读查询）。
   - 对官方目录必须保持 **0 字节写入、0 新增文件**；在 Gravity 中“继续对话”只能新建标准 `agy acp` 会话并附带文本摘要，绝不反向改写原历史文件。

3. **多账号隔离仅限官方 `--app-data-dir` + 100% 用户手动切换（严禁自动轮换切号）**
   - 多账号通过为不同 Profile 分配客户端私有空目录并传入官方公开参数 `agy acp --app-data-dir <isolatedDir>` 实现，登录仅能由用户点击按钮拉起可见终端运行 `agy acp [--app-data-dir ...] --login`。
   - **零容忍红线**：严禁在遇到 `429`、`403`、`RESOURCE_EXHAUSTED` 或连接异常时自动切换 Profile 或轮询多个账号绕过单账号配额（Account Rotation 属于严重违规行为）。

4. **严禁调用任何非公开 Google 内部端点或传入内部伪装参数**
   - 严禁在代码中出现或请求 `cloudcode-pa.googleapis.com`、`daily-cloudcode-pa` 等非公开内部接口。
   - 启动 `agy` 时必须经过 `validateAgyArgs()` 白名单校验（`src/main/acp/acp-client.ts`），严禁传入 `--dangerously-skip-permissions`、`--override_user_agent_name`、`--cloud_code_endpoint`、`--use_stubby_auth`、`--is_google3_workspace`、`--is_google_internal` 等参数，且 `spawn` / `execFile` 必须固定 `shell: false`。

5. **严禁篡改官方二进制或劫持运行环境**
   - 仅以只读方式定位并拉起原版 `agy` / `agy.exe`，严禁二进制补丁、DLL 注入或注入 `NODE_OPTIONS` / `ELECTRON_RUN_AS_NODE`。

6. **蜂群翻译与本地审批分别使用其配置的资源**
   - G-Gravity 的默认蜂群模式在新建会话时让主模型创建可见的翻译成员。思考块通过该成员的 ACP 对话翻译，消息和蜂群面板显示其状态。恢复时先核对所属 Profile、父会话和成员的登记回报。
   - 设置选择本地模式后，公开的英文思考片段在本地工作线程使用随包的 Bergamot 英译简中模型翻译。蜂群不可用也可回落到本机。收起思考只改变显示。模型来源见 assets/local-translation/sources.json。
   - 审批和标题整理遵循原有本地规则。独立复审服务使用用户显式配置的端点，API Key 通过操作系统级加密（Electron `safeStorage`：Windows DPAPI / macOS 钥匙串）独立存储密文，明文永不写入配置 JSON，版本更新与重启自动保留。

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
    - Cost 面板必须保留免责声明：「参考 API 价格估算，非实际账单 / Estimated from reference API pricing, not an actual bill」。

---

## 三、前后端架构速查

### 1. 三层职责边界
- **`src/shared/`**：纯 TypeScript 类型契约与无副作用校验纯函数（供 `tsconfig.main.json` 与 `tsconfig.renderer.json` 共同编译）。
- **`src/main/`**：Electron 主进程。核心入口为 `CoreService`（`src/main/core-service.ts`），协调 `AcpClient`、`SessionMultiplexer`、`AccountManager`、`HistoryImporter`、`PluginsManager`、`ApprovalEngine`、`TelemetryStore`、`InspectorStore`、`SwarmTracker` 等模块，并通过 `ipc-router.ts` 暴露给渲染层。
- **`src/renderer/`**：React 19 单页工作台，所有跨进程调用统一收敛在 `src/renderer/services/desktop-bridge.ts`。

### 2. 前端关键组件地图（`v0.3` 当前结构）
- **布局骨架**：`App.tsx` → `TopBar.tsx` + `ProjectSidebar.tsx` + `SessionWorkspaceGrid.tsx` + `RightInspector.tsx`
- **会话与输入**：
  - `SessionPane.tsx`：单个会话窗格（空状态引导、消息时间线、工具卡片流、内联审批聚焦管理、底部 Composer 挂载）。
  - `Composer.tsx`：多行自适应输入框、`/` Slash 菜单、`@` 文件/会话补全、剪贴板贴图、顶部 `ContextStatusBar`、左下 Mode & 审批档位切换、右下 Model & Effort 选择。
  - `Markdown.tsx`：安全自研 GFM Markdown 渲染器（不启用原始 HTML 注入，代码块带语言栏与复制按钮）。
  - `InlineRequestView.tsx`：Claude Code 风格 `1–4` 快捷键内联审批卡片（`SessionPane` 保证同一时刻仅首张待审卡片响应数字快捷键）。
  - `ToolCallCard.tsx` / `UnifiedDiffBlock.tsx` / `ThinkingBlock.tsx`：工具调用折叠行、红绿行级 Diff、双轨思考折叠块。
- **右侧检视器**：
  - `RightInspector.tsx`：`Diff`、`Files`、`Plan`、`Terminal`、`Context`、`Swarm` 六个 Tab 切换与拖拽调宽。
  - `ContextCostInspectorView.tsx`：上下文构成条、`24h / 7d / 30d` Token 热力图、分模型四维费用构成（堆叠条 + SVG 环形图）。
  - `SwarmPanel.tsx`：多智能体拓扑与消息流面板。
- **统一全屏设置中心（`Ctrl+,` / `Escape` 关闭）**：
  - `SettingsView.tsx`：左侧分组导航（通用、外观、自定义配色、应用图标、账号、Approve for me、Plugins、Cost 单价、关于）。
  - `settings/AppearancePanels.tsx`：语言/思考轨/进程隔离开关、6 套预设主题卡片、23 色 Token 自定义取色与 JSON 导入导出、6 套原创图标切换。
  - `settings/WorkspacePanels.tsx`：ACP 连接状态与官方登录 + 多 Profile 手动隔离管理、`Approve for me` 规则与审计日志、`Plugins / MCP / Skills` 面板、模型单价表编辑。
- **设计系统与响应式分屏**：
  - `styles/theme.ts` 将当前主题的 23 个基础颜色写入 `:root` CSS 变量；
  - `styles/global.css` 使用 `color-mix(in srgb, ...)` 派生边框、悬浮态、半透明徽章与阴影，无需硬编码深浅色分支；并通过 `container-type: inline-size`（`@container pane`）让双分屏与 2×2 四宫格下的窄窗格自动紧凑排版。

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
  - `src/renderer/components/RightInspector.tsx`：新增「停靠 ↔ 悬浮（Docked / Floating）」切换按钮（`inspector-float-toggle`，通过 `data-inspector-mode` 区分，偏好持久化至 `localStorage['gravity.inspector.floating']`）与收起按钮（`inspector-close-btn`），两者置于 `.inspector-head-actions`，保持 `.inspector-head` 为纯净的 5 项 `role="tablist"`（0 个 `role="button"`，满足布局冒烟契约）。
  - `src/renderer/components/SessionPane.tsx` / `TurnActivity.tsx` / `InlineRequestView.tsx`：重构 `WelcomePane`（柔和陶土光晕 + 衬线编辑风问候 + 快捷键栏）、在收起态 `Activity · N` 摘要条中加入工具语义色微点（`.tool-cat-dot`），并将审批卡片的 `1.`–`4.` 前缀升级为触感键帽（`.option-num`）且保持 `.textContent` 与旧版完全一致。
  - `src/renderer/styles/claude-studio.css`：在 `design-system.css` 之后加载的 Claude Code Studio 视觉层（暖炭黑/羊皮纸阶梯表面、暖陶土强调色、悬浮岛输入卡片、双栏窄窗格 Composer 防溢出容器查询、悬浮检视器玻璃拟态层），同步在 `src/renderer/main.tsx` 与 `tests/desktop-layout.fixture.tsx` 引入。
- **自动化守卫**：`tests/v016-claude-studio.test.tsx` 覆盖活动栏、抽屉选中高亮与清除搜索、检视器停靠/悬浮切换及纯净 tablist、工具语义微点与审批键帽。

---

## 八、v0.2.0 体验与内置 AI 标题整理升级（前后端约定）

- **右下角独立色系额度条与重设计弹层**：`AccountQuotaView.tsx` 移除 `ctx` 左侧的独立额度按钮，统一收拢至对话框右下角以「百分比 + 进度条（`--quota-fill` 钴蓝独立色系，区别于 `ctx` 绿条）」展示；弹层重设计为右下锚定玻璃卡片 + 2 列 Bento 仪表格。
- **实时 TPS vs 会话平均 TPS & 平均缓存命中率**：`TelemetryStore` 新增每会话累计速度统计（`sessionSpeedStats`，落盘 `session-telemetry.json`）与 `averageTokensPerSecond`、`averageCacheHitRate`（`cachedInput / (input + cachedInput)`）。对话框底栏 `ContextStatusBar` 展示实时滑窗速率（`currentTokensPerSecond`），右侧 Context 检视器 `ContextCostInspectorView` 展示当前会话平均速率与平均缓存命中率。
- **内置 Hydrogen (medium) 标题整理与共享冷却**：`CoreService.organizeTitles` 严禁自动触发，仅在用户主动点击侧栏「全部整理 / 单项目整理 / 单会话整理」按钮时执行；通过官方 `agy acp` 临时只读会话（遵守 4 路并发上限，标记 `[Gravity Title Organizer]` 防污染，用毕立即关闭）切换 `gemini-4-hydrogen` + `thought_level=medium`，界面实时提示正在使用 `Hydrogen (medium)`；「全部整理」自动跳过已整理会话（`titleOrganizedAt` 持久化于 `titles.json`），单项目与单会话按钮可显式重整；三个入口共享 1 分钟最多 4 次滑动窗口冷却（`TITLE_ORGANIZE_RATE_LIMIT`）。
- **中文思考显影动效**：`useFluidStreamText` 的 `morph` 模式按公共前缀推进，修复英文被更短中文替换时的瞬时闪切；`ThinkingBlock` 外层在翻译/切换轨道时叠加流光左轨与 260ms 柔和显影，不改动内部 `<p>` 节点与排布尺寸。
- **正文图片复制与分屏焦点美化**：`openLinkOrFileTarget` 支持 `action: 'copy-image'`（主进程通过 `nativeImage` + `clipboard.writeImage` 写入系统位图剪贴板，仍经敏感凭据路径校验），支持缩略图悬浮按钮、大图预览工具栏 / `Ctrl+C` 与右键菜单复制；双栏聚焦窗格去除两标题间生硬横线，改用与活动栏/侧栏统一的「标题左侧 3px 柔砂竖胶囊 + 前景/退后表面景深 + 非聚焦输入区柔和退隐」（不影响 `.pane[data-pane-state="streaming"]::before` 动画接缝）。
- **自动化守卫**：`tests/v020-features.test.ts` 与 `tests/v020-ui.test.tsx`。
