// @vitest-environment node
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { afterEach, describe, expect, it } from 'vitest';
import { ClientStore } from '../src/main/storage/client-store';
import { OriginCircuitBreaker } from '../src/main/llm/external-llm-transport';
import { SwarmArchive } from '../src/main/swarm/swarm-archive';
import { TelemetryStore } from '../src/main/telemetry/telemetry-store';

const tempDirs: string[] = [];
const telemetryStores: TelemetryStore[] = [];
const archives: SwarmArchive[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const t of telemetryStores.splice(0)) t.dispose();
  for (const a of archives.splice(0)) a.close();
  for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 5 });
});

function listMainTsFiles(rootDir: string): string[] {
  const results: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
        results.push(full);
      }
    }
  };
  walk(rootDir);
  return results.sort();
}

function countLines(filePath: string): number {
  const content = readFileSync(filePath, 'utf8').replace(/\r\n/g, '\n');
  if (!content) return 0;
  return content.replace(/\n$/, '').split('\n').length;
}

function resolveRelativeTsImport(fromFile: string, specifier: string, mainRoot: string): string | null {
  if (!specifier.startsWith('.')) return null;
  const base = path.resolve(path.dirname(fromFile), specifier);
  const candidates = [base, `${base}.ts`, path.join(base, 'index.ts')];
  for (const candidate of candidates) {
    if (existsSync(candidate) && candidate.endsWith('.ts') && !candidate.endsWith('.d.ts')) {
      const rel = path.relative(mainRoot, candidate);
      if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
        return rel.replace(/\\/g, '/');
      }
    }
  }
  return null;
}

function extractRelativeSpecifiers(filePath: string): string[] {
  const source = readFileSync(filePath, 'utf8');
  const ast = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true);
  const specs: string[] = [];
  const visit = (node: ts.Node) => {
    // Includes BOTH value `import` and `import type`
    if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
      specs.push(node.moduleSpecifier.text);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
      specs.push(node.moduleSpecifier.text);
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      specs.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  return specs;
}

/** Tarjan strongly connected components to detect all circular dependencies (including self-loops). */
function findDependencyCycles(graph: Map<string, string[]>): string[][] {
  let index = 0;
  const indices = new Map<string, number>();
  const lowlink = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const cycles: string[][] = [];

  const strongConnect = (v: string) => {
    indices.set(v, index);
    lowlink.set(v, index);
    index += 1;
    stack.push(v);
    onStack.add(v);

    for (const w of graph.get(v) || []) {
      if (!indices.has(w)) {
        strongConnect(w);
        lowlink.set(v, Math.min(lowlink.get(v)!, lowlink.get(w)!));
      } else if (onStack.has(w)) {
        lowlink.set(v, Math.min(lowlink.get(v)!, indices.get(w)!));
      }
    }

    if (lowlink.get(v) === indices.get(v)) {
      const scc: string[] = [];
      let w: string;
      do {
        w = stack.pop()!;
        onStack.delete(w);
        scc.push(w);
      } while (w !== v);
      if (scc.length > 1 || (scc.length === 1 && (graph.get(v) || []).includes(v))) {
        cycles.push(scc.sort());
      }
    }
  };

  for (const node of graph.keys()) {
    if (!indices.has(node)) strongConnect(node);
  }
  return cycles;
}

async function importOptionalMainModule(relPath: string): Promise<Record<string, unknown>> {
  const absPath = path.resolve(process.cwd(), relPath);
  expect(existsSync(absPath), `共享基础设施模块缺失：${relPath}`).toBe(true);
  const url = pathToFileURL(absPath).href;
  return (await import(/* @vite-ignore */ url)) as Record<string, unknown>;
}

/* ============================================================================
 * 1. Backend DAG Zero-Cycle & File-Scale Architecture Guards
 * ========================================================================== */

