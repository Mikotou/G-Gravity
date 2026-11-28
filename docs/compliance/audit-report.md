# Gravity (v0.3.6) — Google ToS 与账号安全合规终审报告

- **审计结论**：`COMPLIANCE_PASS`（零阻断项通过）
- **最新终审版本**：`g-gravity@0.3.6`（在 v0.2.0–v0.3.5 历史基线上完成本地优先离线 Whisper WASM 语音听写、严格零 Web Speech 与静息 0 麦克风权限合规、主对话流宽幅内联 Plan 升级与 4 页签检视器收敛、NTFS/APFS 精确大小写会话目录隔离、macOS 冷启零 Keychain 阻塞与 Darwin FSEvents 启动盲窗修复，以及 Windows + macOS 双端 Stage QA-1/QA-2 全量签收，详见证章八）
- **最新审计时间**：2026-11-28
- **历史基线记录**：原 Phase 2 `gravity@0.2.0` 全量逐行实审记录（2026-11-17）及 `v0.3.3` 终审记录完整保留于下文章节一至五。

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

---

## 五、`v0.3.3` 深度架构重构与安全加固终审报告（2026-11-25）

- **终审结论**：**`COMPLIANCE_PASS`（零阻断项通过，Windows & macOS 双端合规基线完全达标）**
- **变更范围**：共享契约层 `src/shared/`、主进程 5 层零环重构 `src/main/`（89 个文件，261 条内部依赖，0 循环依赖）、渲染层 `src/renderer/`（剥离生产 Mock 与废弃视图）、构建/打包配置（`package.json`、`package-lock.json`、`index.html`、`vite.config.ts`、`.github/workflows/release.yml`）及 `tests/` 自动化守卫套件（零改动官方 Antigravity 内置插件）。

### 5.1 关键合规强化项（v0.3.3 新增与收紧）

1. **D1-B 攻击面缩减（彻底移除外部历史导入与废弃桥接）— PASS**
   - 彻底删除 `src/main/history/history-importer.ts`、`src/renderer/components/ReadOnlyHistoryView.tsx`、`HISTORY_*` IPC 通道、`window.agyDesktop` 兼容别名及未使用的 `APP_GET_UPDATE_STATE` / `SESSION_GET_MESSAGES` 通道。
   - 客户端仅保留自有会话持久化与老版本 Gravity 自有数据升级迁移（`grid-4`、legacy `messages.json`、telemetry `v1→v2`、Swarm 旧 JSON 迁移）。
   - `tests/security-baseline.test.ts` 新增 **100% 全量 `preload.ts` ↔ `ipc-router.ts` / `macos-menu.ts` ↔ `IPC_CHANNELS` 静态 1:1 对齐守卫**及 `history-importer.ts` 零存在守卫。
   - 渲染层生产包彻底剥离 `fallback-desktop-bridge.ts`（115 KB 演示 Mock）；`dist/renderer/assets/*.js` 实扫 `sess-primary` / `DemoProject` / `CoreGateway` / `Format-Volume` 均为 **0 命中**。
2. **D2-A 纯本地严格 CSP（生产零回环外放）— PASS**
   - `index.html` 锁定：`default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none';`。
   - `vite.config.ts` 仅在 `apply: 'serve'` 本地开发服务器动态追加 `http://127.0.0.1:* ws://127.0.0.1:*`，生产产物零放宽。
3. **D3 路径作用域凭据守卫强化 + `SH-01` `.env` 补齐 — PASS**
   - `src/shared/accounts-history-contract.ts` 的 `isForbiddenCredentialOrStatePath()` 无条件拦截 `.ssh` / `.gnupg` / `.aws`、`Library/Keychains|Cookies`、`/etc/passwd|shadow|sudoers`、`installation_id`、`*.pbtxt`、`.gemini|antigravity*/**/*.pb`、`*.pem/*.key/*.pfx/*.p12/*.enc/*.keystore/*.jks/*.kdbx`、`google_accounts` / `application_default_credentials` / `adc.json`、`state.vscdb*` 及 `.env` / `.env.*`（放行 `.env.example/.sample/.template`）。
   - 泛化凭据词仅拦截官方/系统目录及非源码数据文件，不再误伤正常工程源码（如 `secret-vault.ts`）与官方 `skills/<name>/SKILL.md`；`ApprovalEngine` 不再对编辑正文/替换文本触发路径黑名单误杀。
4. **`SEC-01` & `SEC-02` 网络 SSRF 与子进程环境隔离加固 — PASS**
   - `src/main/approval/shell-validators.ts` 禁止 `curl -L` / `--location` 命中只读 HTTPS HEAD 放行（防止 302 跳转至内网/云元数据 SSRF）；`shell-risk-floor.ts` 与 `mcp-network-policy.ts` 覆盖 `169.254.169.254`、`169.254.170.2`、`metadata.goog`、`metadata.google.internal` 与 `cloudcode-pa` 作为不可变 Tier A 红线。
   - `src/main/acp/agy-environment.ts` 在 Windows / macOS / Linux 三端统一复制并剥离 `NODE_OPTIONS` 与 `ELECTRON_RUN_AS_NODE`，防止 Electron 宿主机环境变量污染官方 `agy` 子进程。
