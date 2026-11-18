import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import type { AccountProfile, AccountsStateSnapshot, CreateAccountProfileInput } from '../../shared/accounts-history-contract';
import { ClientStore } from '../storage/client-store';
import { AcpClient } from '../acp/acp-client';
import { SessionMultiplexer } from '../session/session-multiplexer';

export interface AccountManagerOptions { store: ClientStore; client: AcpClient; sessions: SessionMultiplexer; beforeSwitch?: () => void | Promise<void>; afterSwitch?: (profileId: string) => void | Promise<void> }
/** 只保存客户端 Profile 元数据，从不读取隔离目录内由官方 CLI 管理的凭据。 */
export class AccountManager extends EventEmitter {
  private profiles: AccountProfile[];
  activeProfileId = 'default';
  private transitioning = false;
  constructor(private options: AccountManagerOptions) {
    super(); const now = new Date().toISOString();
    const saved = options.store.read<{ activeProfileId?: string; profiles?: AccountProfile[] }>('profiles.json', {});
    // 隔离目录由当前数据根和验证过的 Profile ID 推导，旧配置里的绝对路径不参与定位。
    const valid = (Array.isArray(saved?.profiles) ? saved.profiles : []).filter(item => item && /^profile-[a-f0-9-]{36}$/.test(item.profileId));
    this.profiles = [{ profileId: 'default', name: 'Default', isDefault: true, createdAt: now, lastActivatedAt: now }, ...valid.map(item => ({ ...item, isDefault: false, isolatedAppDataDir: join(options.store.dataDir, 'profiles', item.profileId) }))];
    if (this.profiles.some(item => item.profileId === saved?.activeProfileId)) this.activeProfileId = saved.activeProfileId!;
    if (options.sessions.profileId !== this.activeProfileId) options.sessions.setProfile(this.activeProfileId);
    this.applyArgs();
  }
  get busy(): boolean { return this.transitioning; }
  assertReady(): void { if (this.transitioning) throw new Error('Profile 正在切换或登录，请稍候'); }
  getState(): AccountsStateSnapshot {
    const info = this.options.client.initializeResult;
    return { activeProfileId: this.activeProfileId, profiles: structuredClone(this.profiles), acpIdentity: { connected: this.options.client.connected, agentName: info?.agentInfo?.name, agentVersion: info?.agentInfo?.version, authMethods: structuredClone(info?.authMethods || []), supportsLogout: !!info?.agentCapabilities.auth?.logout } };
  }
  private publish(): AccountsStateSnapshot { this.options.store.write('profiles.json', { activeProfileId: this.activeProfileId, profiles: this.profiles }); const state = this.getState(); this.emit('updated', state); return state; }
  /** 每次按当前选择重建 ACP 参数。先剔除上一个 Profile 的目录和交互登录标志，再附加新的隔离目录。 */
  applyArgs(): void {
    const original = this.options.client.options.args || ['acp'];
    const args: string[] = [];
    for (let index = 0; index < original.length; index++) {
      if (original[index] === '--app-data-dir') { index++; continue; }
      if (!original[index].startsWith('--app-data-dir=') && original[index] !== '--login') args.push(original[index]);
    }
    const profile = this.profiles.find(item => item.profileId === this.activeProfileId)!;
    if (!profile.isDefault) args.push('--app-data-dir', profile.isolatedAppDataDir!);
    this.options.client.options.args = args;
  }
  createProfile(input: CreateAccountProfileInput): AccountsStateSnapshot {
    this.assertReady(); if (!input?.name?.trim() || input.name.length > 80) throw new Error('Profile 名称应为 1 至 80 个字符');
    const profileId = `profile-${randomUUID()}`; const now = new Date().toISOString();
    const isolatedAppDataDir = join(this.options.store.dataDir, 'profiles', profileId);
    mkdirSync(isolatedAppDataDir, { recursive: true, mode: 0o700 });
    this.profiles.push({ profileId, name: input.name.trim(), isDefault: false, isolatedAppDataDir, createdAt: now, lastActivatedAt: now }); return this.publish();
  }
  deleteProfile(profileId: string): AccountsStateSnapshot {
    this.assertReady(); if (profileId === 'default' || profileId === this.activeProfileId) throw new Error('不能删除默认或当前活动 Profile');
    if (!this.profiles.some(profile => profile.profileId === profileId)) throw new Error('Profile 不存在');
    // 仅移除客户端条目，不操作官方 CLI 管理的目录及其中凭据。
    this.profiles = this.profiles.filter(profile => profile.profileId !== profileId); return this.publish();
  }
  private async disconnect(): Promise<void> {
    await this.options.beforeSwitch?.();
    for (const session of this.options.sessions.sessions.values()) if (this.options.sessions.isActive(session.sessionId)) {
      try { await this.options.sessions.closeSession(session.sessionId); } catch { /* stop 将统一释放连接 */ }
    }
    await this.options.client.stop();
  }
  /** 切换期间锁住其他账号操作。先收起旧会话，再载入新 Profile 的本地数据并重新握手。 */
  async switchProfile(profileId: string): Promise<AccountsStateSnapshot> {
    this.assertReady(); const target = this.profiles.find(item => item.profileId === profileId); if (!target) throw new Error('Profile 不存在');
    if (profileId === this.activeProfileId) return this.getState();
    this.transitioning = true;
    try {
      await this.disconnect(); this.options.sessions.setProfile(profileId); this.activeProfileId = profileId; target.lastActivatedAt = new Date().toISOString(); this.applyArgs();
      await this.options.afterSwitch?.(profileId); this.publish();
      // 新选择已经保存。握手失败也要发布该 Profile 的断开状态，让界面能显示实际结果。
      try { await this.options.client.start(); } catch (error) { this.publish(); throw error; }
      return this.publish();
    } finally { this.transitioning = false; }
  }
  async login(profileId = this.activeProfileId) {
    if (profileId !== this.activeProfileId) await this.switchProfile(profileId);
    this.assertReady(); this.transitioning = true;
    try { await this.disconnect(); const result = await this.options.client.launchOfficialLogin(); this.publish(); return result; }
    finally { this.transitioning = false; }
  }
  async logout(): Promise<{ loggedOut: boolean; message: string }> {
    this.assertReady(); this.transitioning = true;
    try {
      if (!this.options.client.initializeResult?.agentCapabilities.auth?.logout) throw new Error('官方 ACP 未声明 auth/logout；请通过官方 CLI 处理登出');
      await this.options.beforeSwitch?.();
      for (const session of this.options.sessions.sessions.values()) if (this.options.sessions.isActive(session.sessionId)) await this.options.sessions.closeSession(session.sessionId);
      await this.options.client.request('auth/logout', {}); await this.options.client.stop(); this.publish();
      return { loggedOut: true, message: '已通过官方 ACP 登出' };
    } finally { this.transitioning = false; }
  }
}
