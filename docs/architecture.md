# Gravity 客户端架构总纲与合规契约 (`v0.2` Core + `v0.3` UI)

## 一、产品定位与 v0.2 核心演进

**Gravity**（原内部代号 AGY Studio）是一款严格遵循官方 ACP 协议与 Google 服务条款规范、交互深度融合 **Claude Code** 与 **Codex 桌面端** 精髓的本地专业智能编码客户端：

0. **项目与产品名称**　源码目录使用 `G-Gravity`，npm 包名为 `g-gravity`，Windows 产品名、窗口标题和 About 页显示 **Gravity**。
1. **三栏专业工作台布局**：
   - **左栏（Projects / Threads，`Ctrl+B` 折叠）**：按项目分组、搜索过滤、置顶、运行状态点、G-Gravity 自有会话与归档分组；
   - **中栏（Claude Code 风格对话主舞台，`Ctrl+\` 分屏）**：支持 2–4 个活跃会话 Tab，以及单栏 / 左右双栏 / 四宫格分屏；
   - **右栏（Resizable Inspector，`Ctrl+J` 折叠、可拖拽调节宽度）**：内置 `Diff`、`Files Changed`、`Plan/Todo`、`Terminal`、`Context`、`Swarm` 标签页，布局与栏宽自动持久化。
2. **Claude Code 级对话流与底部 Composer**：
   - 用户可编辑先前消息并从该处继续。客户端按编辑位置建立独立会话，将先前的公开对话作为首轮上下文传入，保留原分支。命令和文件操作归在每回合的同一个折叠层级，正文及附件图片可放大。思考块默认展开并记住手动选择。翻译由主进程调度，可选官方蜂群成员或本机离线模型。终端按资料和会话记住已读结果。
   - 底部多行输入框支持 `/` Slash 命令补全、`@` 文件/会话引用补全、剪贴板粘贴图片；上方常驻 Status Line（Context 占用、`tok/s`、本会话 Cost）；左下显示当前 Mode（`default / accept-edits / plan / auto`，`Shift+Tab` 循环切换）与审批档位；右下显示 Model 与 Effort（`low / medium / high / xhigh / max`）；
   - 内联 Request View 升级为 Claude Code 编号选项列表（`1. Yes` / `2. Yes, and don't ask again for <prefix>` / `3. Approve for me` / `4. No, and tell Gravity what to do differently`）。
3. **6 套经典预设主题 + 自定义取色工坊 + 原创 Gravity 图标**：
   - 内置 `Claude Code Dark`、`Claude Code Light`、`Ubuntu`、`macOS Dark`、`macOS Light`、`Solarized Dark` 6 套预设及跟随系统明暗；
   - 设置页提供取色器实时编辑全部主要 Design Tokens（含 Diff 增删色与语法高亮色），支持安全导入/导出 JSON 主题文件（经 `isValidCssColorToken` 白名单校验防 CSP 绕过）；
   - 提供 6 套 100% 原创 **Gravity** 几何引力终端图标（`assets/icons/` 提供 SVG + Win `.ico` + macOS `1024×1024` `-mac.png`，`public/icons/` 仅保留 6 份轻量 `.svg` 供渲染层加载），严禁复制或改色任何第三方受版权/商标保护标识，支持在设置页一键切换窗口与界面图标。
4. **专业中英术语混排策略（Unified Glossary）**：
   - 技术术语保留英文原名（模型名、`Bash/Read/Edit/Write/Grep`、Slash 命令、路径、`Token`、`tok/s`、`MCP`、`Skills`、`Plugins`、`Diff`、`Context`、`Cost`、快捷键、`mode` 与 `effort` 名称等）；
   - 说明文案、动作描述、风险解释与错误提示使用地道简体中文（支持在设置与顶栏一键切换 `简体中文 / English`）。