describe('v0.3.3 后端架构守卫：零循环依赖、单文件规模与废弃文件清理', () => {
  it('AST 静态扫描 src/main/**/*.ts（含 import 与 import type）：0 循环依赖', () => {
    const mainRoot = path.resolve(process.cwd(), 'src', 'main');
    const files = listMainTsFiles(mainRoot);
    expect(files.length).toBeGreaterThan(20);

    const graph = new Map<string, string[]>();
    for (const file of files) {
      const fromKey = path.relative(mainRoot, file).replace(/\\/g, '/');
      const targets = new Set<string>();
      for (const spec of extractRelativeSpecifiers(file)) {
        const resolved = resolveRelativeTsImport(file, spec, mainRoot);
        if (resolved) targets.add(resolved);
      }
      graph.set(fromKey, [...targets].sort());
    }

    const cycles = findDependencyCycles(graph);
    expect(
      cycles.map((c) => c.join(' <-> ')),
      'src/main/**/*.ts 不得存在任何循环依赖（包括 import type）'
    ).toEqual([]);
  });

  it('文件规模守卫：src/main/**/*.ts 任意单文件 <= 650 LOC、core-service.ts <= 420 LOC、index.ts <= 160 LOC', () => {
    const mainRoot = path.resolve(process.cwd(), 'src', 'main');
    const files = listMainTsFiles(mainRoot);
    const oversized: string[] = [];

    for (const file of files) {
      const loc = countLines(file);
      const rel = path.relative(process.cwd(), file).replace(/\\/g, '/');
      if (loc > 650) oversized.push(`${rel} (${loc} LOC > 650)`);
    }

    expect(oversized, '存在超过 650 LOC 的后端单文件').toEqual([]);
    expect(countLines(path.join(mainRoot, 'core-service.ts')), 'src/main/core-service.ts 应 <= 420 LOC').toBeLessThanOrEqual(420);
    expect(countLines(path.join(mainRoot, 'index.ts')), 'src/main/index.ts 应 <= 160 LOC').toBeLessThanOrEqual(160);
  });

  it('D1-B 与统一脱敏清理守卫：history-importer.ts 与 reviewer-redaction.ts 已彻底删除', () => {
    expect(existsSync(path.resolve(process.cwd(), 'src/main/history/history-importer.ts'))).toBe(false);
    expect(existsSync(path.resolve(process.cwd(), 'src/main/approval/reviewer-redaction.ts'))).toBe(false);
  });
});

/* ============================================================================
 * 2. Four Shared Backend Infrastructure Modules Existence & Availability
 * ========================================================================== */

describe('v0.3.3 后端 4 套共享基础设施存在性与可用性校验', () => {
  it('1) src/main/llm/external-llm-transport.ts 存在且导出可用 OriginCircuitBreaker（QA-03 强类型直调）', async () => {
    const mod = await importOptionalMainModule('src/main/llm/external-llm-transport.ts');
    expect(mod.OriginCircuitBreaker).toBe(OriginCircuitBreaker);

    const origin = 'https://api.example-v033-breaker.test/v1/chat/completions';
    const t0 = Date.UTC(2026, 10, 26, 12, 0, 0);

    // 复核器策略（tripOn401: false）：403 熔断 300s、429 熔断 60s、reset 生效、单次 401 不触发长熔断
    const reviewerBreaker = new OriginCircuitBreaker({ tripOn401: false });
    expect(reviewerBreaker.remaining(origin, t0)).toBe(0);
    expect(reviewerBreaker.cooldownStatus(origin)).toBeUndefined();

    expect(reviewerBreaker.fail(origin, 403, t0)).toBe(300_000);
    expect(reviewerBreaker.remaining(origin, t0)).toBe(300_000);
    expect(reviewerBreaker.cooldownStatus(origin)).toBe(403);
    reviewerBreaker.reset(origin);
    expect(reviewerBreaker.remaining(origin, t0)).toBe(0);
    expect(reviewerBreaker.cooldownStatus(origin)).toBeUndefined();

    expect(reviewerBreaker.fail(origin, 429, t0)).toBe(60_000);
    expect(reviewerBreaker.remaining(origin, t0)).toBe(60_000);
    expect(reviewerBreaker.cooldownStatus(origin)).toBe(429);
    reviewerBreaker.reset(origin);
    expect(reviewerBreaker.remaining(origin, t0)).toBe(0);

    // 单次 401 在 tripOn401=false 时不熔断（避免错 Key 测试锁死换 Key 重试）
    expect(reviewerBreaker.fail(origin, 401, t0)).toBe(0);
    expect(reviewerBreaker.remaining(origin, t0)).toBe(0);

    // 翻译器策略（tripOn401: true）：单次 401 立即触发 300s 冷却，到期自动释放
    const translatorBreaker = new OriginCircuitBreaker({ tripOn401: true });
    expect(translatorBreaker.fail(origin, 401, t0)).toBe(300_000);
    expect(translatorBreaker.remaining(origin, t0)).toBe(300_000);
    expect(translatorBreaker.cooldownStatus(origin)).toBe(401);
    expect(translatorBreaker.remaining(origin, t0 + 300_000)).toBe(0);
    translatorBreaker.reset(origin);
    expect(translatorBreaker.remaining(origin, t0)).toBe(0);
  });

  it('2) src/main/storage/readonly-sqlite-snapshot.ts 存在且导出可用只读 WAL 快照工具', async () => {
    const mod = await importOptionalMainModule('src/main/storage/readonly-sqlite-snapshot.ts');
    const exportedFunctions = Object.values(mod).filter((v) => typeof v === 'function');
    expect(exportedFunctions.length).toBeGreaterThanOrEqual(1);
  });

  it('3) src/main/security/redaction.ts 存在且统一脱敏常见 API Key / OAuth / Bearer 凭据', async () => {
    const mod = await importOptionalMainModule('src/main/security/redaction.ts');
    const redactor = (
      mod.redactSecretsForReviewer ??
      mod.redactSecrets ??
      mod.redactSensitiveText ??
      Object.values(mod).find((v) => typeof v === 'function')
    ) as ((input: string, extraSecret?: string) => string) | undefined;
    expect(typeof redactor).toBe('function');

    const sample =
      'Auth Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig key=sk-proj-TestSecretKey1234567890 google=AIzaSyDummyKey123456789012345';
    const cleaned = redactor!(sample);
    expect(cleaned).not.toContain('eyJhbGciOiJIUzI1NiJ9');
    expect(cleaned).not.toContain('sk-proj-TestSecretKey1234567890');
    expect(cleaned).not.toContain('AIzaSyDummyKey123456789012345');
  });

  it('4) src/main/telemetry/external-service-ledger.ts 存在且导出统一外部服务统计账本', async () => {
    const mod = await importOptionalMainModule('src/main/telemetry/external-service-ledger.ts');
    const exportedEntries = Object.values(mod).filter((v) => typeof v === 'function');
    expect(exportedEntries.length).toBeGreaterThanOrEqual(1);
  });
});