5. **只读 SQLite 快照统一安全边界（0 字节写入 `~/.gemini`）— PASS**
   - `src/main/storage/readonly-sqlite-snapshot.ts` 统一负责 `checkpoint-limit-reader.ts` 的只读快照复制：前置 `realpath` + `lstat`（拒软链/硬链 `nlink !== 1`）+ `openLocalFile`（防 FIFO 阻塞与 TOCTOU 替换）+ 前后 stat 一致性比对 + 私有 `0o700`/`0o600` 临时快照目录 + `PRAGMA query_only=ON; PRAGMA trusted_schema=OFF` + `finally` 彻底删除临时文件，对源 `.gemini` 目录严格 0 字节写入。
6. **十大红线全项复核结果**：
   - 红线 1（零凭据触碰 / `~/.gemini` 0 字节写入）：**PASS**
   - 红线 2（多账号 `--app-data-dir` + 100% 手动切换、零自动轮号）：**PASS**
   - 红线 3（零私有端点、零内部伪装 Flag、`validateAgyArgs()` 白名单、`shell: false`）：**PASS**
   - 红线 4（原版二进制只读调用、环境清洗、审批仅下发 `allow_once`、Fail-Closed）：**PASS**
   - 红线 5（零订阅额度自审滥用、离线 Bergamot 默认翻译、独立加密外部 API Key）：**PASS**
   - 红线 6（并发活跃会话 `MAX_PARALLEL_ACTIVE_SESSIONS = 4`、`429 ≥ 60s` / `403 ≥ 300s` 冷却熔断）：**PASS**
   - 红线 7（Plugins / MCP 仅点击走官方 CLI `shell: false`，零改写官方配置、零改动官方内置插件）：**PASS**
   - 红线 8（Electron `contextIsolation + sandbox + webSecurity`、`127.0.0.1` 边界、D2-A 纯本地 CSP、自定义主题色值白名单）：**PASS**
   - 红线 9（100% 原创 6 套 C4 Gravity 图标、按 Win `.ico` / macOS `-mac.png` 分平台打包）：**PASS**
   - 红线 10（Cost 四维估算免责声明保留）：**PASS**

### 5.2 自动化与真机合规实测证据（v0.3.3）

- `tests/security-baseline.test.ts`：**11/11 PASS**
- `tests/v033-backend-architecture.test.ts`：**9/9 PASS**（AST 零循环依赖、规模守卫、4 套共享基建、D1-B 删除守卫）
- `tests/v033-bundle-and-deadcode.test.ts`：**5/5 PASS**（生产包 0 Mock、D2-A CSP、D4 资产精简）
- 全量单元测试 `npm test`：**75 passed | 1 skipped（1,005 passed | 9 skipped / 1,014，0 failed）**
- 离线真机打包 E2E `tests/v033-offline-e2e-and-screenshots.cjs`：**PASS**（Windows `Gravity.exe` + macOS `mac-inset` 2x DPI，9/9 截图，0 `pageerrors`）
- 低频在线官方实机冒烟 `tests/v033-online-lowfreq-smoke.cjs`：**PASS**（实连原版 `agy.EXE v1.5.17`，5 请求严格守限流窗、隔离 `--user-data-dir`、退出后 **0 孤儿 `agy.EXE` 进程**）

---

## 六、`v0.3.4` 防封号 P0 闭环、隐私投影与双端发布终审报告（2026-11-26）

- **终审结论**：**`COMPLIANCE_PASS`（零阻断项通过，Windows 实机签收 + macOS 移植核验全部达标）**
- **变更范围**：共享契约层 `src/shared/`（0 循环依赖）、主进程 `src/main/`（98 个 TS 文件、0 循环依赖、最大单文件 638 LOC）、渲染层 `src/renderer/`（单入口模块化 CSS、WCAG 2.1 AA 零违规、`U-01`–`U-04` 与 `D1`–`D5`）、构建/打包配置（`package.json` 分平台 `assets/quota/` 与 `assets/icons/`、`.github/workflows/release.yml` 强制 `GRAVITY_REQUIRE_DIST=1`）及全量自动化合规与 E2E 套件（**0 改动任何官方 Antigravity 内置插件**）。

### 6.1 `v0.3.4` 新增与收紧的合规防护项

1. **三项防封号 P0 阻断项彻底闭环（`CAP-01`, `RATE-01`, `RATE-02`）— PASS**
   - **`CAP-01`**：标题整理临时会话前置校验 `sessionCapabilities.close`，缺失时不发送 `session/new`；关闭失败时不提前归还并发槽位（4 路硬上限不可被临时会话穿透）；`TTL-01` 将所有 `session/new` 计入 `4 次 / 60s` 冷却预算。
   - **`RATE-01`**：RPC 请求超时后迟到的 `429` / `403` / `RESOURCE_EXHAUSTED` 仍建立本地指数退避冷却窗，杜绝超时后绕过冷却持续重试。
   - **`RATE-02`**：冷却期内同步阻断 `acp.start()` 与周期性额度探测（`getAccountQuota(manual = false)`），冷却期满后仅允许用户显式手动刷新（`manual = true`）恢复探测。