5. **三档 Token 热力图（`24h` / `7d` / `30d`）与精细化分模型 Cost 看板**：
   - 移除 52 周热力图与订阅回本对比；提供 **24h 按小时柱状图**、**7d 按日卡片（单行 7 日）**、**30d Codex 周行 7 格方格热力图** 三档切换（三套账本统一由共享双轴公式 `computeHeatLevel` 结合窗口相对占比、窗口峰值与绝对用量计算强度，前端以 OKLCH 5 阶色阶着色）；
   - 按 **本会话 / 今日 / 7d / 30d** 计算精细四维费用（`input / cachedInput / output / thinking` × 模型单价），提供 **分模型堆叠柱状图 + 环形占比图**，支持编辑单价表，并明确标注“参考 API 价格估算，非实际账单”。
6. **Plugins 管理面板（Plugins / MCP Servers / Skills）**：
   - 仅在用户点击触发时以 `shell: false` 短时调用官方 CLI 子命令（`agy plugin list|install|uninstall|enable|disable`、`agy mcp list|add|remove|enable|disable`），严禁直接改写 `agy` 内部配置文件；内置能力标记 `Built-in`。
7. **多账号手动切换与自有会话历史**：
   - 多账号通过为不同 Profile 传入客户端自有隔离目录 `agy acp --app-data-dir <profileDir>` 交由官方 CLI 自行管理凭据，登出优先走 ACP `auth/logout`；仅展示 ACP 暴露的身份信息，**严禁在 429/403 或配额耗尽时自动轮换账号（Account Rotation 零容忍）**；
   - 桌面入口将可见会话限定为 G-Gravity 自建会话。每个 Profile 独立保存消息，打开后经 `getSessionMessagePage` 游标分页回看。`v0.3.3`（D1-B）已彻底移除外部只读历史导入链路（`history-importer.ts` / `ReadOnlyHistoryView.tsx`），同时完整保留旧版 Gravity 自有数据的自动升级迁移。

---

## 四、`v0.3.3` 后端零环分层架构与极致精简（2026-11-25）

- **主进程 5 层零循环依赖 DAG（`src/main/`，89 个文件，261 条内部依赖，0 循环依赖）**：
  - **L0 入口与边界层**：`index.ts`（121 行）、`desktop/window-manager.ts`、`desktop/clipboard-image.ts`、`ipc-router.ts`、`preload.ts`、`macos-lifecycle.ts`、`macos-menu.ts`；
  - **L1 共享基础设施层**：`security/redaction.ts`（统一脱敏）、`llm/external-llm-transport.ts` + `provider-usage.ts` + `service-verifier.ts`（独立模型传输与 `OriginCircuitBreaker`）、`storage/readonly-sqlite-snapshot.ts`（防 TOCTOU 只读快照）、`telemetry/external-service-ledger.ts` + `telemetry-aggregator.ts`（公共外部用量账本与增量缓存聚合）；
  - **L2 协议与存储层**：`acp/`（`acp-client` / `acp-types` / `agy-environment` / `mac-acp-process-group`）、`storage/`（`client-store` / `conversation-messages`）、`workspace/`（`workspace-files` / `local-path-safety`）；
  - **L3 业务领域子系统**：`session/`（`session-multiplexer` / `session-lifecycle-service` / `turn-orchestrator` / `turn-stream` 等）、`approval/`（14 模块职责拆分）、`telemetry/`、`translation/`、`swarm/`（持久 WAL `SwarmArchive`）、`accounts/`、`plugins/`、`updater/`（`github-updater` + `platform-installer` + `windows-installer`）、`organizer/`；
  - **L4 外观协调层**：`core-service.ts`（314 行薄外观）+ `core-contracts.ts` + `services/`。
- **渲染层生产包剥离与组件收敛**：`desktop-bridge.ts` 精简至 41 行（演示 Mock 移入独立 `fallback-desktop-bridge.ts`，生产构建 0 字节打入）；重复外部统计视图合并为 `<ExternalServiceStatsSection>`；数字输入统一采用 `<DraftNumberInput>`。

---

## 五、`v0.3.4` 全栈性能、安全加固与五维视觉重塑（2026-11-26）

