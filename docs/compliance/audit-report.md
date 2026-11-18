# Gravity (v0.2.0) — Google ToS 与账号安全合规终审报告

- **审计结论**：`COMPLIANCE_PASS`（零阻断项通过）
- **审计版本**：`gravity@0.2.0`（Phase 2 重构终审，覆盖原 Phase 1 `v0.1.0` 全量安全基线与 v0.2 新增架构）
- **审计对象**：`F:\插件-Gemini` 全仓源码、共享契约、原创图标资产、构建配置及自动化测试套件（共 **135** 个非构建/非依赖仓库文件）
- **审计员**：`@compliance`（Google ToS 与账号安全合规审计官）
- **审计时间**：2026-11-17

---

## 一、审计范围与全量文件清单（逐行实审）

本次终审严格基于真实源码逐行检视（`read_file` 全量覆盖）与全仓正则表达式静态扫描交叉核验，未依赖任何口头声明：

| 目录分类 | 文件数 | 已逐行审计文件明细 |
| :--- | :---: | :--- |
| **根目录与工程配置** | 9 | `.gitignore`, `package.json`, `index.html`, `vite.config.ts`, `vitest.config.ts`, `tsconfig.json`, `tsconfig.shared.json`, `tsconfig.main.json`, `tsconfig.renderer.json` |
| **架构与合规文档** | 2 | `docs/architecture.md`, `docs/compliance/audit-report.md` |
| **原创 Gravity 图标资产** | 36 | `assets/icons/` (18 个) 与 `public/icons/` (18 个)：`gravity-claude-dark`、`gravity-claude-light`、`gravity-ubuntu`、`gravity-macos-dark`、`gravity-macos-light`、`gravity-solarized` 各含 `.svg` / `.png` / `.ico` |
| **共享契约层 (`src/shared/`)** | 10 | `index.ts`, `acp-protocol.ts`, `approval-contract.ts`, `telemetry-contract.ts`, `session-contract.ts`, `swarm-contract.ts`, `theme-i18n-contract.ts`, `plugins-contract.ts`, `accounts-history-contract.ts`, `ipc-channels.ts` |
| **Electron 主进程 (`src/main/`)** | 19 | `index.ts`, `ipc-router.ts`, `preload.ts`, `core-service.ts`, `acp/acp-client.ts`, `accounts/account-manager.ts`, `history/history-importer.ts`, `plugins/plugins-manager.ts`, `workspace/workspace-files.ts`, `session/session-multiplexer.ts`, `session/inspector-store.ts`, `approval/approval-engine.ts`, `approval/shell-screening.ts`, `approval/external-reviewer.ts`, `telemetry/telemetry-store.ts`, `translation/thought-translator.ts`, `organizer/title-organizer.ts`, `swarm/swarm-tracker.ts`, `storage/client-store.ts` |
| **React 渲染层 (`src/renderer/`)** | 28 | `main.tsx`, `App.tsx`, `styles/theme.ts`, `styles/global.css`, `i18n/I18nContext.tsx`, `i18n/locales.ts`, `services/desktop-bridge.ts`, `components/{TopBar,ProjectSidebar,SessionWorkspaceGrid,SessionPane,ReadOnlyHistoryView,RightInspector,ContextCostInspectorView,ContextStatusBar,InlineRequestView,ToolCallCard,UnifiedDiffBlock,ThinkingBlock,ApprovalDrawer,ThemeSettingsModal,PluginsModal,AccountsModal,AboutModal,TitleOrganizerModal,NewSessionModal,SwarmPanel,TelemetryPopover}.tsx` |
| **测试套件与夹具 (`tests/`)** | 31 | `shared-contracts.test.ts`, `shared-v02.test.ts`, `accounts-v02.test.ts`, `history-fixture.test.ts`, `history-import-v02.test.ts`, `plugins-v02.test.ts`, `telemetry-v02.test.ts`, `workspace-inspector-v02.test.ts`, `session-options-v02.test.ts`, `core-v02.test.ts`, `frontend-foundation.test.tsx`, `app-v02-extra.test.tsx`, `acp-boundaries.test.ts`, `acp-host.test.ts`, `approval-engine.test.ts`, `backend-state.test.ts`, `core-service.test.ts`, `security-baseline.test.ts`, `app-native-core.test.tsx`, `app-ui.test.tsx`, `mock-acp.test.ts`, `official-acp-smoke.test.ts`, `helpers/{core-bridge,history-fixture,mock-acp-server,stdio-rpc}.ts` 及阶段测试记录 |