2. **第三方 API Key 零明文投影（`D4`）与隐私边界 — PASS**
   - 外部复核与外部翻译配置仅向渲染进程投影 `{ hasApiKey: boolean, apiKey: undefined }`，渲染进程永不接收明文密钥；留空保存保留原密文、显式清除传 `""`、更换 Provider 或 Origin 自动清空旧密钥；保存成功后表单草稿同步清零明文。
3. **本机进程树回收、目录安全与更新完整性（`PROC-01`, `ROOT-01`, `ACQ-01`, `UPD-01/02`, `SH-01/02`）— PASS**
   - `windows-acp-tree.ts`（Windows 三代子进程退出回收屏障）与 `mac-acp-process-group.ts`（macOS 进程组排水清理）双端闭环，确保退出后 **0 孤儿 `agy` 进程**。
   - `data-directory.ts`（`ROOT-01`）拦截指向 `.gemini` / `antigravity-cli` 的软链或目录联接作为 `--user-data-dir`。
   - `account-quota.ts`（`ACQ-01`）Windows 与 macOS 状态栏临时文件均仅写入白名单字段（`plan`、`buckets`），零透传 Token/Email/Debug 字段并在退出 `finally` 中安全销毁临时目录。
   - `update-integrity.ts` + `platform-installer.ts`（`UPD-01/02`）在安装前校验下载包精确字节数与 SHA-256 摘要，macOS 同文件系统原子替换 + 失败自动回滚 `BACKUP_APP` 并拒绝 `/AppTranslocation/`。
   - `U-01` 新增 `APP_COPY_TEXT` IPC 通道严格绑定主 frame 校验与 ≤ 4 MB 体积上限，并在 `security-baseline.test.ts` 中实现 1:1 通道对齐守卫。
4. **十大防封号红线终审结论**：红线 1–10 全部 **PASS**（零凭据读取、`~/.gemini` 零写入、手动 `--app-data-dir` 零自动切号、零私有端点与内部 Flag、`shell: false` + 环境清洗、并发 ≤ 4、`429 ≥ 60s / 403 ≥ 300s`、零改动官方内置插件、D2-A 纯本地 CSP、6 套原创 C4 图标、全 Cost 视图免责声明）。

### 6.2 透明披露与门禁收紧记录

- **Wave 1 早期测试变量误触发披露**：Wave 1 后端开发期间，一次本地测试误将环境变量设为 `AGY_OFFICIAL_SMOKE=0`，因旧版 `tests/official-acp-smoke.test.ts:6` 使用 `it.skipIf(!process.env.AGY_OFFICIAL_SMOKE)`（非空字符串 `'0'` 被视为真），实际触发了一次纯 `initialize` 握手（0 `session/new`、0 `session/prompt`，随后立即 `close`）。已第一时间向用户透明披露，并将门禁收紧为 `it.skipIf(process.env.AGY_OFFICIAL_SMOKE !== '1')`，实测 `'0'` 与 `'false'` 均严格跳过。

### 6.3 `v0.3.4` 自动化与真机实测证据

- `tests/security-baseline.test.ts`：**14/14 PASS**（含 `K1`、`U-01`、`D4`）
- `tests/v034-backend-architecture-and-compliance.test.ts`：**14/14 PASS**（`A01`–`A04`, `C01`–`C04`, 含 Swarm SQLite Worker 真实持锁 P99 `< 16ms`、流式合批 -89.71%、10 项数据迁移）
- `tests/v034-backend-core-and-plugins.test.ts`：**33/33 PASS**（`R01`–`R15` 全量后端与 9 大自研插件回归）
- `tests/v034-theme-contrast.test.ts` & `tests/v034-css-and-bundle-guards.test.ts` & `tests/v034-frontend-bugs-and-ux.test.tsx`：**29/29 PASS**（`UT-01`–`UT-18`, `SG-01`–`SG-11` 全绿）
- `tests/v033-bundle-and-deadcode.test.ts`（`GRAVITY_REQUIRE_DIST=1`）：**5/5 PASS**（0 Mock、0「演示审批」、D2-A CSP、分平台资产洁净）
- 全量单元测试 `GRAVITY_REQUIRE_DIST=1 npm test`（未设置 `AGY_OFFICIAL_SMOKE`）：**80 passed | 1 skipped（1,084 passed | 9 skipped / 1,093，0 failed）**
- 离线打包 E2E + 视觉走查 `tests/v034-offline-e2e-and-screenshots.cjs`：**PASS**（Windows `win-unpacked\Gravity.exe` + macOS `mac-inset` 2x DPI + 4 主题 `U-04` 7d/30d，17/17 截图全部逐张人工检视通过，0 `pageerrors`）
- Windows 双目标打包冒烟 `npm run test:desktop`：**PASS**（`release\win-unpacked\Gravity.exe` 与便携版 `release\Gravity.exe` 均 100% 通过）
- 低频在线官方实机冒烟 `tests/v034-online-lowfreq-smoke.cjs`：**PASS**（实连原版 `agy.EXE v1.5.18`，4 次出站请求最小间距 `15,402ms ≥ 15s`、60s 滑窗 `4/4`、并发峰值 `1/1`、`activeProfileId: "default"`、退出后 `QA-02` 核验 14 个观测后代进程 **0 孤儿残留**）

