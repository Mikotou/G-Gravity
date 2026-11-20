# Gravity v0.2 质量门禁报告

日期：2026-11-17；责任人：@tester；工作目录：`F:\插件-Gemini`。

**QA_PASS：v0.2 本地构建、Mock ACP 业务联调、只读历史合成夹具、组件交互与原生六主题截图范围。**

本结论交由 @lead 与独立 COMPLIANCE_PASS 共同收敛；不代替法律审计，不声称真实订阅生成、外部模型质量或安装包分发已经验收。测试成员只写 `tests/`，未修改业务源码、共享契约、根配置或图标资产。

## 最终真实运行证据

| 检查 | 结果 | 日志 |
| --- | --- | --- |
| `npm test` | **21 个文件、281 项用例通过**；官方探针默认跳过 1 项；退出码 0 | `tests/artifacts/qa-v02-tests.log` |
| `npm run typecheck` | shared/main/renderer 全通过，退出码 0 | `tests/artifacts/qa-v02-typecheck.log` |
| `npm run build` | 主进程编译、renderer 生产构建成功，退出码 0；Vite 转换 1624 模块 | `tests/artifacts/qa-v02-build.log` |
| `npx tsc --noEmit -p tsconfig.json` | 包含测试代码的类型检查通过，退出码 0 | `tests/artifacts/qa-v02-project-typecheck.log` |
| 显式设置 `AGY_OFFICIAL_SMOKE=1` 后运行 `npm test -- tests/official-acp-smoke.test.ts` | 额外 **1/1 通过**，退出码 0；本机原版 `agy acp initialize` 返回 protocolVersion=1、Antigravity ACP Server 1.5.10 | `tests/artifacts/qa-v02-official-smoke.log` |

最后全套运行开始于本地时间 16:50:06，Vitest 报告用时 4.08 秒。官方探针只做初始化并关闭所属子进程，不创建会话、不发送提示、不读取登录凭据。当前构建生成 `dist/main/index.js` 与 `dist/renderer/index.html` 及资产；未生成或验证安装包。

## 关键验证矩阵

| 关卡 | 实际证据与覆盖边界 |
| --- | --- |
| 构建与桥接 | 三端与测试类型检查、生产编译通过；CoreBridge 对全部 v0.2 新方法与 Inspector/History/Account 事件连接实际 CoreService；preload 编译产物、IPC 主 frame/URL/体积与隔离设置守卫通过。 |
| ACP 与四会话 | 实际 stdin/stdout 桩进程与真正 AcpClient/SessionMultiplexer/CoreService，单连接四会话、第五槽位阻断、正文/思考/工具/权限/蜂群按 sessionId 隔离；单会话取消不影响其他会话；恢复、EOF、宿主优雅停止回收；UTF-8 分片、粘包、坏消息、超限消息及 403/429 无自动重试。 |
| 审批闭环 | hybrid/rules-only 安全快筛、危险命令与敏感路径、会话与 cwd 前缀隔离、允许一次不缓存、四分支回传与审计；未配置模型、500、超时、审计写失败、配置变化均 Fail-Closed；实际 UI→Core→桩权限闭环保持单次 spawn，无审批新建 agy。 |
| 审批快捷键 | 同一窗格两张消息关联待审批卡，按数字 1 只对第一张调用一次；缺少后端安全前缀时数字 2 无法放行；输入反馈时数字键不触发审批。此前误批两项缺陷已经原用例回归通过。 |
| 布局与工作台 | Ctrl+B/J 折叠、Ctrl+反斜杠分屏；右栏拖拽持久化并限于 280–680px；Inspector 六页切换；用户块 `>`；工具默认折叠、展开真实红绿 Diff；Files Changed 排除 pending/failed 修改；Slash、@引用与粘贴图片进入冻结 SendPrompt 载荷。 |
| 主题与语言 | 四深两浅六预设、23 tokens 自定义取色、CSS 应用、JSON 导出真实 Blob 内容、非法 URL 主题拒绝、图标切换；中英语言包键完整，说明/错误/提示中文；按 v0.2 约定保留 Bash/Read/Edit 等英文技术名称。思考原文分片不丢块与翻译版本隔离通过，翻译完整性限制见下文。 |
| Mode/Model/Effort | 四档执行 Mode 与三档审批模式分离；Shift+Tab 循环执行 Mode；能力声明时才调用官方 Mode/Model 请求；会话配置隔离；Effort 为本地引导而非伪造官方 RPC。 |
| 上下文与费用 | 24 小时、168 时段、30 天聚合；空历史、多会话、大附件、速率与归零、重复 usage 幂等；官方 input/output 总量拆除 cached/thinking 子集后四维互斥计价，避免重复计算；价格保存、分模型占比、UTC 边界及估算声明；非有限数输入不产生无穷费用。 |
| 只读历史 | 自建临时 JSONL/SQLite 历史，实际业务导入；支持 source/type/created_at；打开真实 SQLite WAL 连接后新提交行可导入；源 db/wal/shm 全树条目、内容、大小、mtime/ctime/mode 前后相同；源 shm 不读取、五类敏感诱饵零 readFile；无 WAL 时只改客户端副本头；真实 fs.watch 防抖、并发扫描、大小限制及缓存隔离。atime 不纳入零写比较。 |
| 历史续聊 | 通过实际 CoreService 将只读历史摘要带入新建标准 ACP 会话，源树仍不变；不向原官方历史文件回写。 |
| 手动账号 | profile 显式切换时才重启连接并传官方 `--app-data-dir`；合成 429/403 不轮换、不新拉连接、不触发登录；删除客户端条目不删官方资料目录；登录参数与 auth/logout 使用可观测测试注入，不进行真实账号操作。 |
| Plugins/MCP/Skills | 13 项业务测试：仅显式操作才执行官方 CLI，`shell:false`、管理互斥、目标拦截、MCP 参数分隔；Skill 只写客户端偏好且源不变。组件安装/MCP 流程走内存适配器；未真实安装或改官方配置。 |
| 图标与基线 | 六变体 × SVG/PNG/ICO × assets/public 共 36 文件存在、格式与对应副本字节一致；主题注入守卫、参数白名单、禁止标志、私有端点/凭据访问静态守卫、独立模型网络地址限制通过。图标原创性与法律合规由专职审计判断。 |