- **后端热路径、隔离与零循环架构（`src/main/` 98 文件、`src/shared/` 全量 0 循环依赖）**：
  - `core-service.ts` 347 LOC、`index.ts` 137 LOC，全仓主进程单文件 ≤ 638 LOC。
  - **独立 SQLite Worker 线程**：Swarm 持久化迁入 `swarm/swarm-worker.ts` + `swarm-worker-client.ts`，真实外部 `BEGIN IMMEDIATE` 锁竞争下主线程事件循环 P99 `< 16ms`，切号/退出如实拦截未保存写入。
  - **流式与遥测减负**：50ms 流式与检视器合批（流式 IPC 正文字符降幅 89.71%）、`ConversationMessages` 尾读免全量加载、分支树 `listBranchIds` 按 root 去重、预加载层增量装配遥测分区。
  - **防封号与安全闭环**：`CAP-01`（缺 `close` 拒绝建临时会话且失败不提前还槽）、`RATE-01`（迟到 429/403 建冷却）、`RATE-02`（冷却期禁 `start()` 与周期额度探测，仅显式手动刷新恢复）、`PROC-01`（`windows-acp-tree.ts` Windows 三代进程树清理屏障）、`D4`（外部第三方 API Key 零明文投影）、`UPD-01/02`（下载 SHA-256 收据与跨平台精确匹配）、`ACQ-01`（Win/macOS 最小白名单额度临时快照）。
- **前端样式体系、无障碍与交互升级**：
  - **CSS 单入口模块化收敛**：3 份旧 CSS（301.7 KB / 12,672 行）收敛为 `src/renderer/styles/index.css` + 18 个职责模块（源码 221.0 KB / 生产产物 202.88 KB / gzip 36.02 KB，0 跨文件重复选择器、0 死类、0 硬编码色值、0 非合成属性动画）。
  - **设计系统与用户专项交付（`D1`–`D5`, `U-01`–`U-04`）**：6 套预设与自定义主题 100% WCAG 2.1 AA（≥ 4.5:1）；`appIcon: 'auto'` 随主题自动联动；右侧检视器精简为 5 个一级页签（分支树归入 Context 二级切换）；全站矢量 `ui/Icon` 四档尺寸与主进程 `copyText` 剪贴板复制；新建对话弹窗与欢迎框支持选模型；Context 看板 `7d` / `30d` 重设计覆盖三套统计视图；流式增量 Markdown 分块解析与 `React.memo` 零跨窗格重渲染。

---

## 六、`v0.3.5` 双轴 OKLCH 热力图、Plan 多题提问卡 v2、Plan 检视器闭环与全栈精简（2026-11-27）

- **合规终审裁定（Orchestrator 自定义配置）**：实测 `agy 1.5.18` `agy acp` 不暴露 planner/executor 参数且不接受 `--settings`，Google 官方仅在交互式 TUI `/model` 写入 `~/.gemini/antigravity-cli/settings.json`。坚守红线 #2（`~/.gemini` 零写入）、#4、#8，正式放弃设置页中的自定义 Orchestrator 配置项，保留模型菜单中官方公开预设 `Orchestrator (Neon / Carbon / Argon)`。
- **后端架构与 Bug 清零（`src/main/` 106 文件、296 条内部静态依赖、0 循环依赖、0 `acp/ → services/` 反向依赖）**：
  - `core-service.ts` 369 LOC、`index.ts` 137 LOC，全仓主进程单文件 ≤ 644 LOC，81/81 IPC 通道 1:1 对齐。
  - 统一共享 `computeHeatLevel` 双轴强度公式与 `daily7d` / DST 数值 UTC 偏移 `startIso` / IANA 时区缓存键，覆盖主 Context / 外部复核 / 外部翻译三账本与 `preload.ts` 增量合并；保留仅返回 `total_tokens` 的未分类用量与直接费用。
  - 原生提问 v2（`submissionVersion: 2`）按 `(profileId, sessionId, messageId, submissionId)` 幂等结算，跟进消息在 Gravity 存储原子登记后再 `decline` 原 RPC，区分 `failed-unsent`（仅此时可手动重发）与 `unknown`（禁止自动重发）。
  - Plan 权威状态（6 态、`unreceived/empty/present`、全量统计与 100 条显示上限、重放代际暂存不触发计费/突发保护、200 内存 LRU 淘汰不删盘）与 128 KiB 只读 `implementation_plan.md` 产物预览（`SESSION_GET_PLAN_ARTIFACT` / `EVENT_PLAN_ARTIFACT_CHANGED`，`lstat`+`realpath` 零写入校验）。
  - 六项结构精简（`hasPendingForSession`、Plan 轻量快照、清死导出、去跨模块绕道、共用迟到用量归属、ACP 纯协议错误下沉 L2）及 Title 迟到孤儿槽、Swarm SQLite 锁恢复、Windows x64/ARM64 更新资产隔离、Bergamot 超时回收、`parseMcpList`、grouped-select 模型目录、`getAccountQuota(manual = false)`、macOS DMG 回退文案与 `turnStartedAt`/`turnSettledAt` 全部修复。