---

## 七、`v0.3.5` 合规终审裁定、只读产物边界与跨端加固（2026-11-27）

- **终审结论**：**`COMPLIANCE_PASS`（Windows + macOS 双端零阻断项通过，双端 4 轮 Neon QA 独立攻防、6 主题 1.5x/2x Retina 实机视觉验收与双端打包冒烟全绿）**
- **变更范围**：共享契约层 `src/shared/`（0 循环依赖）、主进程 `src/main/`（107 个 TS 文件、297 条内部静态边、0 循环依赖、0 `acp/ → services/` 反向边、最大单文件 `turn-stream.ts` 646 LOC、`core-service.ts` 372 LOC、`index.ts` 137 LOC、81/81 IPC 通道 1:1 对齐）、渲染层 `src/renderer/`（CSS 源码 ≤ 216 KiB / 产物 209.46 KiB、0 空 `var()`、0 死类、0 跨文件重复选择器、0 非合成属性动画、6 套预设与自定义主题 100% WCAG 2.1 AA）及全量自动化与视觉 E2E 套件（**0 改动任何官方 Antigravity 内置插件**）。

### 7.1 `v0.3.5` 新增与收紧的合规防护项

1. **自定义 Orchestrator Planner / Executor 设置项 — 正式判定：超规放弃（PASS）**
   - 实测本机 `agy 1.5.18`：`agy acp --help` 不接受 `--settings` 亦不暴露 planner/executor 参数，ACP `session/new` `configOptions` 仅公开 `model`、`mode`、`thought_level`，官方仅在交互式 TUI `/model` 中持久化至 `~/.gemini/antigravity-cli/settings.json`。
   - 坚守红线 #2（`~/.gemini` 严格 0 字节写入）、红线 #4（`validateAgyArgs()` 显式拒绝 `--settings` 与 `--settings=...`）及红线 #8（严禁覆写 `agy` 内部配置），在默认与隔离 Profile 设置中均不暴露该项配置；全仓静态扫描 `plannerModel` / `executorModel` / `plannerEffort` / `executorEffort` = **0 命中**。
2. **受控只读 `implementation_plan.md` 产物边界（`SESSION_GET_PLAN_ARTIFACT` / `EVENT_PLAN_ARTIFACT_CHANGED`）— PASS**
   - `src/main/session/plan-artifact-reader.ts` 严格校验当前 Profile 所属当前会话的 `brain/<sessionId>/implementation_plan.md` 或该会话明确引用的工作区内文件，执行 `lstat`（拦截软链与硬链 `nlink > 1`）+ `realpath` + TOCTOU 文件身份比对 + `isForbiddenCredentialOrStatePath()` 凭据黑名单 + Windows ADS / 保留设备名 / UNC 拦截；
   - 有界流式读取至 4 MiB 校验严格 UTF-8（拦截二进制 NUL），预览超过 131,072 字节（128 KiB）按完整 UTF-8 字符边界安全截断并返回 `truncated: true`，超过 4 MiB 拒绝；前端 `PlanArtifactPanel.tsx` 0 `<img>` 渲染、0 外链资源请求；仅打开计划本体时携带 `planArtifactOwner` 复核，文档内嵌外链与工作区文件走常规受控 `openExternalTarget`（维持 `CORE-04` 危险扩展名降级）；对 `~/.gemini` 保持严格 **0 字节写入**。
3. **跨端凭据、插件 CLI 与限流加固（`AP-1`, `PL-1`, `AQ-1`, `D-07`, `B01`）— PASS**
   - **`AP-1`**：凡携带 API Key（或 `hasApiKey`）的外部复核与外部翻译模型发现/连通性测试，禁止输入防抖自动发起，统一显式点击触发并展示规范化目标 origin；仅无鉴权本机 Ollama `http://127.0.0.1` 保留自动发现。
   - **`PL-1`**：移除 `PluginsPanel` 切语言（`dict`）与被动 `cwd` 变更触发的静默 CLI 刷新；隔离 Profile 明确标注 CLI 作用域并阻止跨号修改默认 CLI 配置。
   - **`AQ-1` & `D-07`**：订阅 `EVENT_CONNECTION_UPDATED` 冷却窗口，在 `429`（≥60s）/ `403`（≥300s）冷却期自动暂停全部额度探测并禁用手动刷新钮配合每秒动态倒计时；主进程仅在冷却过期后手动刷新真正成功返回有效数据时才重新解锁后台自动轮询；`preload.js` 与 `CoreService.getAccountQuota` 省参统一为 `manual = false`。
   - **`B01`**：隐藏标题会话 `session/new` 超时后迟到成功由同代际可靠关闭一次并在收到关闭确认后释槽，严守 4 路并发硬上限。
