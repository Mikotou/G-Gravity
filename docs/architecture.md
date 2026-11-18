# Gravity 客户端架构总纲与合规契约 (`v0.2` Core + `v0.3` UI)

## 一、产品定位与 v0.2 核心演进

**Gravity**（原内部代号 AGY Studio）是一款严格遵循官方 ACP 协议与 Google 服务条款规范、交互深度融合 **Claude Code** 与 **Codex 桌面端** 精髓的本地专业智能编码客户端：

0. **项目与产品名称**　源码目录使用 `G-Gravity`，npm 包名为 `g-gravity`，Windows 产品名、窗口标题和 About 页显示 **Gravity**。
1. **三栏专业工作台布局**：
   - **左栏（Projects / Threads，`Ctrl+B` 折叠）**：按项目分组、搜索过滤、置顶、运行状态点、本地只读导入的 Antigravity 历史会话分组；
   - **中栏（Claude Code 风格对话主舞台，`Ctrl+\` 分屏）**：支持 2–4 个活跃会话 Tab，以及单栏 / 左右双栏 / 四宫格分屏；
   - **右栏（Resizable Inspector，`Ctrl+J` 折叠、可拖拽调节宽度）**：内置 `Diff`、`Files Changed`、`Plan/Todo`、`Terminal`、`Context`、`Swarm` 标签页，布局与栏宽自动持久化。
2. **Claude Code 级对话流与底部 Composer**：
   - 用户可编辑先前消息并从该处继续。客户端按编辑位置建立独立会话，将先前的公开对话作为首轮上下文传入，保留原分支。命令和文件操作归在每回合的同一个折叠层级，正文及附件图片可放大。思考块默认展开并记住手动选择。翻译由主进程调度，可选官方蜂群成员或本机离线模型。终端按资料和会话记住已读结果。
   - 底部多行输入框支持 `/` Slash 命令补全、`@` 文件/会话引用补全、剪贴板粘贴图片；上方常驻 Status Line（Context 占用、`tok/s`、本会话 Cost）；左下显示当前 Mode（`default / accept-edits / plan / auto`，`Shift+Tab` 循环切换）与审批档位；右下显示 Model 与 Effort（`low / medium / high / xhigh / max`）；
   - 内联 Request View 升级为 Claude Code 编号选项列表（`1. Yes` / `2. Yes, and don't ask again for <prefix>` / `3. Approve for me` / `4. No, and tell Gravity what to do differently`）。
3. **6 套经典预设主题 + 自定义取色工坊 + 原创 Gravity 图标**：
   - 内置 `Claude Code Dark`、`Claude Code Light`、`Ubuntu`、`macOS Dark`、`macOS Light`、`Solarized Dark` 6 套预设及跟随系统明暗；
   - 设置页提供取色器实时编辑全部主要 Design Tokens（含 Diff 增删色与语法高亮色），支持安全导入/导出 JSON 主题文件（经 `isValidCssColorToken` 白名单校验防 CSP 绕过）；
   - 提供 6 套 100% 原创 **Gravity** 几何引力终端图标（`assets/icons/` 与 `public/icons/` 下均提供 SVG + PNG + `.ico`），严禁复制或改色任何第三方受版权/商标保护标识，支持在设置页一键切换窗口与界面图标。
4. **专业中英术语混排策略（Unified Glossary）**：
   - 技术术语保留英文原名（模型名、`Bash/Read/Edit/Write/Grep`、Slash 命令、路径、`Token`、`tok/s`、`MCP`、`Skills`、`Plugins`、`Diff`、`Context`、`Cost`、快捷键、`mode` 与 `effort` 名称等）；
   - 说明文案、动作描述、风险解释与错误提示使用地道简体中文（支持在设置与顶栏一键切换 `简体中文 / English`）。
5. **三档 Token 热力图（`24h` / `7d` / `30d`）与精细化分模型 Cost 看板**：
   - 移除 52 周热力图与订阅回本对比；提供 **24h 按小时柱状图**、**7d（7×24 天×小时热力矩阵）**、**30d 按天日历热力格** 三档切换；
   - 按 **本会话 / 今日 / 7d / 30d** 计算精细四维费用（`input / cachedInput / output / thinking` × 模型单价），提供 **分模型堆叠柱状图 + 环形占比图**，支持编辑单价表，并明确标注“参考 API 价格估算，非实际账单”。
6. **Plugins 管理面板（Plugins / MCP Servers / Skills）**：
   - 仅在用户点击触发时以 `shell: false` 短时调用官方 CLI 子命令（`agy plugin list|install|uninstall|enable|disable`、`agy mcp list|add|remove|enable|disable`），严禁直接改写 `agy` 内部配置文件；内置能力标记 `Built-in`。
7. **多账号手动 Profile 切换与本地历史会话只读同步**：
   - 多账号通过为不同 Profile 传入客户端自有隔离目录 `agy acp --app-data-dir <profileDir>` 交由官方 CLI 自行管理凭据，登出优先走 ACP `auth/logout`；仅展示 ACP 暴露的身份信息，**严禁在 429/403 或配额耗尽时自动轮换账号（Account Rotation 零容忍）**；
   - 本地历史同步仅以**纯只读、零写入**方式解析用户自有会话内容（`transcript.jsonl`、`conversations/history` 及 `node:sqlite` `{ readOnly: true }` 打开 `conversation_summaries.db`），通过 `isAllowedReadOnlyHistoryFile` 硬白名单与 `isForbiddenCredentialOrStatePath` 硬黑名单严防读取任何 OAuth / token / cookie / `installation_id` / `*.pbtxt` / 加密凭据文件；用 `fs.watch` + 防抖增量刷新，并提供“在 Gravity 中继续”（新建标准 ACP 会话带入摘要）。

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