---

## 二、十大合规红线逐项核验结果

### 1. 零私有凭据触碰 & 本地历史纯只读零写入（v0.2 调整版红线 1）— **PASS**

- **凭据硬黑名单零读取**：
  - `src/shared/accounts-history-contract.ts`（第 74–94 行）定义 `isForbiddenCredentialOrStatePath()`，强制拦截一切 `oauth`、`token`、`refresh_token`、`access_token`、`id_token`、`cookie`、`credential`、`secret`、`password`、`installation_id`、`*.pbtxt`、`state.vscdb*`、`*.pem/*.key/*.p12/*.pfx/*.enc` 及 `application_default_credentials.json`。
  - 全仓静态扫描确认：业务源码（`src/main/`、`src/renderer/`）**零处**读取、复制、移动、解密或导出任何官方认证 Token / Cookie / SQLite 凭据库。
- **本地历史白名单只读导入与 100% 零写入保护**：
  - `src/shared/accounts-history-contract.ts`（第 99–114 行）定义 `isAllowedReadOnlyHistoryFile()`，仅放行用户本人的会话内容文件（`antigravity/brain/<id>/.system_generated/logs/transcript.jsonl`、`antigravity-cli` 下 `conversations/brain/history` 日志及 `conversation_summaries.db` / `-wal`），且前置调用 `isForbiddenCredentialOrStatePath()` 先行否决任何伪装路径。
  - `src/main/history/history-importer.ts`（第 29–79、110–162 行）：
    1. 构造期强制校验 `cacheDir` 不得命中敏感路径且不得位于任何历史源根目录下（第 31 行）；
    2. 扫描期执行 `fs.lstat`（拒绝软链接）+ `fs.realpath`（验证真实路径未越界）+ 双重黑白名单校验（第 43–67 行），同目录存在 `transcript.jsonl` 时跳过 `transcript_full.jsonl` 避免重复大文件读取（第 54 行）；
    3. 解析 `conversation_summaries.db` 时，仅以 `fs.readFile` 读取源库字节（及通过同级校验的 `-wal` 字节，绝不读 `-shm`），随后写入客户端专属临时目录 `history-cache/history-<uuid>/`（权限 `0o700`/`0o600`），对该客户端临时副本执行 `new DatabaseSync(snapshot, { open: true, readOnly: true })` 及 `PRAGMA query_only=ON; PRAGMA trusted_schema=OFF;`，并在 `finally` 块彻底删除临时 `.db`/`-wal`/`-shm`/`-journal` 与目录（第 128–161 行）。对 `~/.gemini` 与 `antigravity` 源目录实现 **100% 零字节写入、零新增文件、零元数据污染**。
  - **续聊隔离**：`CoreService.continueHistoryInGravity`（`src/main/core-service.ts` 第 296–302 行）仅通过标准 `createSession` 新建实时 ACP 会话并将 `summarySnippet` 作为参考文本发送，绝不改写原历史文件。
- **客户端存储物理隔离**：
  - `src/main/storage/client-store.ts`（第 9–28 行）禁止使用包含 `.gemini` 或 `antigravity-cli` 的目录作为客户端存储目录；`src/main/index.ts`（第 42 行）固定使用独立 `join(app.getPath('userData'), 'gravity-client-data')`。

### 2. 多账号官方 `--app-data-dir` 隔离 & 严禁自动轮换切号（v0.2 新增铁律）— **PASS**

- **仅走官方认证入口与官方目录隔离参数**：
  - `src/main/accounts/account-manager.ts`（第 25–107 行）：默认 Profile 直接运行 `['acp']`；用户手动新建的隔离 Profile 使用客户端自有目录下 `profiles/<uuid>`，通过官方公开 CLI 参数 `agy acp --app-data-dir <profileDir>`（`src/shared/acp-protocol.ts` 第 62–66 行白名单放行）交由原版 `agy` 独立管理登录态。
  - 登录与登出仅支持用户点击触发可见终端 `agy acp [--app-data-dir <dir>] --login`（第 95–101 行）及官方 ACP RPC `auth/logout`（第 103–106 行）；界面仅展示 ACP `initialize` 暴露的公开 `agentInfo` / `authMethods`（`AccountsModal.tsx` 第 136–170 行）。
  - 删除非默认 Profile 时仅移除客户端 `profiles.json` 元数据条目，绝不扫描、复制或接触隔离目录内的官方凭据文件（`account-manager.ts` 第 66–73 行）。