4. **十大防封号红线终审结论**：红线 1–10 全部 **PASS**；真机运行全套后端与攻防测试前后核对用户 `antigravity-cli/settings.json` SHA-256 逐字节一致，且在合成 `~/.gemini` 目录中验证逐文件 SHA-256 **0 字节写入、0 文件增删**。

### 7.2 `v0.3.5` 自动化、双 Neon 攻防与真机实测证据

- `tests/security-baseline.test.ts`：**14/14 PASS**（含 81/81 IPC 1:1 对齐、`K1`、`U-01`、`D4`）
- `tests/privacy-guard.test.ts`：**3/3 PASS**（零个人路径/机器信息/内网 IP/测试截图入库）
- `tests/v035-backend-*.test.ts` + `tests/v035-qa-backend-adversarial.test.ts`：**74/74（Win: 73 passed | 1 macOS-only skipped；macOS: 全量激活 PASS）**（107 文件 0 环 0 `acp→services`、双轴热力图黄金样本/DST/增量、原生提问 v2 幂等与跟进恢复、Plan 重放/LRU/只读产物攻防、Swarm 真实持锁 32+8 恢复、Title 迟到槽、Updater Win/macOS x64+ARM64 架构分流、LocalTranslator 取消回收、macOS `/tmp`·APFS 大小写·NFC/NFD·`realpathSync.native` 路径边界）
- `tests/v035-heatmap-ramp.test.ts` & `tests/v035-motion-guard.test.ts` & `tests/v034-css-and-bundle-guards.test.ts` & `tests/v034-theme-contrast.test.ts`：**26/26 PASS**（6 套预设 + 200 随机自定义主题 WCAG AA、0 非合成动画、0 空 `var()`、0 死类、0 跨文件重复选择器、构建 CSS 209.46 KiB）
- `tests/v035-frontend-core.test.tsx` & `tests/v035-frontend-plugins-and-ux.test.tsx` & `tests/v035-qa-frontend-adversarial.test.tsx`：**58/58 PASS**（热力图、提问卡 v2、Plan 检视器、UI 精简与全部 P1/P2/键盘无障碍回归）
- Windows 全量单元测试 `GRAVITY_REQUIRE_DIST=1 npx vitest run --maxWorkers 4`：**90 passed | 1 skipped（1,236 passed | 10 skipped / 1,246，0 failed）**（10 项跳过均为 9 项 macOS 专属测试 + 1 项需手工授权的官方在线冒烟）
- `npm run test:layout`：**PASS**（`gv-tab-breathe` 0/0/100、`gv-activity-flow` 0/0/159、`prefers-reduced-motion` 0 流光）
- `node tests/v035-visual-e2e.cjs`：**PASS**（M1–M6 覆盖全部 6 套真实预设主题、4 档检视器宽度、提问卡 v2、Plan 6 态与只读文档、设置 8 导航与 C1 徽章、MO-01 流式上浮菜单，42 张 PNG 逐张审图通过，`externalRequests: 0`, `pageErrors: 0`）
- Windows 打包冒烟 `npm run dist:exe` & `npm run test:desktop`：**PASS**（`release/win-unpacked/Gravity.exe` 与便携版 `release/Gravity.exe` 双形态实机验收通过）
- macOS Apple Silicon (`arm64`, APFS, Electron 35.7.5) 真机双 Neon QA 与 `npm run dist:mac`：**PASS**
  - **后端 + 全部 Darwin/POSIX 专项**：10 套件 **145/145 PASS（0 failed / 0 skipped）**，Windows 端跳过的 8 项 Darwin/POSIX 真机测试（`/usr/bin/script` PTY 额度、POSIX 进程组清理、APFS 符号链接拦截）与新增 APFS `/tmp` 别名/大小写内联图片预览/NFC-NFD/Updater macOS 回归全部实机激活通过；`Gravity-0.3.5-mac-arm64.dmg`（`hdiutil verify VALID`）与 `.zip`（`unzip -tq` 0 错）资产分离洁净（`.ico`/`.ps1`/`.map`/`.d.ts` 均为 0），打包版 Electron 35.7.5 内嵌 Node 22.16.0 实机跑通 `node:sqlite` 写锁恢复、APFS 大小写图片预览与断网 Bergamot WASM 翻译；`~/.gemini` 严格 0 字节写入；
  - **前端 + 2x Retina 视觉 + 原生 `mac-inset` 冒烟**：9 套件 **108/108 PASS**，`desktop-layout-smoke` 与 6 主题 `v035-visual-e2e` 全绿，2x Retina 实机验证 6 主题命中原生 `SF Pro Text` / `SF Mono`、280px 窄检视器 7d 读数与 5 按钮费用卡零裁切、`Ctrl+,` vs `⌘,` 隔离与 14 张 2x 截图目视通过，打包版 `Gravity.app` 验证交通灯安全区（82px ≥ 78px）、80%/100%/150% 缩放持久化、悬浮检视器与 Dock 常驻恢复全部通过。

---

