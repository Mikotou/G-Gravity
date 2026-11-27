import { readBoundedText } from '../llm/bounded-response';
import type { VoiceOwner } from '../../shared/session-owner';
import { normalizeOpenAiCompatibleV1Base } from '../../shared/approval-contract';
import { hasExternalVoiceSettings, VOICE_MAX_PCM_BYTES, type ExternalVoiceProviderConfig,
  type VoiceDiscoverModelsResult, type VoiceLocale } from '../../shared/voice-contract';
import { OriginCircuitBreaker, withModelDeadline } from '../llm/external-llm-transport';
import { maskKnownSecret } from '../security/redaction';
import type { VoiceLedger } from './voice-ledger';

export const voiceCircuit = new OriginCircuitBreaker();
export function cooldown(endpoint: string) {
  const remaining = voiceCircuit.remaining(endpoint);
  if (!remaining) return {};
  return { cooldownUntil: new Date(Date.now() + remaining).toISOString(),
    cooldownKind: voiceCircuit.cooldownStatus(endpoint) === 403 ? 'permission_403' as const : 'rate_limit_429' as const };
}
export function wave(pcm: Uint8Array): Buffer<ArrayBuffer> {
  if (!pcm.length || pcm.length % 2 || pcm.length > VOICE_MAX_PCM_BYTES) throw Error('音频长度无效');
  const wav = Buffer.alloc(44 + pcm.length);
  wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(16_000, 24); wav.writeUInt32LE(32_000, 28); wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(pcm.length, 40);
  wav.set(pcm, 44);
  return wav;
}
function validate(c: ExternalVoiceProviderConfig): URL {
  if (!hasExternalVoiceSettings(c)) throw Error('语音服务地址、模型或密钥无效');
  const url = new URL(c.endpoint);
  if (c.provider === 'gemini-api-key' && (url.origin !== 'https://generativelanguage.googleapis.com' ||
      !/^\/?$/.test(url.pathname) || !/^[\w.-]+$/.test(c.model))) throw Error('Gemini Developer API 地址或模型无效');
  if (voiceCircuit.remaining(c.endpoint)) throw Error('语音服务正在冷却');
  return url;
}
export class VoiceHttpError extends Error {
  constructor(readonly status: number) { super('语音服务 HTTP ' + status); }
}
export class ExternalVoice {
  constructor(private ledger: VoiceLedger, private fetcher: typeof fetch = fetch) {}
  private async request(c: ExternalVoiceProviderConfig, path: string, init: RequestInit, signal: AbortSignal) {
    signal.throwIfAborted();
    const response = await this.fetcher(path, { ...init, signal, redirect: 'error' });
    if (!response.ok) {
      if (response.status === 403 || response.status === 429) voiceCircuit.fail(c.endpoint, response.status);
      void response.body?.cancel().catch(() => {});
      throw new VoiceHttpError(response.status);
    }
    return JSON.parse(await readBoundedText(response, 2 * 1024 * 1024, signal));
  }
  async discover(c: ExternalVoiceProviderConfig, parent: AbortSignal): Promise<VoiceDiscoverModelsResult> {
    const endpoint = validate(c);
    const google = c.provider === 'gemini-api-key';
    const headers: Record<string, string> = {};
    if (c.apiKey) headers[google ? 'x-goog-api-key' : 'authorization'] = google ? c.apiKey : 'Bearer ' + c.apiKey;
    const path = google ? endpoint.origin + '/v1beta/models?pageSize=200' : normalizeOpenAiCompatibleV1Base(endpoint) + '/models';
    const data = await withModelDeadline(c.timeoutMs, '语音模型列表', parent, signal => this.request(c, path, { headers }, signal));
    const rows: unknown = google ? data.models : data.data;
    if (!Array.isArray(rows)) throw Error('语音模型列表无效');
    const models = rows.flatMap(row => {
      const id = String((google ? row?.name : row?.id) ?? '').replace(/^models\//, '');
      if (!/^[\w.:/-]{1,120}$/.test(id) || (c.apiKey && id.includes(c.apiKey))) return [];
      if (google && row.supportedGenerationMethods && !row.supportedGenerationMethods.includes('generateContent')) return [];
      return [{ id, displayName: id, supportsThinking: false, supportedThinkingLevels: [] }];
    });
    return { provider: c.provider, endpoint: c.endpoint, models, fetchedAt: new Date().toISOString() };
  }

  async transcribe(c: ExternalVoiceProviderConfig, pcm: Uint8Array, locale: VoiceLocale, parent: AbortSignal, owner: VoiceOwner, scope: 'dictation' | 'connection-test') {
    const endpoint = validate(c);
    const wav = wave(pcm);
    const google = c.provider === 'gemini-api-key';
    const path = google ? endpoint.origin + '/v1beta/models/' + encodeURIComponent(c.model) + ':generateContent' :
      normalizeOpenAiCompatibleV1Base(endpoint) + '/audio/transcriptions';
    const headers: Record<string, string> = {};
    let body: FormData | string;
    if (google) {
      headers['content-type'] = 'application/json';
      headers['x-goog-api-key'] = c.apiKey!;
      body = JSON.stringify({ contents: [{ parts: [{ text: 'Transcribe this audio verbatim in its original language. Return only the transcript.' },
        { inlineData: { mimeType: 'audio/wav', data: wav.toString('base64') } }] }] });
    } else {
      if (c.apiKey) headers.authorization = 'Bearer ' + c.apiKey;
      body = new FormData();
      body.append('model', c.model);
      if (locale !== 'auto') body.append('language', locale === 'zh-CN' ? 'zh' : 'en');
      body.append('file', new Blob([wav], { type: 'audio/wav' }), 'capture.wav');
    }
    parent.throwIfAborted();
    const requestId = this.ledger.begin(c, pcm.length / 32, owner, scope);
    let completed = false, direct: number | undefined;
    try {
      const result = await withModelDeadline(c.timeoutMs, '语音转写', parent, signal => this.request(c, path, { method: 'POST', headers, body }, signal));
      const rawCost = result.usage?.cost ?? result.usage?.total_cost ?? result.usageMetadata?.costUsd ?? result.costUsd ?? result.cost;
      if (typeof rawCost === 'number' && Number.isFinite(rawCost) && rawCost >= 0) direct = rawCost;
      const text = google ? result.candidates?.[0]?.content?.parts?.filter((p: { thought?: boolean }) => !p.thought)
        .map((p: { text?: string }) => p.text ?? '').join('') : result.text;
      if (typeof text !== 'string' || !text.trim()) throw Error('语音服务没有返回转写文本');
      completed = true;
      return c.apiKey ? maskKnownSecret(text.trim(), c.apiKey, '[已隐藏]') : text.trim();
    } catch (error) {
      if (error instanceof VoiceHttpError) throw error;
      throw Error(parent.aborted ? '语音转写已取消' : '语音服务无响应或转写失败');
    } finally {
      this.ledger.complete(requestId, completed ? 'completed' : parent.aborted ? 'aborted' : 'error', direct);
    }
  }
}
