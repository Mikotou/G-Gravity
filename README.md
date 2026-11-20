<div align="center">

<img src="./assets/icons/gravity-claude-dark.svg" width="88" height="88" alt="Gravity Logo" />

# G-Gravity

**面向 Google Antigravity (`agy`) 的本地桌面智能编码工作台（Windows & macOS）**

Claude Code Studio 桌面交互 · 零额度本地离线思考汉化 · 100% 遵循官方公开 `agy acp` 协议

[**⬇️ 下载 Windows / macOS 发行版**](https://github.com/Mikotou/G-Gravity/releases) · [与反代及 CLI 区别](#comparison) · [为什么不会封号](#compliance) · [为什么限制并发](#concurrency) · [内置插件说明](#builtin-plugins) · [使用注意事项](#precautions) · [快速上手](#quick-start)

</div>

---

## 👋 一、它是什么？

如果你正在使用官方 `agy` 命令行工具进行 AI 辅助编码，但希望获得**更清爽的可视化界面、红绿行级代码 Diff、零额度离线中文思考阅读、以及可控的内联权限审批体验**，**Gravity**（仓库名 `G-Gravity`）就是为此打造的本地桌面工作台：

- **跨平台桌面端**：支持 **Windows 10/11 (x64)** 单文件便携版，以及 **macOS (Apple Silicon `arm64` & Intel `x64`)** `.dmg` / `.zip` 安装包。
- **即插即用、零中转**：直接连接你本机已安装并登录的官方原版 `agy` CLI，**不需要任何第三方反代、代理池或外泄账号 Token**。
- **安心合规**：底层 100% 仅通过官方公开标准协议 **`agy acp`（Agent Client Protocol，JSON-RPC 2.0 over `stdio`）** 通信，所有核心合规边界由自动化测试套件长期守卫。

> 📌 **命名与数据目录说明**：源码仓库名为 `G-Gravity`，打包后的应用与窗口名称均为 **Gravity**。客户端自身设置与会话记录独立保存在本地应用数据目录（Windows：`%APPDATA%\Gravity`；macOS：`~/Library/Application Support/Gravity`），**绝不修改官方 `~/.gemini` 目录**。

---

<a id="comparison"></a>

## ⚖️ 二、Gravity 与「第三方反代」及「原生 CLI」有什么区别？

很多用户容易把桌面客户端与市面上的“反代 / 中转站 / 号池工具”混淆，下面从协议、安全与体验三个维度做清晰对比：

| 对比维度 | 第三方反代 / 号池工具 | 原生 `agy` CLI | **Gravity（本项目）** |
| :--- | :--- | :--- | :--- |
| **底层通信方式** | 抓包逆向私有内部 API（如 `cloudcode-pa`），伪造客户端请求头 | 官方原版 `agy` 进程直连 Google 服务 | **100% 调用你本机未修改的原版 `agy acp`（标准 `stdio` JSON-RPC）** |
| **账号凭据处理** | 通常需要提取/导入你的 OAuth Token / Cookie，或上传到中转服务器 | 由官方 CLI 自行管理 | **零触碰任何私有凭据文件**，认证与鉴权 100% 留在官方 `agy` 内部 |
| **账号封禁风险** | **极高**（违反 Google ToS：私有端点滥用、伪造 UA、多号轮换池化） | 官方原生行为 | **客户端层遵循官方公开协议与并发/冷却守卫，不引入外挂或反代风控因素** |
| **代码与对话隐私** | 请求经过第三方中转服务器，存在泄露风险 | 仅本机直连官方 | **纯本机进程间 `stdio` 通信**，无任何第三方中转服务器 |
| **交互与可视化** | 依赖外部套壳聊天页，通常缺失本地工作区 Diff / 终端 / 审批联动 | 纯终端文本流，长输出易刷屏、Diff 与多会话切换不够直观 | **Claude Code Studio 桌面工作台**：活动栏 + 项目抽屉 + 单/双分屏 + 可悬浮检视器（Diff / Files / Plan / Terminal / Context / Swarm） |
| **英文思考汉化** | 无或额外消耗模型额度翻译 | 原样输出英文思考 | **内置离线 Bergamot 模型本地实时英译简中**，零联网、零额度消耗、支持中/原文切换 |
| **权限审批与安全** | 常见粗暴跳过权限（`--dangerously-skip-permissions`） | 终端逐条确认 | **内联 `1`–`4` 键帽审批卡 + 本地 Shell AST 安全快筛 + 会话前缀记忆 + 审计日志** |
| **多账号管理** | 自动轮换号池绕过配额（高危违规） | 手动命令行切环境 | 基于官方公开 `--app-data-dir` 物理隔离，**100% 人工手动切号，严禁自动轮换** |

**一句话总结**：
- **相对反代**：Gravity **不是反代、不是代理、不是号池**，而是官方原版 `agy` CLI 的**本地官方协议可视化外壳**。
- **相对原生 CLI**：底层完全还是你电脑里的官方 `agy`，但把命令行升级成了更适合复杂工程研发的现代化桌面 IDE 级工作台。

---

<a id="compliance"></a>

## 🛡️ 三、为什么不会违反用户使用规定导致封号？

Gravity 在架构立项阶段就确立了**十大不可逾越的合规红线**（完整技术细则见 [`CLAUDE.md`](./CLAUDE.md)，逐项代码审计报告见 [`docs/compliance/audit-report.md`](./docs/compliance/audit-report.md)），并通过 `tests/security-baseline.test.ts`、`tests/acp-boundaries.test.ts`、`tests/accounts-v02.test.ts`、`tests/history-import-v02.test.ts` 在每次构建前自动校验：

1. **只走官方公开协议，零私有接口**
   - 仅通过 `agy acp` 公开标准协议通信。源码静态扫描守卫确保全仓库**不包含**任何 `cloudcode-pa.googleapis.com` 等 Google 非公开内部端点 URL。
2. **零触碰任何私有凭据与认证状态（Windows & macOS 四级精细权限策略）**
   - 审批与安全路径引擎对 `.gemini` 与 macOS `~/Library/Application Support/Antigravity` 实施四级精细治理：
     - **核心凭据禁区（硬拦截，禁读写）**：`oauth_creds.json`、`google_accounts.json`、`installation_id`、`antigravity-cli/auth`、`*.pbtxt`、`Cookies`、`state.vscdb`、macOS `Library/Keychains`、`*.keychain*`、`.binarycookies`、`security find-*-password/dump-keychain` 等。
     - **官方内部数据（仅允许只读查询，禁改写）**：`brain`、`conversations`、`history`、`conversation_summaries.db`、`antigravity/User/settings.json`、`mcp_config.json`、`tmp`、`cache`、`logs` 等。
     - **用户自定义目录（正常读写，写入/改写时弹出确认）**：`~/.gemini/config/plugins`、`skills`、`rules`、`hooks`、`workflows`、`extensions`、`GEMINI.md` 等，不再“一刀切”误伤日常排障或插件管理。
     - **其他未知路径**：默认转交人工确认（Fail-Closed）。
3. **不修改官方二进制，不注入越权/伪装参数**
   - 原样拉起官方 `agy` / `agy.exe`，绝不做二进制补丁或 `NODE_OPTIONS` / `ELECTRON_RUN_AS_NODE` 劫持。
   - 所有启动参数必须通过 `validateAgyArgs()` 严格白名单放行且固定 `shell: false`，明确禁止 `--dangerously-skip-permissions`、`--override_user_agent_name`、`--cloud_code_endpoint`、`--use_stubby_auth`、`--is_google3_workspace`、`--is_google_internal` 等参数。
4. **本地官方历史 100% 只读、0 字节写入**
   - 导入本地 Antigravity 历史仅在只读白名单内读取副本，对官方目录保持 **0 写入、0 新增文件**；点击「在 Gravity 中继续」会通过标准 `agy acp` 新建一个全新会话并附带摘要，绝不篡改原历史。
5. **多账号严禁自动轮换（Zero Account Rotation）**
   - 多账号隔离仅使用官方公开参数 `--app-data-dir <isolatedDir>`，登录必须由用户点击按钮在可见官方终端中手动完成 `--login`。
   - **绝对禁止**在遇到 `429`、`403`、`RESOURCE_EXHAUSTED` 或网络错误时自动切换其他账号绕过配额。
6. **低噪、克制的附加功能调用**
   - 思考汉化完全使用随包分发的离线模型在本地线程推理，**不产生任何额外服务端请求**。
   - 内置 AI 标题整理（`Hydrogen medium`）**不会自动在后台偷跑**，只在你主动点击按钮时才发起一次只读短会话，用毕立即关闭，且受 1 分钟 4 次冷却保护。
   - Plugins / MCP 管理不在启动时冷刷 CLI，仅在设置页点击刷新或操作时短时运行官方 `agy plugin` / `agy mcp` 子命令，绝不直接覆写 `agy` 内部配置文件。
7. **Electron 强沙箱隔离**
   - 渲染窗口严格启用 `contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`、`webSecurity: true`，主进程校验每个 IPC 请求必须来自主窗口 `mainFrame`，自定义主题色值经正则校验防 CSS `url(...)` 外链注入。

> ⚠️ **客观免责提示**：Gravity 从软件架构上严格遵守官方公开协议与 ToS 边界，不引入任何反代/篡改/轮换类风控因素；但账号的最终安全仍取决于用户自身的使用方式（例如遵守 Google 服务条款、使用合规网络环境、不在短时间内滥用自动化脚本压测配额等）。

---

<a id="concurrency"></a>

## 🚦 四、为什么要限制多并发任务（最多 4 路并发与冷却机制）？

Gravity 在**共享契约层、主进程调度器（`SessionMultiplexer`）与前端界面三端**共同强制约束：

> **单客户端最多同时打开 `4` 个活动会话（`MAX_PARALLEL_ACTIVE_SESSIONS = 4`）**，同时配合限流熔断与标题整理共享冷却。

这样设计并非技术偷懒，而是出于三点非常现实的保护考量：

1. **防止触发官方风控与高频限流（`429 / 403`）**
   - 单账号如果同时挂起十几个并行 Agent 不断高频收发请求，极易被服务端风控模型判定为非人类自动化压测或异常滥用，轻则触发 `429 RESOURCE_EXHAUSTED` 长时间限流，重则触发账号安全验证甚至封禁。
   - `4` 路并行刚好覆盖真实开发者的黄金上限（例如：左栏主编码任务 + 右栏代码审查/测试 + 2 个后台查阅或临时问答标签），同时让请求节律始终停留在安全、自然的区间内。
2. **保护本机资源与工作区文件一致性**
   - Gravity 默认在单个常驻 `agy acp` 进程内复用多会话，过多活跃上下文会导致内存与文件句柄急剧膨胀；同时并发打开过多 Agent 写入同一个项目目录，极易互相覆盖代码修改或触发 Git 锁冲突。
3. **配合服务端退避熔断，杜绝死循环重试**
   - **全局 `429 / 403` 熔断**：一旦官方返回 `429 / RESOURCE_EXHAUSTED`，本地通道立即熔断冷却至少 **60 秒**；返回 `403 / PERMISSION_DENIED` 则冷却至少 **300 秒**，冷却期内在写管道前直接本地拦截，绝不死循环重试激怒风控。
   - **AI 标题整理共享冷却**：顶部「全部整理」、单个 Project 整理、单个会话整理三个入口共享 **1 分钟内最多 4 次**的滑动窗口冷却，避免误连点造成短时突发请求。

> 💡 **小贴士**：达到 4 个活动标签上限时，关闭不需要的标签页**只会释放活动连接槽位，绝不会删除对话记录**——你随时可以从左侧会话抽屉一键点开恢复继续聊。

---

<a id="builtin-plugins"></a>

## 🧩 五、当前内置插件与核心内置能力说明

在「设置 → **Plugins**」中，Gravity 内置了两项标注为 **`Built-in`** 的原生核心能力，并与官方 Plugins / MCP / Skills 管理器及工作台引擎无缝协同：

### 1. `Approve for me`（Built-in · 零冷启动内联权限安全审查引擎）
当智能体请求执行 Shell 命令、修改敏感路径或调用高风险工具时，对话流内直接弹出 Claude Code 风格审批卡，无需拉起外部子进程即可毫秒级完成审查：
- **三档安全模式一键切换**（输入框左下角即可热切）：
  - **`AI 代审（hybrid）`**：先走本地多段 Shell AST 词法安全快筛，低风险只读检索自动放行，复杂或高危命令可按需交由你配置的独立模型复审，无法确信一律转交人工。
  - **`仅快筛（rules-only）`**：纯本地规则与词法分析，零额外模型调用，匹配安全白名单放行、命中询问/拒绝规则拦截。
  - **`纯人工（manual）`**：所有敏感操作均弹出内联卡片，由你按键盘数字 **`1` ~ `4`** 亲自决定。
- **多段 Shell 词法快筛 + 会话前缀记住**：自动拆解 `&&`、`||`、`;`、`|` 复合命令，精准识别纯只读检查（如 `git status`、`rg`、`ls`），拦截 `rm -rf`、提权、覆写敏感目录、危险管道执行等高危操作；支持按 `2` 记住安全命令前缀，按 `4` 拒绝并附带调整指令。
- **可选独立模型复审（系统级加密持久化，明文零落盘）**：支持在设置页配置你自己的公开 API（Gemini API / OpenAI 兼容接口 / 本机 `127.0.0.1` Ollama），填完 API Key 后自动查询服务端允许使用的模型与思考强度，由你自由选择模型、思考强度、`timeout`（默认 `8000ms`）与 `maxOutputTokens`（默认 `4096`）；**API Key 仅以操作系统级加密密文（Windows DPAPI / macOS 钥匙串）独立保存，明文绝不写入配置 JSON，版本更新与重启自动保留**。
- **自定义正则规则与完整审计日志**：支持自由增删 `Allow / Ask / Deny` 正则规则，每条自动放行、人工确认或拦截记录均写入审计日志可随时溯源。

### 2. `Context & Cost Inspector`（Built-in · 上下文与费用实时分析看板）
常驻右侧检视器 `Context` 页签，与输入框底栏状态条实时联动：
- **实时 Context 压缩窗口监控**：默认涵盖最新模型（含 `Gemini 4 Neon / Carbon / Hydrogen / Orchestrator` 的 `512k` 窗口），并会在回合中自动只读解析本地 `executor_metadata` 里的 `checkpoint_config.max_token_limit` 与 `CASCADE_USE_EXPERIMENT_CHECKPOINTER` 配置，动态学习未来新模型的真实压缩上限；直观展示 System / User / Assistant / Thinking / Tools / Attachments 六类 Token 占比，并自动记录每次手动 `/compact` 与服务端自动压缩前后的 Token 节省量。
- **实时速率 vs 会话平均指标**：
  - **输入框底栏**：展示当前滑动时间窗的 **实时输出速率（`tok/s`）**；
  - **Context 检视器**：展示当前会话累计加权的 **会话平均速率（Avg `tok/s`）** 与 **平均缓存命中率（`Cached / (Input + Cached)`）**，并跨重启持久化。
- **三档 Token 热力图与四维参考费用**：提供 `24h`（按小时柱图）、`7d`（7×24 天×小时矩阵）、`30d`（按天日历热力格）三档统计；按 `本会话 / 今日 / 7d / 30d` 四维度拆分 `Input / Cached / Output / Thinking` 四项参考费用与分模型环形占比图，支持在设置页自由编辑各模型参考单价卡（固定标注“参考 API 价格估算，非实际账单”）。

### 3. 官方 `Plugins / MCP Servers / Skills` 统一管理器
- **官方 Plugins 管理**：在设置页点击刷新后，通过官方 `agy plugin list --json / install / uninstall / enable / disable` 子命令（`shell: false` + 参数安全校验）管理官方插件，不直接修改 `agy` 内部文件。
- **官方 MCP Servers 管理**：可视化查看 `stdio` / `http` 类型 MCP 服务状态，支持通过官方 `agy mcp add / remove / enable / disable` 增删与启停，并自动脱敏命令回显中的敏感凭证字段。
- **Skills 只读发现与本地开关**：自动只读扫描当前工作区 `.agents/skills`、全局与插件目录中的 `SKILL.md`（防符号链接穿越与敏感路径拦截），在客户端本地记录启用偏好。

### 4. 其他工作台内置引擎
- **零额度本地离线思考汉化（Bergamot Engine）**：随包分发 Mozilla 英译简中模型，流式按句界分段在本地线程实时翻译英文思考过程，保护代码块、命令与文件路径不被误翻，支持「中文 / 原文」一键切换、平滑中文显影动效与折叠记忆。
- **按需内置 AI 标题整理（`Hydrogen medium`）**：仅在用户主动点击时通过官方 `agy acp` 临时只读会话调用内置 `Hydrogen (medium)` 整理为 `分类｜核心主题`；顶部「全部整理」自动跳过先前已整理的会话，每个 Project 分组与每条会话也均配有独立整理按钮，三者共享 1 分钟最多 4 次冷却，整理过程实时提示当前所用模型。
- **Swarm 多智能体态势看板**：被动监听主会话中的 `swarm` / `invoke_subagent` / `send_message` 工具流，实时展示成员状态、任务分工、消息板与动作时间线。
- **内置 GitHub Releases 自动更新**：自动对接本仓库 `Mikotou/G-Gravity` Releases，按操作系统与架构匹配最新安装包（`Windows x64` / `macOS arm64` / `macOS x64`），支持启动静默检查、进度条下载与一键替换重启（可在「设置 → 关于」随时检查或关闭启动自动检查）。

---

<a id="layout"></a>

## 🖥️ 六、界面布局与核心亮点（v0.2.1 一体化无边框 Claude Code Studio）

Gravity 采用 **一体化无边框 Claude Code Studio** 桌面工作台架构（Windows 移除原生厚标题栏并融合透明系统控制键，macOS 采用原生红绿灯内嵌顶栏）：**48px 常驻极窄活动栏 + 可展开/调宽会话抽屉 + 居中对话主舞台（单/双栏）+ 可停靠/悬浮切换的右侧检视器**。抽屉宽度、检视器宽度、双栏比例与输入框高度全部支持拖拽调整（双击分隔条复位），高分辨率屏幕支持 `Ctrl/Cmd + =` / `-` / `0` 整体缩放：

| 🧭 活动栏 + 📁 会话抽屉 (`Ctrl/Cmd+B`) | 💬 中栏 · 对话主舞台 (`Ctrl/Cmd+\`) | 🔍 右栏 · 停靠/悬浮检视器 (`Ctrl/Cmd+J`) |
| :--- | :--- | :--- |
| • 48px 极窄常驻活动栏：品牌入口、一键新建、抽屉开关、项目/插件、账号与设置<br>• 会话抽屉按项目分组、支持药丸搜索清空、置顶、归档与永久删除<br>• **按需 `Hydrogen (medium)` 整理标题**（全部 / 单项目 / 单会话，共享冷却）<br>• **纯只读**导入官方历史对话并一键续聊 | • 支持 **单栏 / 左右双栏**（最多 4 路并发），聚焦窗格以标题左侧 3px 柔砂竖胶囊与表面景深柔和区分，支持从抽屉或标签拖拽换入<br>• 思考区支持 **「中文 / 原文」** 实时离线对照与平滑中文显影动效<br>• 文件读写与终端命令自动聚合为每轮 **「操作记录」**（折叠态带语义色微点）<br>• 已发消息悬停点 `✏️` 或空输入框按 `↑` **编辑并新建分支重发**<br>• 划词支持多条 **Quote 引用** 与 **Notation 逐处批注** 打包发送<br>• 正文末尾图片支持点击原图预览，以及悬停/大图/`Ctrl/Cmd+C`/右键**一键复制图片**<br>• 底部显示**实时 `tok/s`**，右下角以**独立钴蓝进度条 + 百分比**显示 **Gemini 周额度**与 Bento 额度卡片 | • 支持 **停靠 / 悬浮（Docked / Floating）** 一键切换与自由拖宽<br>• **Changes**：红绿行级 Diff 与变更文件清单二级视图<br>• **Plan**：任务拆解与 Todo 实时进度<br>• **Terminal**：命令完整输出（查看后自动清除未读红点）<br>• **Context**：上下文构成、**会话平均 TPS**、**平均缓存命中率**、Token 热力图与参考费用<br>• **Swarm**：多智能体协作拓扑看板 |

内置 **6 套预设主题**（`Claude Code Dark / Light`、`macOS Dark / Light`、`Ubuntu`、`Solarized Dark`，支持跟随系统与 23 色 Token 自定义导入/导出）及 **6 款原创 Gravity 应用图标**（可实时切换窗口与任务栏 / Dock 图标）：

<div align="center">

| Claude Dark | Claude Light | macOS Dark | macOS Light | Ubuntu | Solarized |
| :---: | :---: | :---: | :---: | :---: | :---: |
| <img src="./assets/icons/gravity-claude-dark.svg" width="46" alt="Claude Dark" /> | <img src="./assets/icons/gravity-claude-light.svg" width="46" alt="Claude Light" /> | <img src="./assets/icons/gravity-macos-dark.svg" width="46" alt="macOS Dark" /> | <img src="./assets/icons/gravity-macos-light.svg" width="46" alt="macOS Light" /> | <img src="./assets/icons/gravity-ubuntu.svg" width="46" alt="Ubuntu" /> | <img src="./assets/icons/gravity-solarized.svg" width="46" alt="Solarized" /> |

</div>

---

<a id="quick-start"></a>

## 🚀 七、3 步快速上手（Windows & macOS）

### 1. 确认官方 `agy` CLI 已安装并登录
在系统终端中运行：
```bash
agy --version
```
能够正常输出版本号并已完成官方账号登录即可。

### 2. 下载对应平台的发行版
前往 [**GitHub Releases 发布页**](https://github.com/Mikotou/G-Gravity/releases) 下载最新安装包：

- **Windows 10 / 11 (x64)**：下载 **`Gravity.exe`**（单文件便携版，无需安装，双击直接运行）。
- **macOS Apple Silicon（M1 / M2 / M3 / M4）**：下载 **`Gravity-x.y.z-mac-arm64.dmg`**（或 `.zip`），打开后将 **Gravity.app** 拖入「应用程序」文件夹。
- **macOS Intel（x64）**：下载 **`Gravity-x.y.z-mac-x64.dmg`**（或 `.zip`），拖入「应用程序」文件夹。

### 3. 新建会话开始编码
启动 Gravity 后按下 `Ctrl + N`（macOS 为 `Cmd + N`），选择你的代码项目目录，即可开始编码对话！

<details>
<summary>💡 <b>首次启动安全提示与自定义 <code>agy</code> 路径启动方法（Windows / macOS）</b></summary>

#### 首次启动拦截提示（开源未签名应用）
- **Windows SmartScreen**：点击弹窗中的 **「更多信息」→「仍要运行」**。
- **macOS Gatekeeper**：因开源项目未使用付费 Apple Developer 证书公证，首次打开若提示“无法验证开发者”或“已损坏”，请在终端运行一次以下命令移除隔离标记，再双击打开：
  ```bash
  xattr -cr /Applications/Gravity.app
  ```

#### 提示找不到 `agy` 命令时手动指定路径
- **Windows (PowerShell)**：
  ```powershell
  $env:AGY_BINARY_PATH = "D:\agy cli\agy.exe"
  .\Gravity.exe
  ```
- **macOS (zsh / bash)**：
  Gravity 在 macOS 上会自动检索 `PATH` 以及 `/opt/homebrew/bin`、`/usr/local/bin`、`~/.local/bin` 等常见目录；若安装在自定义位置，可通过终端指定路径启动：
  ```bash
  AGY_BINARY_PATH="/path/to/agy" open -a /Applications/Gravity.app
  ```

</details>

---

<a id="precautions"></a>

## ⚠️ 八、使用上需要注意什么？

为了获得最稳妥、顺手的体验，使用前请留意以下 8 点：

1. **必须先安装并登录官方原版 `agy` CLI**：Gravity 不自带后端账号服务，也绝不代管你的登录凭据。请保持官方 `agy` 处于可用、已登录状态；登录过期时可在「设置 → 账号」中点击拉起官方可见终端重新 `--login`。
2. **Windows 与 macOS 功能差异提示**：
   - **官方账户额度自动读取**：目前通过 Windows 官方客户端状态行读取；**macOS 版暂不支持自动轮询额度数值**，macOS 用户请直接在终端运行 `agy` 查看实时额度。
   - **快捷键修饰键**：下文快捷键中的 `Ctrl` 在 macOS 上对应 `Cmd`（`⌘`）。
3. **双栏并发避免写冲突**：虽然支持最多 4 路并行会话与左右双栏，但请**尽量避免两个会话在 `accept-edits` / `auto` 模式下同时修改同一个项目目录里的同一批文件**，以免出现写覆盖或 Git 索引锁冲突。
4. **4 会话上限与标签关闭**：打开第 5 个会话前，先关闭一个闲置标签页即可。关闭标签只会断开该会话的活跃 ACP 槽位，**对话记录、Diff 与终端输出仍完整保存在本地**，随时可从左侧抽屉重新点开恢复。
5. **合理选择权限模式与审批档位**：探索陌生代码库建议使用 `plan`（只读分析）或 `default` + `AI 代审 / 人工确认`；仅在你信任的隔离工作区中开启 `accept-edits` 或 `auto`。若启用了「外部模型辅助复审」，API Key 会使用操作系统级加密（Windows DPAPI / macOS 钥匙串）独立保存，更新与重启后无需重复填写。
6. **AI 标题整理为按需手动触发**：内置 `Hydrogen (medium)` 标题整理**绝不会自动在后台执行**，只有你点击整理按钮时才会消耗少量官方额度；「全部整理」会跳过曾经整理过的会话，想重新整理特定项目或对话请点击对应 Project / Session 行上的单独整理按钮（三者共享 **1 分钟最多 4 次**冷却）。
7. **触发 `429 / 403` 时请耐心等待冷却**：遇到官方配额或权限限制时，Gravity 会自动进入 60s / 300s 熔断冷却，这是为了保护账号安全，请勿通过反复重启或切换多号强行绕过限流。
8. **费用看板仅供参考**：右侧 `Context & Cost` 中的美元金额是根据公开参考单价（或你自定义的费率表）估算的结果，**并非 Google 官方实际账单**。

---

<a id="shortcuts"></a>

## ⌨️ 九、快捷键与交互速查

> macOS 用户请将下表中的 `Ctrl` 替换为 `Cmd`（`⌘`）。

| 快捷键 / 操作 | 功能说明 |
| :--- | :--- |
| `Ctrl + N` | 新建对话（选择项目目录与初始模式） |
| `Ctrl + B` | 展开 / 收起左侧「会话抽屉」 |
| `Ctrl + \` | 切换工作区分屏模式（单栏 ↔ 左右双栏） |
| `Ctrl + J` | 展开 / 收起右侧「检视器面板」（支持停靠 / 悬浮切换） |
| `Ctrl + ,` | 打开 / 关闭全屏设置中心（打开时也可按 `Esc` 关闭） |
| `Shift + Tab` | 循环切换当前会话执行模式（`default` / `accept-edits` / `plan` / `auto`） |
| `Ctrl + =` / `Ctrl + -` / `Ctrl + 0` | 放大 / 缩小 / 复原界面整体缩放（2K / 4K 高分屏适配） |
| 生成中按 `Esc` | 中断当前回合（保留输入框内未发送草稿） |
| 空输入框按 `↑` | 快速编辑上一条已发送消息并从该处拉出新分支重发 |
| 拖动 / 双击分隔条 | 调整抽屉、检视器宽度、双栏比例与输入框高度 / 恢复默认 |
| 数字键 `1` ~ `4` | 权限审批卡片快捷决策（`1` 允许 · `2` 记住安全前缀 · `3` 自动代审 · `4` 拒绝并说明） |
| 大图预览中按 `Ctrl + C` | 将当前查看的正文图片直接复制到系统剪贴板 |
| 输入 `/` 或 `@` | 呼出斜杠命令菜单（如 `/compact`）或引用工作区文件 / 会话 |

---

<a id="dev-guide"></a>

## 🛠️ 十、开发者指南

### 环境要求
- **操作系统**：Windows 10 / 11 (x64) 或 macOS 13+ (Apple Silicon `arm64` / Intel `x64`)
- **Node.js**：`>= 22`（使用内置 `node:sqlite` 只读解析历史摘要副本）
- **官方 `agy` CLI**：已安装并可在终端运行

### 源码安装、验证与打包

```bash
# 1. 安装依赖
npm ci

# 2. 全量 TypeScript 类型检查（shared + main + renderer + tests）
npm run typecheck

# 3. 运行全量自动化测试套件（Vitest，含十大合规红线守卫与前后端集成测试）
npm test

# 4. 构建生产产物（dist/main + dist/renderer）
npm run build

# 5. 构建并本地启动桌面客户端
npm start

# 6. 打包 Windows 便携版与免解压目录版（在 Windows 上运行）
npm run dist:exe

# 7. 打包 macOS Apple Silicon & Intel 安装包（在 macOS 上运行）
npm run dist:mac

# 8. 运行 Chromium 布局与动效冒烟 / Windows 发行版双包桌面冒烟
npm run test:layout
npm run test:desktop
```

- **版本验收记录**：详见 [`tests/QA-G-Gravity.md`](./tests/QA-G-Gravity.md)。
- **合规红线与工程规范**：详见 [`CLAUDE.md`](./CLAUDE.md) 与 [`docs/compliance/audit-report.md`](./docs/compliance/audit-report.md)。
- **架构总纲**：详见 [`docs/architecture.md`](./docs/architecture.md)。

<details>
<summary>📂 <b>点击展开核心源码目录结构</b></summary>

```text
G-Gravity/
├── .github/workflows/release.yml    # GitHub Actions 自动构建并发布 Windows & macOS Release
├── CLAUDE.md                        # 工程架构规范与十大合规红线必读指南
├── README.md                        # 项目介绍、合规说明、内置插件、使用须知与开发指南
├── docs/
│   ├── architecture.md              # 客户端架构总纲与模块职责说明
│   └── compliance/audit-report.md   # Google ToS 与账号安全十大合规红线逐项审计报告
├── assets/
│   ├── icons/                       # 6 套原创配色图标（SVG / PNG / ICO + 1024px macOS 图标）
│   ├── local-translation/           # 随包分发的 Mozilla (Bergamot) 英译简中离线翻译模型与许可证
│   └── quota/                       # Windows 官方账户额度只读查询辅助脚本
├── public/icons/                    # Renderer 静态图标资产
├── src/
│   ├── shared/                      # 主进程与渲染进程共享类型契约与纯安全校验函数
│   ├── main/                        # Electron 35 主进程后端（ACP、多会话复用、账号隔离、审批、离线翻译、AI 标题整理、遥测、插件管理）
│   └── renderer/                    # React 19 + Vite 6 Claude Code Studio 前端工作台与主题系统
└── tests/                           # Vitest 自动化回归测试、Chromium 布局冒烟、Windows 双包桌面冒烟与 QA 验收记录
```

</details>