## 八、`v0.3.6` 离线语音合规、内联 Plan 隔离加固与 Windows + macOS 双端全量终审（2026-11-28）

- **终审结论**：**`COMPLIANCE_PASS`（Windows + macOS Apple Silicon `arm64` 双端 0 P0 / 0 P1 通过，两阶段完成离线语音与主对话流 Inline Plan 升级的 Stage QA-1 只读盲审 → 修复 → Stage QA-2 全量单测、6 主题视觉 E2E 及原版打包 `.exe`/`.app`/`.dmg`/`.zip` 实机离线冒烟全绿）**
- **变更范围**：共享契约层 `src/shared/`（23 个 TS 文件、0 循环依赖、`RightInspectorTab` 移除 `'plan'` 并保留旧布局自动回落 `'context'`）、主进程 `src/main/`（118 个 TS 文件、323 条内部静态边、0 循环依赖、0 `acp/ → services/` 反向边、最大单文件 `approval-engine.ts` / `swarm-tracker.ts` 633 LOC ≤ 650、`core-service.ts` 417 LOC ≤ 420、`plan-artifact-reader.ts` 279 LOC、`index.ts` 143 LOC、93/93 唯一 IPC 通道 1:1 对齐）、离线语音资产 `assets/local-voice/`（`whisper.cjs`/`whisper.wasm`/`worker.cjs`/`model.cjs`/OpenCC 词表/7 份完整许可，`ggml-base-q5_1.bin` 未入 Git 索引）、渲染层 `src/renderer/`（`InlinePlanCard` 迁入主对话流、`RightInspector` 精简为 4 主页签、生产 CSS **`214,975 B <= 215,040 B`**、gzip `38.34 kB`、`pcm-worklet-D2Vo8uE3.js` `1,230 B`、0 死类、0 跨文件重复选择器、0 非合成动画）及全量自动化与视觉 E2E 套件（**0 改动任何官方 Antigravity 内置插件、0 触碰真实 `~/.gemini`**）。

### 8.1 `v0.3.6` 新增合规防护项与关键实机修复闭环

1. **严格零 Web Speech API 与零放宽 CSP 守卫 — PASS**
   - `tests/security-baseline.test.ts` 全量 AST 守卫确认 `src/` 中 **0 处** `SpeechRecognition` / `webkitSpeechRecognition` 引用；
   - 渲染层严格维持 `script-src 'self'`（Windows 便携包与 macOS `Gravity.app` `file://` 实机验证 0 `'wasm-unsafe-eval'` / `blob:` / `'unsafe-eval'`）；`AudioWorklet` 模块独立打包为 `dist/renderer/assets/pcm-worklet-*.js` 在严格 CSP 下成功采集非零 16 kHz PCM16；
   - `preload.ts` / `ipc-router.ts` 严格限制二进制 PCM16 载荷仅允许通过 `VOICE_APPEND_PCM` 白名单通道，其余 72 条 invoke 通道（含 8 类代表通道实机攻防）100% 拒绝二进制注入。
2. **离线 Whisper 模型供应链完整性与路径安全（`model.cjs`）— PASS**
   - `ggml-base-q5_1.bin`（MIT 许可，精确 `59,707,625 B`，SHA-256 `422f1ae452ade6f30a004d7e5c6a43195e4433bc370bf23fac9cc591f01a8898`）通过 `.gitignore` 保持 Git 仓库轻量（`git ls-files assets/local-voice/ggml-base-q5_1.bin` 为空），CI 发版前经 `npm run voice:model:fetch` 校验并随包打入 `Gravity.exe` / `Gravity.app`；
   - 双端实机核验：Windows 8.3 短路径、大小写变体及 Electron 35 `lstatSync.dev=0n` 身份比对通过；macOS `/tmp` → `/private/tmp` 别名、APFS 大小写 + NFC/NFD 规范化通过且严格保留 `darwin` `dev` 一致性校验；双端均 100% 拒绝父目录软链、文件软链、硬链（`nlink > 1`）与文件篡改；断网环境下 `globalThis.fetch` 拦截 **0 次外联**完成离线转写。
3. **静息 0 权限调用、租约制采音与 macOS 冷启零 Keychain 阻塞 — PASS**
   - 双端原版打包实机验证：冷启动与打开设置通用页 `VoiceSettingsCard` 静息态 `{ getUserMedia: 0, enumerateDevices: 0, permissions.query: 0 }`；静息裸调 `getUserMedia` 被主进程双权限处理器拒绝；仅显式点击录音 / 3 秒试录 / 选择输入设备取得主进程租约后放行，切号/失焦/卸载立即 `dispose()` 释放音频轨与 `AudioContext`；
   - **macOS 实机 P0 闭环**：修复 `VoiceService.state()` 在冷启动 `getBootstrap()` 中无条件调用 `safeStorage.isEncryptionAvailable()` 引发 `SecKeychainAddGenericPassword` 同步锁死主线程的缺陷（`SecretVault` / `VoiceService` / `index.ts` 对未配置外部密钥的被动状态快照免唤醒 Keychain，且先校验磁盘密文文件存在性；实际保存/启用外部语音密钥时仍执行严格 fail-closed 探测，不可加密时硬拒绝且 0 明文落盘）。
