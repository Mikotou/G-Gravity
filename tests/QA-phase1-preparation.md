# Phase 1 测试准备与局部验证记录

执行日期：2026-11-17；测试负责人：@tester。

本记录不签发完整 QA_PASS。前端、完整审批引擎、遥测与蜂群状态机尚待作者送审；业务端源码未由测试成员修改。

## 已真实运行

- `npm test`：3 个测试文件通过，80 个用例通过；官方 CLI 冒烟在默认套件中显式跳过。
- `$env:AGY_OFFICIAL_SMOKE='1'; npm test -- tests/official-acp-smoke.test.ts`：1 个官方 CLI 初始化用例通过。
- `npx tsc --noEmit -p tsconfig.json`：退出码 0，包含测试代码的全工程类型检查通过（仅代表当时已有源码）。
- `agy acp --help`：退出码 0，确认本机官方命令支持 stdio 与 process-per-session 选项。

## 覆盖范围

| 测试文件 | 用例数 | 已验证行为 |
| --- | ---: | --- |
| shared-contracts.test.ts | 57 | URL 编码与 Windows/POSIX 路径规范化及幂等、污染标题识别与正常标题保留、标题分类与结构保留、3 深 3 浅主题色板完整性、工具双语标签、IPC 通道唯一性、危险参数常量 |
| mock-acp.test.ts | 5 | 标准 JSON-RPC 初始化和错误、真实单子进程四会话交错流、权限请求双向应答前挂起、单会话取消隔离、恢复和关闭、EOF 退出 |
| acp-host.test.ts | 18 | 实际 AcpClient 与 SessionMultiplexer 通过可注入 spawn 连接桩子进程；并发四会话仅一次 spawn、第五槽位拦截、权限挂起时其他会话继续、审批应答不新增进程、单会话取消、关闭与恢复、停止宿主后所属桩 PID 退出、危险参数及未批准参数阻断 |
| official-acp-smoke.test.ts | 1 | 本机原版 agy acp initialize，未创建会话、未发送提示、未读取官方私有文件 |

官方初始化实际返回：`agentInfo.name = Antigravity ACP Server`，`agentInfo.version = 1.5.10`，`protocolVersion = 1`；能力包含 `sessionCapabilities.list/resume/close/load`、`loadSession` 及 `_meta.antigravity.systemPrompt.append`。

## 后续接入方式

`tests/helpers/mock-acp-server.ts` 是独立 stdio 服务源文件；`prepareMockAcp()` 将自有测试桩编译至隔离临时目录，返回 `executable`、`args` 和 `cleanup()`。宿主测试通过 `AcpClientOptions.spawn` 注入，生产参数白名单不需要为测试放宽。

提示包含 `[swarm]` 时发出 swarm 与 post_message 工具更新；包含 `[permission]` 时发起权限请求并挂起，后面的文字作为命令摘要；包含 `[slow]` 时延迟分片，供取消隔离测试使用。桩只传递命令文本，不执行命令或访问外部网络。关闭会话仅解除加载，保留可恢复的历史信息。

## 尚未验证

- 真实官方 CLI 的 2–4 会话生成、订阅鉴权状态、实机取消与 worker 进程树回收。
- 审批确定性快筛延迟、高危样本、前缀缓存、审计落盘与外部复审 500/超时回退。
- 完整思考流汉化质量、上下文费用/速率/热力图、标题持久化与蜂群拓扑还原。
- 前端六套主题切换、双语切换、Request View 四分支、Shift+Tab、中文覆盖度和实际可见 Electron 窗口。
- 最终 `npm run typecheck` 与 `npm run build`；完整工程送审后再运行双门禁验收。
