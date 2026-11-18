# G-Gravity

GitHub 起始版本为 **v0.1.1**。Windows 便携版及本版源码可在发布页下载。[Gravity v0.1.1](https://github.com/Mikotou/G-Gravity/releases/tag/v0.1.1)

这是 Gravity 桌面客户端的独立源码项目。安装包、窗口、任务栏与关于页使用 **Gravity**。正常启动沿用 `%APPDATA%\Gravity` 下的客户端资料。验收程序使用独立的临时目录。

在「设置 → 通用 → 思考翻译方式」中可以选择蜂群译员或本地离线翻译。默认的蜂群模式在新建会话时让主模型创建专属的 `thought-translator`，使用当前官方账号额度。离线模式使用随程序分发的 Mozilla 英文到简体中文模型，翻译在本机完成。蜂群成员不可用时，客户端会尝试本地翻译。两种方式都把译文写回原消息，可以切换「中文 / 原文」对照。

思考默认展开。手动收起一次，现有和后续思考片段都会保持收起，后台继续翻译。正文中的命令、读写和其他工具归入每回合的「操作记录」。终端标记在查看后清除，长命令和输出可以展开。消息中的图片可点开查看原图。将鼠标移到自己发过的消息上，点击铅笔即可编辑并从该处重新发送，原对话仍可查看。

**Gravity** 是一款严格遵循 **Google 服务条款（ToS）** 与 **官方 `agy acp`（Agent Client Protocol，JSON-RPC 2.0 over `stdio`）公开协议** 的本地桌面智能编码工作台（Electron 35 + React 19 + TypeScript 5.8 + Vite 6）。

界面与交互设计融合了 **Claude Code CLI/Desktop** 与 **Codex Desktop** 的工程美学，同时保持后端 100% 仅通过原版 `agy.exe acp` 标准管道通信，不触碰任何私有凭据文件或未公开端点。

---

## 核心特性

1. **三栏专业工作台 + 多会话并发分屏（≤ 4 路）**
   - **左栏（Projects / Threads，`Ctrl+B`）**：按工作区项目分组、关键字过滤、置顶、会话标题本地整理（`分类｜核心事项`），以及本地 Antigravity 历史对话**纯只读**导入浏览与一键续聊。
   - **中栏（对话主舞台，`Ctrl+\`）**：支持最多 **4 个并行活跃会话**，支持单栏（`Single`）、左右双分屏（`Split`）、2×2 四宫格（`4-Grid`）自适应容器布局（`@container pane`）。
   - **右栏（Resizable Inspector，`Ctrl+J`）**：可拖拽调宽，集成 `Diff`、`Files Changed`、`Plan / Todo`、`Terminal`、`Context & Cost`、`Swarm` 六大检视面板。

2. **Claude Code 风格对话流与多模态 Composer**
   - 用户消息采用紧凑卡片 / `>` 提示风格；助手流式输出支持完整 GFM Markdown 渲染（代码语言头 + 一键复制、表格、列表、链接安全拦截）、折叠式 `Thinking` 双轨切换（`中文 / Raw`）、同层收纳的操作记录（`Bash / Read / Edit / Write / Grep`，展开查看参数/输出与红绿行级 Unified Diff）。
   - 底部统一 **Composer**：支持 `/` Slash 命令弹窗补全、`@` 工作区文件与会话引用补全、剪贴板粘贴图片、顶部 `ContextStatusBar`（上下文窗口占用进度、`tok/s`、当前会话参考费用），以及 `Shift+Tab` 循环切换执行模式（`default` / `accept-edits` / `plan` / `auto`）、模型与推理强度（`low` ~ `max`）选择。
   - **内联权限审批（`InlineRequestView`）**：支持数字快捷键 `1–4`（`1. Yes`、`2. Yes, and don't ask again for <safe-prefix>`、`3. Approve for me`、`4. No, and tell Gravity what to do differently`），内置防连击重放与多卡片焦点隔离。

3. **统一全屏设置中心（`Ctrl+,`）与 6 套经典主题 + 自定义配色**
   - 预设主题：`Claude Code Dark`、`Claude Code Light`、`Ubuntu`、`macOS Dark`、`macOS Light`、`Solarized Dark` 及跟随系统（`System`）。
   - 支持实时调整全部 23 个 CSS 颜色 Token 并导入/导出 JSON 主题（经严格 CSS 颜色白名单校验，防样式注入）。
   - 内置 6 套 **100% 原创 Gravity 几何引力终端图标**（SVG / PNG / ICO），可在设置页实时切换窗口与任务栏图标。

4. **Token 热力图（`24h` / `7d` / `30d`）与四维分模型 Cost 构成**
   - 提供 `24h` 按小时柱状图、`7d`（7×24 天×小时矩阵）、`30d` 日历热力格三档切换。
   - 按 `input / cachedInput / output / thinking` × 模型单价表计算参考 API 费用（明确标注*参考 API 价格估算，非实际账单*），支持单价自定义。

5. **多账号隔离 Profile + Plugins / MCP / Skills 面板**
   - **账号（Profiles & ACP 连接）**：通过官方 `agy acp --app-data-dir <isolatedDir>` 实现多账号目录物理隔离；仅支持用户手动切换 Profile 与拉起官方可见终端 `agy acp --login` 登录，**严禁任何自动轮换账号行为**。
   - **Plugins 管理**：仅在用户点击时通过 `execFile(..., { shell: false })` 调用官方 `agy plugin` / `agy mcp` 子命令，Skills 仅做只读 `SKILL.md` 扫描。

---

## 快速开始与常用命令

### 环境要求
- **Node.js** `>= 22`（项目使用 Node 内置 `node:sqlite` 只读解析历史摘要副本）
- **官方 `agy` CLI**：已安装并加入系统 `PATH`（或通过环境变量 `AGY_BINARY_PATH` 指定 `agy.exe` 绝对路径）

### 安装与运行

```bash
# 1. 安装依赖
npm ci

# 2. 检查共享代码、主进程、界面和测试代码的类型
npm run typecheck

# 3. 运行自动化测试套件（Vitest，含合规边界与 UI 集成测试）
npm test

# 4. 构建生产产物（dist/main + dist/renderer）
npm run build

# 5. 构建并启动 Gravity 桌面客户端
npm start

# 6. 打包 Windows 可执行文件（输出 release/Gravity.exe 便携单文件与 release/win-unpacked/Gravity.exe 免解压版）
npm run dist:exe

# 7. 在 Windows 上打开两个发行版并验证设置持久化
npm run test:desktop
```

本次验收记录包含真实蜂群翻译、Windows 便携版对话、发行文件校验值和复跑步骤。[查看 G-Gravity 验收记录](./tests/QA-G-Gravity.md)

若本机 `agy.exe` 未加入系统 `PATH`（例如安装在 `D:\agy cli\agy.EXE`），可在 PowerShell 中指定路径启动：

```powershell
$env:AGY_BINARY_PATH = "D:\agy cli\agy.EXE"
npm run start:electron
```

---

## 目录结构说明

```text
G-Gravity/
├── CLAUDE.md                        # 面向 Claude / AI 协作者的工程架构与十大合规红线必读指南
├── README.md                        # 项目总览、启动说明与目录索引（本文件）
├── docs/
│   ├── architecture.md              # 客户端架构总纲与模块职责说明（含 v0.2 核心与 v0.3 UI 重构）
│   └── compliance/
│       └── audit-report.md          # Google ToS 与账号安全十大合规红线逐项审计报告
├── assets/icons/                    # Electron 主进程窗口图标资产（6 套原创配色 × svg/png/ico）
├── public/icons/                    # Renderer 静态图标资产（6 套原创配色 × svg/png/ico）
├── src/
│   ├── shared/                      # 主进程与渲染进程共享类型契约与安全校验函数（10 个文件）
│   │   ├── acp-protocol.ts          # ACP JSON-RPC 协议类型与命令行参数黑白名单
│   │   ├── accounts-history-contract.ts # Profile 契约、凭据硬黑名单与只读历史白名单
│   │   ├── approval-contract.ts     # Approve-for-me 审批模式与风险等级契约
│   │   ├── ipc-channels.ts          # 全量 IPC 通道定义与请求/响应载荷类型
│   │   ├── plugins-contract.ts      # Plugins / MCP / Skills 类型与参数安全校验
│   │   ├── session-contract.ts      # 会话状态、并发上限（≤4）与分屏布局状态契约
│   │   ├── swarm-contract.ts        # Swarm 子智能体拓扑与消息流契约
│   │   ├── telemetry-contract.ts    # 24h/7d/30d 热力图与四维模型单价契约
│   │   ├── theme-i18n-contract.ts   # 6 套预设主题、23 色 Token 与防注入颜色校验器
│   │   └── index.ts                 # 统一导出入口
│   ├── main/                        # Electron 主进程后端（19 个文件）
│   │   ├── index.ts                 # BrowserWindow 安全沙箱启动、单实例锁与可见终端登录拉起
│   │   ├── preload.ts               # 最小冻结桥接 window.gravityDesktop（仅依赖 electron）
│   │   ├── ipc-router.ts            # 主窗口 + mainFrame 来源校验、参数限流与 IPC 路由绑定
│   │   ├── core-service.ts          # 后端业务编排核心
│   │   ├── acp/acp-client.ts        # 官方 agy acp 子进程 stdio JSON-RPC 2.0 客户端与 429/403 熔断
│   │   ├── session/                 # SessionMultiplexer（多路会话复用）与 InspectorStore
│   │   ├── accounts/                # AccountManager（--app-data-dir 手动隔离 Profile 管理）
│   │   ├── history/                 # HistoryImporter（Antigravity 本地历史纯只读零写入导入）
│   │   ├── approval/                # ApprovalEngine、Shell 词法快筛与可选外部公开 API 复审
│   │   ├── plugins/                 # PluginsManager（官方 agy plugin / mcp CLI 封装与 SKILL.md 只读扫描）
│   │   ├── telemetry/               # TelemetryStore（Token 速率、三档热力图与分模型费用计算）
│   │   ├── translation/             # 公开思考流分段、蜂群成员登记与译文回填
│   │   ├── organizer/               # TitleOrganizer（本地会话分类标题整理）
│   │   ├── swarm/                   # SwarmTracker（被动解析工具流构建多智能体看板）
│   │   ├── workspace/               # WorkspaceFiles（工作区文件树只读检索，供 @ 补全使用）
│   │   └── storage/                 # ClientStore（客户端独立 userData JSON 持久化）
│   └── renderer/                    # React 19 前端渲染层（v0.3 重构，27 个文件）
│       ├── App.tsx                  # 全局状态编排、快捷键绑定与三栏工作台骨架
│       ├── styles/                  # global.css（color-mix 派生设计系统 + 容器查询）与 theme.ts
│       ├── i18n/                    # 中英双语词典（专业技术术语保留英文）
│       ├── services/                # desktop-bridge.ts（前端 IPC 调用与浏览器预览 Mock 回退）
│       └── components/              # TopBar, ProjectSidebar, SessionWorkspaceGrid, SessionPane,
│                                    # Composer, Markdown, RightInspector, ContextCostInspectorView,
│                                    # ContextStatusBar, InlineRequestView, ToolCallCard, ThinkingBlock,
│                                    # UnifiedDiffBlock, SwarmPanel, ReadOnlyHistoryView,
│                                    # NewSessionModal, TitleOrganizerModal, SettingsView + settings/*
└── tests/                           # 自动化回归、可选官方连接测试及 Windows 发行版验收
```

---

## 合规与安全文档索引

在修改任何与账号、网络、进程调用、存储或审批相关的代码前，**必须先阅读**：
1. [`CLAUDE.md`](./CLAUDE.md) —— 工程协作准则与十大不可逾越的合规红线速查。
2. [`docs/compliance/audit-report.md`](./docs/compliance/audit-report.md) —— Google ToS 与账号安全逐项合规审计细则。
3. [`docs/architecture.md`](./docs/architecture.md) —— 架构设计与前后端契约总纲。