- **100% 纯手动切换，零自动账号轮换**：
  - `AccountManager.switchProfile(profileId)` 仅绑定至 IPC 通道 `gravity:accounts:switch-profile`（对应渲染层用户在 `AccountsModal.tsx` 第 248–258 行手动点击切换按钮）；`CoreService.updatePreferences`（`src/main/core-service.ts` 第 180 行）显式拒绝通过普通偏好修改 `activeProfileId`。
  - 当 `AcpClient` 遇到 HTTP `429`、`403`、`RESOURCE_EXHAUSTED` 或连接断开时（`src/main/acp/acp-client.ts` 第 160–167 行），仅触发当前连接指数退避熔断冷却并向界面推送告警，**绝不调用 `switchProfile`、`login` 或自动轮询其他 Profile 绕过单号配额限制**（已由源码审计及 `tests/accounts-v02.test.ts` 实跑验证）。

### 3. 零非公开端点与零内部伪装 Flag — **PASS**

- **内部 Flag 硬拦截**：
  - `src/shared/acp-protocol.ts`（第 72–97 行）定义 `FORBIDDEN_AGY_FLAGS` 与 `validateAgyArgs()`，强制阻断 `--dangerously-skip-permissions`、`--override_user_agent_name`、`--cloud_code_endpoint`、`--use_stubby_auth`、`--is_google3_workspace`、`--is_google_internal` 及任何非白名单 `-` 前缀参数。
  - `src/main/acp/acp-client.ts`（第 69、101 行）在子进程启动与登录拉起前强制调用 `validateAgyArgs()`，且固定 `shell: false`。
- **零私有端点调用**：
  - 全仓扫描确认运行源码中不存在任何 `cloudcode-pa.googleapis.com`、`daily-cloudcode-pa` 或内部 gRPC/Protobuf 接口请求。
  - 唯一可选外部 HTTP 模块 `src/main/approval/external-reviewer.ts`（第 13–36、59 行）锁定以下安全约束：
    1. 本地离线端点仅允许 `http://127.0.0.1` 或 `http://[::1]`；
    2. 云端公开 API 仅允许用户自备 Key 访问 `https://generativelanguage.googleapis.com` 或 `https://api.openai.com`；
    3. 严禁 URL 内嵌凭据、查询参数或 `cloudcode-pa` 域名，且 `fetch` 强制 `redirect: 'error'` 防 SSRF 重定向越权；
    4. 用户填写的公开 API Key 仅驻留内存，写入 `approval-config.json` 前强制 `delete persisted.externalReviewer.apiKey`（`src/main/core-service.ts` 第 56–57、266–267 行）。

### 4. 官方二进制零篡改、权限安全闭环 & 官方 CLI 插件管理（v0.2 第 7 项）— **PASS**

- **原版二进制只读调用**：`discoverAgyBinary()`（`src/main/acp/acp-client.ts` 第 25–43 行）仅定位可执行文件路径并以 `spawn(..., { shell: false })` 标准 stdio 通信，零二进制补丁、零 DLL/环境变量劫持（拦截 `NODE_OPTIONS` / `ELECTRON_RUN_AS_NODE`，第 45–50 行）。
- **内联审批防重放与 Fail-Closed**：
  - `src/main/approval/approval-engine.ts`（第 118–190 行）通过 `resolving` 锁防止并发双击重复放行，且所有放行决策仅映射至 ACP `allow_once`（绝不下发永久盲放 `allow_always`），审计日志 `audit.jsonl` 写入失败时立即 Fail-Closed 取消执行。
  - `src/shared/approval-contract.ts`（第 127–194 行）与 `InlineRequestView.tsx`（第 83–91、101–127、246–272 行）提供 Claude Code 风格 1–4 编号选项；当后端词法快筛判定命令无安全前缀（如复合管道、重定向、高危命令）时，第 2 项（本会话前缀记忆）强制禁用。`SessionPane.tsx`（第 225–234、595、610 行）锁定唯一 `primaryShortcutRequestId` 配合 `e.stopImmediatePropagation()`，确保同一窗格存在多张待审批卡片时单次数字键 `1–4` 绝不会批量误放行多项请求。
