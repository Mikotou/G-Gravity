/**
 * 主进程与渲染进程共用的导出入口。
 * 协议载荷在各自的契约文件中定义，调用方可以从这里导入同一种类型和校验函数。
 */

export * from './acp-protocol';
export * from './approval-contract';
export * from './telemetry-contract';
export * from './swarm-contract';
export * from './session-contract';
export * from './theme-i18n-contract';
export * from './plugins-contract';
export * from './accounts-history-contract';
export * from './ipc-channels';

export * from './user-question';