安全快筛本次测试输出 P95 为 hybrid 0.0021ms 量级、rules-only 0.0015ms 量级，低于 5ms；这是本机固定样本的规则调用测量，不承诺所有命令或外部模型延时。

## 原生窗口六主题截图

运行真实生产入口的 Electron 窗口，窗口标题为 Gravity，界面显示官方 ACP 已连接。通过 Windows Computer Use 在设置页逐个选择预设并返回工作台截图，非 HTML 重画或合成图。截图前用客户端本地搜索隐藏历史标题；未复制用户历史清单。中心为空工作台、右栏为上下文页面，未伪造会话生成结果。

| 主题 | 归档路径 | 画布中央背景 RGB |
| --- | --- | --- |
| Claude Code Dark | `F:\插件-Gemini\tests\screenshots\claude-code-dark.png` | 22, 21, 19 |
| Claude Code Light | `F:\插件-Gemini\tests\screenshots\claude-code-light.png` | 247, 244, 237 |
| Ubuntu Aubergine | `F:\插件-Gemini\tests\screenshots\ubuntu-aubergine.png` | 36, 7, 27 |
| macOS Dark | `F:\插件-Gemini\tests\screenshots\macos-dark.png` | 27, 28, 32 |
| macOS Light | `F:\插件-Gemini\tests\screenshots\macos-light.png` | 245, 245, 247 |
| Solarized Dark | `F:\插件-Gemini\tests\screenshots\solarized-dark.png` | 0, 42, 54 |

六图均为 **1429×954**，图像内容各异，路径与图像格式已程序复核，现场图像逐一目视检查。完整元数据见 `tests/screenshots/manifest.json`。原始截图接口返回 JPEG，保留于 `tests/screenshots/raw/`；PNG 仅作编码转换，没有缩放、裁剪或修饰。原生窗口观察发生在最后编号审批修复之前，因此该修复的证据来自最终组件回归与生产重构建，截图不单独证明审批修复。

原生窗口只做初始化/列表/只读历史展示与主题设置，没有真实提示、登录、账号切换、插件安装或外部 API 调用。专属测试资料目录为 `tests/artifacts/gravity-v02-qa`，应排除发行内容；截图后用窗口正常关闭操作退出，所属 Electron 主 PID 44652 已不存在。

## 缺陷闭环

| 本阶段真实发现 | 修复者与回归 |
| --- | --- |
| Infinity/NaN 费用非有限；空文件出现幽灵删除；401 行相同文件误报全量变化 | @lead 修复；共享两套 116 用例通过，另含 1 万行仅改一行精确 +1/-1。 |
| 历史导入漏读活跃 WAL 新提交行、未映射真实 source/type/created_at | @backend 修复；8 项导入器与 2 项 Core 整合通过。 |
| 同窗格多个审批组件同时注册数字键，按一次 1 对两个请求都放行 | @frontend 以视觉顺序选唯一快捷键主请求；原始失败用例现只调用一次，最终全套 281 项通过。 |

## 明确未验边界

- 真实订阅的 2–4 会话生成、真实限流、官方 token 细分与官方压缩没有本次实机交互证据；协议并发与错误行为使用高保真桩和注入。
- 没有独立公开 API Key 或真实本地模型调用；HTTP 500/超时及 AI 结论来自替身。默认思考汉化为带来源标记的术语辅助，未覆盖英文仍保留原文，不宣称任意思考完整汉化或外部复审质量。
- Mode 取决于官方运行时能力声明；Effort 是本地指导。成本为估算，并非官方账单；时间聚合使用 UTC 与当前实现的回合开始归桶口径。
- Plugins/MCP 真实安装、卸载、列表兼容与真实账号登录/退出/手动切换均未执行；管理命令作用于官方默认配置，不声称随 ACP profile 自动隔离。Skills 为客户端启用偏好，不伪称已注入官方运行时。
- 合成只读历史的完整源树验证不等于对用户整个真实官方资料目录做逐文件法证审计；测试没有读取真实私有凭据。
- Windows worker 在主进程崩溃或硬杀后的回收未做实机验证；已验证正常关闭及测试桩回收。
- 没有 MSI/EXE 安装、签名、升级、卸载或跨机器分发验收；`dist/` 成功不等于安装包验收。

上述边界需随交付说明保留。最终是否向用户收敛由 @lead 根据双门禁与阶段范围判断。