4. **内联 Plan 跨会话大小写隔离、断连归属一致性与 Darwin FSEvents 盲窗闭环 — PASS**
   - **`DEF-BE-IP-01 / DEF-BE-IP-04`（NTFS / APFS 跨会话精确隔离）**：`local-media-inspector.ts` 与 `plan-artifact-reader.ts` 对 `brain/<sessionId>` 均执行精确大小写目录名比对（`basename(actual) !== basename(scope.root)`），在大小写不敏感文件系统上严禁仅大小写不同的兄弟会话（`Sess-Alpha` vs `sess-alpha`）跨会话读取或打开私有图片与 `implementation_plan.md`，同时保留双根独立命中与 0 伪事件；
   - **`DEF-BE-IP-03 / 05 / 06` & QA-2 断连 P0 闭环**：落实先订阅后探测首写竞态捕获、挂起 `read()` 失效释放不误删新 owner、离线标签/切分支（含 4 槽满重挂）/整树归档/退出停产全路径 0 FSWatcher 泄漏；修复 `core-service.ts` 在同 Profile ACP `disconnected` 时误清 `sessionEpochs` 导致实机 `InlinePlanCard` 原文抽屉卡死的 P0 缺陷，并在 `usePlanArtifact.ts` / `PlanTimeline.tsx` 补齐 `knownEpochRef` 与 `effectiveEpoch` 纵深防御（保持 `onPlanArtifactChanged` 严格相等过滤跨代次事件）；
   - **`DEF-MAC-IP-01`（Darwin FSEvents 启动盲窗）**：`plan-artifact-reader.ts` 对 `process.platform === 'darwin' && addedWatcher` 调度一次性 `.unref()` `120ms` settle 复检并在 `forget()` 彻底取消，macOS APFS `delay=0ms` 压测由 20%–46.7% 丢事件提升至 **15/15 PASS（100%）**且 0 伪事件、0 watcher 泄漏。
5. **macOS 辅助脚本、发版工作流与十一大红线终审 — PASS**
   - 修复 `.github/workflows/release.yml` 未加引号 heredoc 中反引号触发 bash 命令替换的 P0 隐患（改用单引号 `cat <<'EOF'`，经 macOS `bash -euo pipefail` 干跑验证通过）；
   - 修复 `assets/quota/read-quota-macos.sh`（纯 LF）SIGKILL 看门狗与父 shell 同进程组导致自杀残留的 P1 缺陷，改由独立 `/bin/sh -c` 启动并先 `TERM` 再经 `ps + awk` 逐一 `SIGKILL` 除 `$$` 外全部组员后清理 `reading.json.*.tmp` 与 `pty.????????`；
   - **十一大合规红线（原十大红线 + #11 语音本地优先合规）全部 PASS**：双端隔离实机冒烟均对合成 `$HOME/.gemini`（含 `oauth_creds.json`、`state.pb`、`brain/.../implementation_plan.md`）做前后递归 SHA-256 校验，证实 **0 字节写入、0 文件增删改**，且全程零触碰用户真实 `~/.gemini`。

### 8.2 `v0.3.6` 双端自动化、视觉与真机打包实测证据（最终合流基线 `v0.3.6-dev` @ `1de19f7`）

- **Windows（NTFS 工作树 + Electron 35.7.5 + 真实 `Gravity.exe`）**：
  - `npm run typecheck`（4 份 tsconfig）：**0 错误**；`npm run build`：`1.82s`，生产 CSS **`214,975 B <= 215,040 B`**（余量 `65 B`），`pcm-worklet-D2Vo8uE3.js` `1,230 B`。
  - 全量单测 `GRAVITY_REQUIRE_DIST=1 npm test`：**94 passed | 0 failed | 1 skipped（`official-acp-smoke`）**（**1,302 passed | 0 failed | 10 skipped**，`24.28s`；其中 34 份前端 `.test.tsx` **391/391 PASS**，60 份活跃后端 `.test.ts` **911/911 PASS**，含 `TC-IP-BE-01..06` 与新版 `BE-09`）。
  - 布局与视觉 E2E：`npm run test:layout` 全绿；`node tests/v035-visual-e2e.cjs` & `node tests/v036-visual-e2e.cjs`（V1–V4：6 预设主题宽幅内联 Plan 与 4 页签检视器、4 档宽含 340px 折叠/展开/原文零溢出零裁剪、Plan 5 态与 `split-2` 双开原文及聚焦 `Esc` 隔离、编辑批注卡、`prefers-reduced-motion` 0 无限动画）**100% PASS**（`externalRequests: 0`, `pageErrors: 0`, `consoleErrors: 0`，11 张关键截图逐张人工读图通过）。
  - Windows 便携包实机冒烟 `npm run dist:exe` & `npm run test:desktop`（`PKG-V1..V4` + 内联 Plan 实机闭环）：**100% PASS**（`release/Gravity.exe` `177,142,247 B`，SHA-256 `B2355E0406EDC02D961B2FA9E733AD5D7CC1A686EC6CD208F6284D2A248089E3`，随包 `ggml-base-q5_1.bin` `59,707,625 B` + SHA-256 精确匹配；覆盖全空 `userData` 便携版 + `win-unpacked` + 预置便携版，实机验证旧 `layout.json` `'plan'` 回落 `'context'`、点击 `plan-source-open` 展开 `plan-source-drawer` 与 `plan-artifact-document` → `Escape` 收起 → 折叠卡片、3 轮 100% 离线 Whisper 精准转写 `"The library opens at 9 in the morning."` 耗时 `1.88–2.01s`、4 步退出返回码 `0`、合成 `~/.gemini` 0 字节写入）。