- **前端体验、动效清零与插件 UI 精简**：
  - `theme.ts` `deriveHeatmapRamp()` OKLCH 5 阶色阶（6 套预设 + 200 随机自定义主题全达 WCAG AA），`TokenHeatmapView` 实现 `24h` 封顶柱图 / `7d` 单行日卡 / `30d` Codex 周行 7 格方格与 219px 窄栏容器断点。
  - `QuestionBar` 重设计：多题步进器（不自动切题）、每项右上角铅笔就地编辑、卡片外「自定义回答」按钮与多题统一提交（过程 0 IPC）。
  - 5 处 `background-position` 非合成动画清零为纯 `transform`/`opacity`（`v035-motion-guard.test.ts` 守卫），CSS 源码收敛至 215.09 KiB（0 死类、0 跨文件重复选择器）。
  - 全站 UI 精简（`T1/T2`、`A1`、`S1/S2`、`I1/I2/I3`、`SV1/SV2` 合并外观二级页签、`C1/C2` 语义徽章、`A11Y-01` 全 `tablist` 方向键漫游）与 `AP-1/2/3`、`PL-1`、`AQ-1`、`IR-1` 及 9 项 P2 前端缺陷修复。

---

## 二、物理目录所有权与双门禁流程

- `@lead`：独占根配置、`assets/icons/`、`public/icons/`、`docs/architecture.md` 及 `src/shared/`；
- `@backend`：独占 `src/main/`；
- `@frontend`：独占 `src/renderer/`；
- `@tester`：独占 `tests/`（真实构建、24h/7d/30d 热力图、Cost 精度、Plugins CLI mock、历史导入零写入断言、各主题实机截图）；
- `@compliance`：只读逐行审查并更新 `docs/compliance/`，签发 `COMPLIANCE_PASS`。

---

## 三、`v0.3` 前端 UI 与交互重构补充说明

在保持 `src/shared/` 与 `src/main/` 后端逻辑及 IPC 契约 **100% 不变** 的前提下，前端 `src/renderer/` 已升级为 `v0.3` 统一工作台视图：

- **移除零散弹窗，合并为全屏侧栏式设置中心**：原 `AccountsModal.tsx`、`PluginsModal.tsx`、`ThemeSettingsModal.tsx`、`ApprovalDrawer.tsx`、`AboutModal.tsx`、`TelemetryPopover.tsx` 统一收敛至 `SettingsView.tsx`、`settings/AppearancePanels.tsx` 与 `settings/WorkspacePanels.tsx`（快捷键 `Ctrl+,` 打开，`Escape` 关闭）。
- **独立 `Composer.tsx` 与安全 `Markdown.tsx`**：抽离底部多模态输入框（Slash / `@` 补全、贴图、Mode/Model/Effort 栏）与无原始 HTML 注入的 GFM Markdown 渲染组件。
- **纯 CSS 变量派生与容器查询**：`styles/global.css` 基于 23 个主题色 Token 通过 `color-mix(in srgb, ...)` 统一派生视觉层级，并使用 `@container pane` 适配双分屏与 2×2 四宫格窄窗格布局。