/* ============================================================================
 * 3. TelemetryStore Incremental Snapshot Cache & SwarmArchive Persistent WAL
 * ========================================================================== */

describe('v0.3.3 后端热点性能与持久连接回归', () => {
  it('TelemetryStore 100ms 增量快照缓存回归：连续单会话 chunk 更新时外部账本与聚合一致且跨小时自动刷新', () => {
    const dir = makeTempDir('gravity-v033-tele-cache-');
    const disk = new ClientStore(dir);
    let now = Date.UTC(2026, 10, 25, 14, 15, 0);

    const store = new TelemetryStore({ store: disk, now: () => now, profileId: 'default' });
    telemetryStores.push(store);

    // Seed session s2 + external reviewer & translator ledgers
    store.ensure('s2', 'gemini-4-neon');
    store.beginTurn('s2', 'baseline prompt');
    store.applyUsage('s2', { inputTokens: 1200, cachedInputTokens: 300, outputTokens: 400 });
    store.endTurn('s2');
    store.recordExternalReviewUsage({
      sessionId: 's2',
      provider: 'openai-compatible',
      endpoint: 'https://api.openai.com/v1',
      modelId: 'gpt-4o-mini',
      outcome: 'approve',
      latencyMs: 25,
      usage: { inputTokens: 200, cachedInputTokens: 0, outputTokens: 50, thinkingTokens: 0, totalTokens: 250, providerReported: true },
    });
    store.recordExternalTranslationUsage({
      sessionId: 's2',
      provider: 'local-ollama',
      endpoint: 'http://127.0.0.1:11434',
      modelId: 'qwen2.5:3b',
      outcome: 'success',
      latencyMs: 18,
      usage: { inputTokens: 100, cachedInputTokens: 0, outputTokens: 40, thinkingTokens: 0, totalTokens: 140, providerReported: true },
    });

    // Stream rapid chunks on s1 only and take repeated snapshots (simulating 100ms push loop)
    store.ensure('s1', 'gemini-4-neon');
    store.beginTurn('s1', 'streaming question');

    const fullBefore = store.snapshot();
    const s2CostBefore = fullBefore.activeSessions.s2.costSummary;
    const revBefore = fullBefore.externalReviewer;
    const transBefore = fullBefore.externalTranslator;
    expect(revBefore?.bySession.s2.callCount).toBe(1);
    expect(transBefore?.bySession.s2.callCount).toBe(1);

    let prevS1Output = 0;
    for (let i = 0; i < 15; i++) {
      now += 100;
      store.addChunk('s1', `chunk-${i} 中文输出内容。`);
      const incSnap = store.snapshot(new Set(['s1']));
      const fullSnap = store.snapshot();

      expect(incSnap.activeSessions.s1.costSummary.outputTokens).toBeGreaterThan(prevS1Output);
      prevS1Output = incSnap.activeSessions.s1.costSummary.outputTokens;
      expect(fullSnap.activeSessions.s1.costSummary.outputTokens).toBe(prevS1Output);
      expect(fullSnap.activeSessions.s2.costSummary).toEqual(s2CostBefore);
      expect(fullSnap.externalReviewer).toEqual(revBefore);
      expect(fullSnap.externalTranslator).toEqual(transBefore);
      expect(fullSnap.hourly24h).toHaveLength(24);
      expect(fullSnap.matrix7d).toHaveLength(168);
      expect(fullSnap.calendar30d).toHaveLength(30);
      expect(fullSnap.costByRange.today.totalTokens).toBeGreaterThanOrEqual(
        s2CostBefore.totalTokens + prevS1Output
      );
    }

    store.endTurn('s1');
    store.flush(true);

    // Cross-hour boundary must invalidate hour-keyed cache cleanly
    const prevLatestHour = store.snapshot().hourly24h.at(-1)!.hourKey;
    now += 3_600_000;
    const afterHourSnap = store.snapshot();
    expect(afterHourSnap.hourly24h.at(-1)!.hourKey).not.toBe(prevLatestHour);

    // Fresh reload from disk must produce identical totals to live cached snapshot
    const reloaded = new TelemetryStore({ store: disk, now: () => now, profileId: 'default' });
    telemetryStores.push(reloaded);
    const reloadedSnap = reloaded.snapshot();
    expect(reloadedSnap.costByRange.today).toEqual(afterHourSnap.costByRange.today);
    expect(reloadedSnap.externalReviewer).toEqual(afterHourSnap.externalReviewer);
    expect(reloadedSnap.externalTranslator).toEqual(afterHourSnap.externalTranslator);
  });

  it('SwarmArchive 持久 WAL 连接复用与 :memory: 模式 close() 后重建不报错（PLG-14）', () => {
    // 1. File-backed WAL persistent reuse & clean close/reopen
    const dir = makeTempDir('gravity-v033-swarm-wal-');
    const store = new ClientStore(dir);
    const fileArchive = new SwarmArchive(store, 'default');
    archives.push(fileArchive);

    const makeWorker = (id: string, name: string, status: 'working' | 'completed', ts: string) => ({
      id,
      name,
      role: 'worker',
      kind: 'swarm-worker' as const,
      model: 'gemini-4-neon',
      status,
      workspaceMode: 'inherit' as const,
      channels: ['main'],
      brief: `task for ${name}`,
      startedAt: ts,
      updatedAt: ts,
    });

    fileArchive.write('sess-wal', (log) => {
      log.ensure();
      log.touch('2026-11-25T00:00:00Z');
      log.put(makeWorker('w1', 'worker-1', 'working', '2026-11-25T00:00:00Z'));
      log.addBoard(
        {
          seq: 1,
          sender: 'worker-1',
          channel: 'main',
          content: 'hello wal',
          timestamp: '2026-11-25T00:00:00Z',
          mentions: [],
          isDoneReport: false,
          isStallAlert: false,
        },
        false
      );
    });
    fileArchive.write('sess-wal', (log) => {
      log.ensure();
      log.touch('2026-11-25T00:01:00Z');
      log.put(makeWorker('w2', 'worker-2', 'completed', '2026-11-25T00:01:00Z'));
    });
    const beforeClose = fileArchive.read('sess-wal', (log) => log.state());
    expect(beforeClose.workers.map((w) => w.id)).toEqual(['w1', 'w2']);
    expect(beforeClose.boardMessages.map((m) => m.content)).toEqual(['hello wal']);

    fileArchive.close();
    // Reopening after close() must seamlessly restore schema & persisted records
    const afterReopen = fileArchive.read('sess-wal', (log) => log.state());
    expect(afterReopen.workers.map((w) => w.id)).toEqual(['w1', 'w2']);
    fileArchive.close();

    // 2. :memory: mode close() must reset initialized flag so subsequent write/read recreates schema without throwing
    const memArchive = new SwarmArchive();
    archives.push(memArchive);
    memArchive.write('sess-mem', (log) => {
      log.ensure();
      log.touch('2026-11-25T00:00:00Z');
      log.put(makeWorker('mw1', 'mem-1', 'working', '2026-11-25T00:00:00Z'));
    });
    expect(memArchive.read('sess-mem', (log) => log.state()).workers).toHaveLength(1);

    memArchive.close();

    expect(() => {
      memArchive.write('sess-mem-2', (log) => {
        log.ensure();
        log.touch('2026-11-25T00:02:00Z');
        log.put(makeWorker('mw2', 'mem-2', 'completed', '2026-11-25T00:02:00Z'));
      });
    }).not.toThrow();
    expect(memArchive.read('sess-mem-2', (log) => log.state()).workers.map((w) => w.id)).toEqual(['mw2']);
  });
});