- **Plugins / MCP / Skills 严格走官方 CLI 且零内部配置改写**：
  - `src/main/plugins/plugins-manager.ts`（第 13–115 行）：
    1. 构造函数与 `CoreService.getBootstrap()` 仅读取内存缓存 `getCachedSnapshot()`（`src/main/core-service.ts` 第 172 行），启动期**零 CLI 子进程冷启动**；
    2. 仅当用户在 `PluginsModal.tsx` 显式点击刷新或增删启停时，才通过 `execFile`（强制 `shell: false`, `windowsHide: true`, `timeout: 30000`）串行互斥执行官方 `agy plugin list --json | install | uninstall | enable | disable` 与 `agy mcp list | add | remove | enable | disable`；
    3. `isSafePluginTarget` 与 `isSafeMcpServerName`（`src/shared/plugins-contract.ts` 第 101–137 行）严禁 `-` 开头参数注入、空白符与 `..` 路径穿越；`mcp add` 在命令与参数前强制插入 `--` 分隔符（`plugins-manager.ts` 第 75 行），并对命令回显执行 Bearer/API Key/URL 凭据脱敏（第 20 行）；
    4. Skills 发现仅只读解析公开 `SKILL.md` YAML 头（经 `isForbiddenCredentialOrStatePath` + `realpath` + `lstat` 校验），启用开关仅保存在客户端自有 `skill-preferences.json`（第 110–114 行），**绝不直接修改 `agy` 内部 `settings.json` 或 `mcp_config.json`**；
    5. 内置能力 `Approve for me` 与 `Context & Cost Inspector` 固定标记为 `Built-in`（`plugins-contract.ts` 第 21–38 行）。

### 5. 零订阅额度自审滥用（彻底根治进程风暴与会话污染）— **PASS**

- **内联审批零 `agy` 子进程**：`shell-screening.ts` 本地毫秒级词法快筛 + 会话安全前缀记忆 + 可选外部独立 API Key 复审，全程在主进程内存完成，**零 `agy -p` 或隐藏 `session/new` 调用**。
- **思考翻译与标题**　默认蜂群译员使用当前官方账号额度。设置中的离线翻译和本地标题整理在本机执行。
- **Swarm 看板**　呈现当前会话的成员和任务事件。主动发起任务通过当前会话的官方协议执行。

### 6. 并发会话硬上限（≤ 4）与 429/403 指数退避熔断 — **PASS**

- **并行槽位硬上限**：`MAX_PARALLEL_ACTIVE_SESSIONS = 4`（`src/shared/session-contract.ts` 第 11 行），在 `SessionMultiplexer.reserve()`（`src/main/session/session-multiplexer.ts` 第 58–61 行）、`CoreService.saveWorkspaceLayout()`（第 257 行）及前端多标签/四宫格视图（`App.tsx` 第 561–570 行、`SessionWorkspaceGrid.tsx` 第 90–125 行）三端同步强制执行。
- **429 / 403 熔断冷却**：`AcpClient`（`src/main/acp/acp-client.ts` 第 80–82、160–167 行）捕获 `429` / `RESOURCE_EXHAUSTED` 立即冷却至少 60 秒（指数退避上限 300 秒），捕获 `403` 立即冷却 300 秒；冷却期内直接本地拦截后续 RPC 请求，严禁后台死循环重试。

### 7. 本地监听边界、Electron 沙箱 CSP、自定义主题安全与原创图标（v0.2 第 3/5/6/8 项）— **PASS**

