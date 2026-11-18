// @vitest-environment node
import { expect, it } from 'vitest';
import { StdioRpc } from './helpers/stdio-rpc';

/** 显式选择才运行；仅初始化，不建会话、不发提示、不读取官方凭据。 */
it.skipIf(!process.env.AGY_OFFICIAL_SMOKE)('本机原版 agy acp initialize 冒烟', async () => {
  const rpc = new StdioRpc(process.env.AGY_BINARY || 'agy', ['acp']);
  try {
    const result = await rpc.request('initialize', {
      protocolVersion: 1, clientCapabilities: {},
      clientInfo: { name: 'agy-studio-qa-probe', version: '0.1.0' },
    }, 10000);
    expect(result.protocolVersion).toBe(1);
    expect(result.agentInfo.name).toBeTruthy();
    expect(result.agentCapabilities).toBeTypeOf('object');
    console.info('OFFICIAL_ACP_INITIALIZE', JSON.stringify(result));
  } finally { await rpc.close(); }
}, 15000);