- **macOS Apple Silicon（`arm64`, macOS `27.2.1`, APFS, Node `v22.14.0`, 真实 `Gravity.app` / `.dmg` / `.zip`）**：
  - **后端 + APFS 隔离 + 实机打包冒烟（阶段 QA-2A — 100% PASS）**：
    - 4 项 `typecheck` 0 错、`build` 通过、CSS `214,975 B`、全量 Vitest（`GRAVITY_REQUIRE_DIST=1`）**94 passed | 0 failed | 1 skipped**（**1,299 passed | 0 failed | 13 skipped**，`16.01s`；全部 Darwin 专测 `macos-acp-process.test.ts` 14/14、APFS 大小写隔离 `TC-IP-BE-03` 与 `BE-09` 24/24、真模型离线转写全过）；
    - `DEF-MAC-IP-01` 专项 `delay=0ms` 15 轮压测：`v035:375` 与 `TC-IP-BE-04` 全部 **15/15 PASS（100%）**，0 伪事件、0 泄漏 watcher，`closeSession` 立即取消 `settleTimer`（`postCloseEvents=0`）；
    - `read-quota-macos.sh` 4 场景 100% PASS，0 孤儿进程、0 残留目录；`model.cjs` APFS `/tmp`、NFC/NFD、软硬链与 `darwin` 严格 `dev` 100% PASS；
    - Apple Silicon 离线 Whisper WASM：英文 `1,084–1,112ms`（`RTF=0.370–0.380`）、中文 `Tingting` `2,188ms`（`RTF=0.414`，OpenCC 纯简体），`globalThis.fetch` 拦截 `0` 调用；
    - `npm run dist:mac` 产出 `Gravity-0.3.6-mac-arm64.dmg`（`209,103,230 B`，挂载校验模型 `59,707,625 B`）与 `.zip`（`203,087,974 B`，`ditto` 解包校验模型 `59,707,625 B`），`Info.plist` 含 `CFBundleShortVersionString = "0.3.6"` 与 `NSMicrophoneUsageDescription`，0 泄漏文件；
    - 原版 `Gravity.app` 实机离线冒烟：冷启 `396 ms` 0 Keychain 阻塞、`file://` 严格 CSP、`bundled` `ready`、旧 `layout.json` `'plan'` 回落 `'context'`（`inspector-tab-plan: 0`）、主对话流 `InlinePlanCard` 点击「查看原文」`69 ms` 展开 `plan-artifact-document` → `Escape` 收起 → 折叠正常、离线 Whisper 转写 `1,515 ms`（0 外联）、4 步退出返回码 `0`、合成 `$HOME/.gemini` 9 项哨兵递归 SHA-256 **100% 逐字节一致（0 字节写入）**。
  - **前端 + Retina 视觉 + 原版 `Gravity.app` 原生 UI 冒烟（阶段 QA-2B — 100% PASS，0 P0 / 0 P1）**：
    - 34/34 前端 `.test.tsx`（**391/391 PASS**，`8.63s`）、`npm run test:layout` 0 溢出 0 回归、`v036-visual-e2e.cjs` V1–V4 100% PASS（6 主题 `inspTabs: 4`、`planOverflow: 0`、`340px` 3 态 `allButtonsInside: true`、`split-2` 双开原文与聚焦 `Esc` 隔离、4 张关键截图逐张人工审阅通过）；
    - 原版 `Gravity.app` 执行 `tests/macos-native-ui-smoke.cjs` 全绿：原生全屏、双语 View 菜单、单步缩放持久化、`mac-inset` 交通灯安全净空、旧 `layout.json` `'plan'` 自动回落 `'context'`、`inspector-tab-plan` 为 `0`、Dock 0 窗口常驻重开、`app.quit()` 返回码 `0` 与可见终端假 CLI 登录全通过。
- **非阻塞 P2 后续打磨备忘（不阻塞 `v0.3.6` 发版）**：
  1. `mac.css` 可于后续版本补充 `.inspector.is-floating, .inspector.is-floating .inspector-bar { -webkit-app-region: no-drag }` 以覆盖浮层检视器标题栏 4–7px 边距空隙；
  2. `tests/app-native-core.test.tsx:40` 同步断言 `swarm-active-pill-` 在 34 文件满载高并发下偶发 1 次竞态（单跑 3/3 及全量重跑 34/34 均全绿），后续可改为 `waitFor`。