- **仅本机回环地址**：`vite.config.ts`（第 13 行）锁定 `host: '127.0.0.1'`、`strictPort: true`；`src/main/index.ts`（第 24–28、60–65 行）锁定单实例锁、仅允许加载打包本地 `index.html` 或 `http://127.0.0.1`，拦截一切 `will-navigate` 与 `setWindowOpenHandler` 外链跳转。全仓零 `0.0.0.0` 监听。
- **Electron 强沙箱与最小桥接**：
  - `src/main/index.ts`（第 52–58 行）强制 `contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`、`webSecurity: true`。
  - `index.html`（第 6–9 行）注入严格 CSP：`default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`。
  - `src/main/ipc-router.ts`（第 7–15 行）强制校验 `event.sender === webContents && event.senderFrame === webContents.mainFrame`、参数个数（≤ 3）与载荷体积，阻断非主 frame 调用；`preload.ts` 仅依赖 `electron` 并以 `Object.freeze` 暴露白名单桥接 `window.gravityDesktop`（兼容 `window.agyDesktop`）。
- **自定义主题 JSON 防注入白名单**：
  - `src/shared/theme-i18n-contract.ts`（第 424–493 行）定义 `isValidCssColorToken()` 与 `validateCustomThemeConfig()`，仅允许 `#RGB/#RRGGBB/#RRGGBBAA`、`rgb()/rgba()`、`hsl()/hsla()` 纯色值，硬性拦截 `;`、`{`、`}`、`url(...)`、`expression(...)`、`var(...)` 与 `<script>`，防止通过导入主题 JSON 触发 CSS 外链泄露或样式注入。
- **Cost 四维估算透明声明**：
  - `src/shared/telemetry-contract.ts`（第 22–26 行）与 `ContextCostInspectorView.tsx`（第 386–392 行）、`ThemeSettingsModal.tsx`（第 726 行）固定展示免责声明「参考 API 价格估算，非实际账单 / Estimated from reference API pricing, not an actual bill」，已彻底移除旧版 52 周热力图与误导性订阅对比。
- **100% 原创 Gravity 图标资产（零商标侵权）**：
  - 逐一核验 `assets/icons/` 与 `public/icons/` 下全部 6 套 × 3 格式共 36 个图标文件：SVG 源码与 PNG/ICO 位图均为客户端原创几何设计（引力轨道弧线 + 卫星圆点 + `>_` 终端提示符），无任何外链脚本或 `<foreignObject>`，**100% 不包含 Anthropic / Claude 商标图形、星芒 Logo 或吉祥物元素**。

---

## 三、残留风险说明与安全使用建议

1. **外部灰区复审 API 密钥管理**：客户端默认采用本地词法快筛与规则引擎（外部复审默认关闭）；若用户主动开启外部独立模型辅助复审，请仅填写个人 Google AI Studio 或 OpenAI 兼容公开 API Key（客户端仅保存在运行内存，重启自动清空且绝不落盘）。
2. **多账号 Profile 手动使用规范**：请仅在确有个人/工作环境隔离需求时，通过左下角「账号 Profile」面板手动切换隔离环境并由本人在弹出终端完成官方登录；切勿使用任何外部自动化脚本驱动高频切号。
3. **Plugins / MCP 命令执行上下文**：面板中的插件与 MCP 操作直接调用本机原版 `agy plugin` / `agy mcp` 子命令，默认作用于官方 CLI 标准配置目录；安装第三方插件或添加 `stdio` MCP Server 前请确认来源可信。

---

## 四、`v0.3` 前端重构增量复核说明（2026-11-17）

- **变更范围**：仅限渲染层 `src/renderer/`（共 27 个文件）及 `tests/app-ui.test.tsx` 的两处 UI 交互断言适配；`src/shared/` 与 `src/main/` 零改动。
- **组件映射更新**：原报告中提及的独立弹窗组件（`AccountsModal.tsx`、`PluginsModal.tsx`、`ThemeSettingsModal.tsx`、`ApprovalDrawer.tsx`、`AboutModal.tsx`、`TelemetryPopover.tsx`）已整合为 `SettingsView.tsx`、`components/settings/AppearancePanels.tsx`、`components/settings/WorkspacePanels.tsx`，并新增纯前端展示组件 `Composer.tsx` 与 `Markdown.tsx`。
- **合规基线保持**：所有十大合规红线（零凭据读取、只读历史同步、手动切换 Profile 零自动轮换、CSP 防注入、`validateCustomThemeConfig` 颜色白名单、Cost 免责声明、原创 Gravity 图标、并发上限 ≤ 4、`127.0.0.1` 回环边界）及 `tests/security-baseline.test.ts` 全量静态与运行时守卫 **100% 持续通过**。
