# Phase 1 后端与前端基础测试记录

执行日期：2026-11-17；测试负责人：@tester。

结论：当前已送审后端在下述 Mock/单元范围验证通过；完整客户端 QA_PASS 尚未签发。完整构建的渲染入口、主界面组件交互和可见 Electron 实机窗口仍待前端交接后验证。

## 最新真实执行

- `npm test`：9 个测试文件通过，155 项用例通过，1 项官方 CLI 冒烟默认跳过；退出码 0。
- `npx tsc --noEmit -p tsconfig.json`：包含所有测试代码，退出码 0。
- `npm run typecheck`：shared/main/renderer 均退出码 0。
- `npm run build`：main 编译通过；renderer 尚未送审，缺少 `src/renderer/main.tsx`，Vite 报 `Failed to resolve /src/renderer/main.tsx from F:/插件-Gemini/index.html`。
- 官方初始化探针此前已单独显式运行通过，记录见 QA-phase1-preparation.md。没有真实订阅提示生成、登录操作或真实外部 API Key 请求。

## 测试覆盖

| 文件 | 用例数 | 关键证据 |
| --- | ---: | --- |
| shared-contracts.test.ts | 57 | 路径规范化、污染标题与正常会话区分、标题结构、3 深 3 浅主题契约、工具双语、IPC 常量与危险参数 |
| mock-acp.test.ts | 5 | 测试桩真实子进程的双向 JSON-RPC、自身四会话流、权限挂起、取消隔离、恢复、关闭及 EOF 回收 |
| acp-host.test.ts | 18 | 实际宿主单 spawn 四会话、第五槽位拦截、权限不阻塞其他会话、不额外启动审批 CLI、取消关闭恢复、停止回收与参数白名单 |
| approval-engine.test.ts | 32 | hybrid/rules-only 快筛、危险/敏感样本、前缀会话和工作区隔离、允许一次不缓存、四种审批动作、关闭/500/超时 Fail-Closed、审计写失败安全取消、配置变更时旧 AI 批准作废、独立网络地址限制 |
| backend-state.test.ts | 17 | 中英混合思考流、跨分片原文保留、异步翻译竞态、空历史与 364 天聚合、速率归零、大附件/会话隔离、官方 usage 幂等、估算与价格来源标记、历史重载、蜂群成功事件/去重/brief/动作/完成摘要、标题持久化 |
| core-service.test.ts | 6 | 实际 CoreService 完整四会话流、内联审批桥接、前缀复用、拒绝反馈同会话一次后续提示、规则及 AI 审批、API Key 不落盘、取消权限、未声明 compact 能力时拒绝、偏好/布局/标题与附件检查 |
| security-baseline.test.ts | 5 | IPC 主窗口主 frame 来源与 URL 校验、参数大小/数量、订阅卸载、真实编译 preload 仅 require Electron、冻结桥接与取消订阅、私有端点/凭据路径静态守卫、主窗口隔离设置 |
| frontend-foundation.test.tsx | 9 | 六套主题实际写入 CSS 变量、系统主题监听卸载、中英语言包键完整、中文无整条遗漏翻译的英文标签（产品名和单位除外）、Provider 语言热切 |
| acp-boundaries.test.ts | 6 | UTF-8 每字节切分、粘连消息、坏 JSON 恢复、未声明文件读取请求返回 -32601、超大消息断连、ACP/API 403/429 冷却和冷却期间零重复请求 |

本地 `pwd` 快筛 100 次热态采样 P95 在最近一轮分别为 hybrid 0.0028ms、rules-only 0.0020ms。该数据仅代表当前机器及此单一命令，不外推复杂语义或网络复核延迟。

## 已发现并由作者修复的缺陷

ThoughtTranslator 清除块后复用同一 ID，旧异步翻译 revision 碰撞导致旧译文覆盖新块。已用确定性挂起 Promise 复现并定向反馈 @backend；作者将 revision 改为实例单调递增，原失败用例回归通过。测试成员未修改业务源码。

`outputTokens` 使用权威总输出语义，`thoughtTokens` 不再次累加计费；目前没有真实官方 usage 样本证明更细计费口径。上下文仍为估算，使用 `mixed` 来源标记，不视为官方精确账单。

## 整体验收剩余边界

- 等待前端主界面交接后运行完整 build、Request View 四按钮/Shift+Tab、看板展开、标题整理、蜂群面板及主界面中文覆盖度。
- 可见 Electron 实机启动、完整 preload/IPC 渲染链路和窗口可见性。
- 真实官方多会话提示生成、真实 API Key 复核、官方压缩和 Windows 官方 worker 子树清理均未执行，不能由 Mock 结果推断。
- 思考流默认本地术语辅助翻译保留未覆盖原文；后端明确标记局限，外部完整翻译目前仅构造注入。不能据此声称全部英文思考已完整汉化或具备设置页开关。
- 静态守卫只是回归检查；不替代 @compliance 的独立代码和条款审查，也不构成法律或账号风险保证。
