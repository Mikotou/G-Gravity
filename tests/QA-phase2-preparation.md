# Gravity v0.2 首轮测试准备记录

当前为建设期局部验证，尚不签发 v0.2 QA_PASS。仅写入 tests/，未修改业务源码、共享契约、根配置或图标资产。

## 已真实运行

- `npm test -- tests/shared-contracts.test.ts tests/shared-v02.test.ts`：112 passed / 3 failed。包含51项迁移后的既有契约和64项v0.2新增契约。三个失败已定向反馈共享目录所有者 @lead。
- `npm test -- tests/accounts-v02.test.ts tests/mock-acp.test.ts tests/acp-host.test.ts`：28 passed。账号5项涵盖官方隔离参数、手动切换、默认配置恢复、429/403不轮换、不新建连接、不触发登录、只删除客户端账号条目、登录参数及ACP auth/logout。
- 图标：六变体 × SVG/PNG/ICO × assets/public双目录，共36文件存在；SVG根/安全性、PNG签名/IHDR尺寸、ICO签名验证通过，对应副本字节一致。

## 首轮契约失败（已由 @lead 修复并真实回归）

1. calculateTokenCost 对 Infinity 计数或 NaN 价格输出非有限费用。要求拒绝无效值或清理为有限值。
2. computeUnifiedLineDiff('', 'hello') 将不存在的空文件内容算作一行删除；实际新建文件应仅新增1行。
3. 401行完全相同内容触发长文件fallback，误报401行新增和401行删除；应为零变更。

最新复核：`npm test -- tests/shared-contracts.test.ts tests/shared-v02.test.ts` 为 **116/116 通过**。新增一万行文件仅修改中间一行仍精确 +1/-1，Diff 内容可重建修改前后文本。上述三个首轮失败均已解除。

账号/Mock/宿主28项通过；追加Mode/Model/Effort隔离1项及只读SQLite测试基础设施自检1项通过。测试端CoreBridge已补齐v0.2方法与Inspector/History/Account事件适配，后续送审时严格验证实际内核存在这些方法。

## 已准备后续强验证基础设施

- tests/helpers/history-fixture.ts：只在临时目录构造合成的 antigravity/brain/<id>/.system_generated/logs/transcript.jsonl、conversation_summaries.db 和5种敏感诱饵；不枚举真实用户官方目录。
- 源树快照包含每个文件与目录的条目、内容指纹、字节大小、mtime/ctime和mode；排除纯读取可能更新的atime。业务导入前后要求全等，能够发现新增WAL/SHM/日志及目录改动。
- 测试桩新增Mode/Model设置、官方登出与合成429/403错误请求，仍仅收发stdio、不执行命令或访问网络。
- 后续需接入业务历史导入器的读取监控，强断言敏感诱饵零读取与源树零写入；测试基建自检不能替代业务验证。

## 仍待模块交接

v0.2前端主界面、自定义主题工坊、Inspector六页、Plugins/MCP/Skills与历史续聊业务、24/168/30三档数据、四维费用聚合，以及真实生产窗口六主题PNG归档。旧v0.1断言需按v0.2契约逐项迁移，不能把预期UI/字段变化当业务回归缺陷，也不能直接沿用171项旧结论作为v0.2验收。

## 首批业务模块实际验证补充

- Plugins/MCP/Skills 13项通过：仅显式操作才执行CLI、全部shell:false、管理命令互斥、插件target拦截、MCP --分隔、Skill仅写客户端偏好且源文件不变。
- Telemetry v0.2 6项通过：24/168/30维度、官方input/output总量拆分cached/thought子集避免重复定价、费用精度、分模型占比、单价修改持久化、UTC时间边界、大附件及增量速率。
- 迁移后的backend-state/core-service/security-baseline共28项通过，包含原有审批闭环与新版冻结桥接、IPC/preload守卫。
- History导入当前6项中4通过、2待修复：普通JSONL+SQLite确实导入，五类诱饵零readFile，导入前后源树内容/文件和目录项/mtime/ctime/mode全等；并发扫描、watch启停、超限文件与缓存目录隔离通过。尚缺真实source/type/created_at transcript格式映射及活跃WAL中已提交新行导入，均已定向反馈后端。
- 根据lead追加契约，允许只读conversation_summaries.db-wal，但仍不读源-shm且禁止源目录任何写入。测试已从“跳过WAL”升级为实际SQLite WAL源库+wal+shm完整快照不变断言。
- workspace-inspector-v02 4项与core-v02 2项通过：安全相对路径补全与文本引用、路径穿越/敏感/二进制/超限拒绝、Diff/Plan/Terminal衍生状态与会话隔离、冻结桥接方法存在、自定义主题安全导出导入、图标和布局设置，以及只读历史续聊新建标准ACP会话带入摘要且源树不变。
- 前端foundation 9项已按v0.2术语混排策略迁移通过：4深/2浅六主题、跟随系统监听、语言包键完整、说明/错误中文与术语英文保留、Provider语言切换。当前前端主App仍在重构，未把其过渡类型错误作为已送审缺陷。
- 本机原版agy mcp add --help已确认--type stdio/http、--env、flags须在name前、--在command前；plugin --help明确支持plugin[@marketplace]。没有执行真实安装或MCP配置修改，管理功能的运行验证仍为Mock命令边界。

## 最新历史修复回归（覆盖前文待修状态）

`npm test -- tests/history-import-v02.test.ts tests/core-v02.test.ts` 实跑 **10/10通过**：历史导入已扩展8项，Core整合2项。此前WAL新行与真实source/type/created_at格式失败均已解除。

新增证据包括：真实SQLite WAL连接保持打开，WAL内新提交摘要可被导入；源db/wal/shm的内容与元数据全等，源-shm未被readFile读取；无旁路WAL文件时仅规范化客户端副本头部，源DB头部保持2；真实fs.watch在测试主动修改合成JSONL后触发防抖更新，业务刷新本身未改源树。普通JSONL/SQLite与敏感诱饵零读取断言继续通过。测试始终只使用临时合成历史，不扫描用户真实官方目录。
