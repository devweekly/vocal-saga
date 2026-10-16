import { REQUEST_TIMEOUT_MS, WORKBUDDY_POOL_MAX_USES, WORKBUDDY_POOL_SIZE } from '../config.ts';
import { buildWorkbuddyOptions, type WorkbuddyAgent } from './workbuddy.ts';

// SDK 会话的最小使用面：正式用 Session，测试用假对象。
export interface PooledSession {
  send(message: string): Promise<void>;
  stream(): AsyncGenerator<any, void>;
  interrupt(): Promise<void>;
  close(): void;
  setModel?(model: string): Promise<void>;
  /** 只 boot CLI 进程，不调模型（SDK Session.connect 的预热语义）。 */
  connect?(): Promise<void>;
}

export type SessionFactory = (options: Record<string, any>) => PooledSession | Promise<PooledSession>;

interface Slot {
  session: PooledSession | null;
  model: string;
  /** Complete scope key; document batches add run, role, prompt revision, lane and batch index to isolate history. */
  scopeKey: string;
  schemaKey: string;
  uses: number;
  busy: boolean;
  lastUsedAt: number;
}

// 有界 Workbuddy Session 池。普通网页文本使用可复用的 shared-slot 会话来摊薄启动开销；
// project Agent 为隔离每批对话历史使用独立 scope，不同批次可能重建 Session 并产生初始化成本。
//
// 为什么不用 daemon（--serve）：daemon 是交互式 Agent 服务，走 Gateway Protocol
// 的 /api/v1/runs（有状态 Agent run），给按 chunk 计量的无头翻译用是重协议+多一层
// HTTP。池复用的是 SDK Session，即文档里 --input-format stream-json 长驻进程的
// SDK 等价物：stdin 常开、不重启进程，send/stream 即多轮。
//
// 约束：
// - 一个会话同时只能跑一轮（串行），池大小对齐扩展侧扇出（默认 4）。
// - 每 send 一次历史就变长（输入 token 与耗时 creep），用满 maxUses 轮即重建。
// - 书籍任务的调用方负责构造稳定 scopeKey；project Agent 把 run/role/prompt revision/lane/batch 编入 key，因此只有同一批重试会复用上下文。
// - 同一个 scopeKey 同时只允许一个请求运行，避免并发请求把轮次交错写入同一对话。
// - 达到 maxUses 后销毁会话；新会话首轮会重新注入稳定 prompt，动态书籍记忆由调用方重传。
export class WorkbuddySessionPool {
  private slots: Slot[];
  private waiters: Array<() => void> = [];

  constructor(
    private readonly size: number,
    private readonly maxUses: number,
    private readonly factory: SessionFactory,
  ) {
    this.slots = Array.from({ length: size }, () => ({
      session: null, model: '', scopeKey: '', schemaKey: '', uses: 0, busy: false, lastUsedAt: 0,
    }));
  }

  // 取一个空闲槽位并保证会话就绪；全忙时排队等（不另起进程，避免无界膨胀）。
  async acquire(
    agent: WorkbuddyAgent,
    scopeKey = 'shared-text-translation',
    schema?: Record<string, unknown>,
  ): Promise<number> {
    // Legacy non-document translations retain a parallel pool: each in-flight chunk gets its
    // own slot, while an idle slot can be reused later. Book/task sessions use the stricter path below.
    if (scopeKey === 'shared-text-translation' && !schema) return this.acquireSharedTextSlot(agent);

    const schemaKey = schema ? JSON.stringify(schema) : '';
    const requestedKey = JSON.stringify([scopeKey, agent.model || '<runtime-default>', schemaKey]);
    for (;;) {
      // A scoped conversation has exactly one slot. Do not create a second copy while its
      // first copy is busy: parallel sends would split history and make turn order nondeterministic.
      const existingIndex = this.slots.findIndex((slot) => slot.scopeKey === requestedKey);
      if (existingIndex >= 0) {
        const slot = this.slots[existingIndex];
        if (slot.busy) {
          await new Promise<void>((resolve) => { this.waiters.push(resolve); });
          continue;
        }
        slot.busy = true;
        try {
          await this.ensureSession(existingIndex, agent, requestedKey, schema);
        } catch (error) {
          slot.busy = false;
          this.wakeNext();
          throw error;
        }
        slot.lastUsedAt = Date.now();
        return existingIndex;
      }

      let index = this.slots.findIndex((slot) => !slot.busy && !slot.session);
      if (index < 0) {
        // Bound memory/CLI children: evict the least-recently-used idle session only.
        const idle = this.slots
          .map((slot, slotIndex) => ({ slot, slotIndex }))
          .filter(({ slot }) => !slot.busy)
          .sort((a, b) => a.slot.lastUsedAt - b.slot.lastUsedAt)[0];
        if (idle) index = idle.slotIndex;
      }
      if (index < 0) {
        await new Promise<void>((resolve) => { this.waiters.push(resolve); });
        continue;
      }

      const slot = this.slots[index];
      slot.busy = true;
      if (slot.session) this.dropSession(index);
      slot.scopeKey = requestedKey;
      slot.schemaKey = schemaKey;
      try {
        await this.ensureSession(index, agent, requestedKey, schema);
      } catch (error) {
        slot.busy = false;
        this.wakeNext();
        throw error;
      }
      slot.lastUsedAt = Date.now();
      return index;
    }
  }

  private async acquireSharedTextSlot(agent: WorkbuddyAgent): Promise<number> {
    for (;;) {
      const reusable = this.slots.findIndex((slot) =>
        !slot.busy && !!slot.session && slot.schemaKey === '' && slot.scopeKey.startsWith('shared-slot:'),
      );
      if (reusable >= 0) {
        const slot = this.slots[reusable];
        slot.busy = true;
        try {
          await this.ensureSession(reusable, agent, slot.scopeKey || ('shared-slot:' + reusable));
        } catch (error) {
          slot.busy = false;
          this.wakeNext();
          throw error;
        }
        slot.lastUsedAt = Date.now();
        return reusable;
      }

      let index = this.slots.findIndex((slot) => !slot.busy && !slot.session);
      if (index < 0) {
        const idle = this.slots
          .map((slot, slotIndex) => ({ slot, slotIndex }))
          .filter(({ slot }) => !slot.busy)
          .sort((a, b) => a.slot.lastUsedAt - b.slot.lastUsedAt)[0];
        if (idle) index = idle.slotIndex;
      }
      if (index < 0) {
        await new Promise<void>((resolve) => { this.waiters.push(resolve); });
        continue;
      }

      const slot = this.slots[index];
      slot.busy = true;
      if (slot.session) this.dropSession(index);
      const slotKey = 'shared-slot:' + index + ':' + (agent.model || '<runtime-default>');
      slot.scopeKey = slotKey;
      try {
        await this.ensureSession(index, agent, slotKey);
      } catch (error) {
        slot.busy = false;
        this.wakeNext();
        throw error;
      }
      slot.lastUsedAt = Date.now();
      return index;
    }
  }

  /** True when the next turn must seed a fresh session with stable system instructions. */
  isFresh(index: number): boolean {
    return this.slots[index]?.uses === 0;
  }

  release(index: number): void {
    const slot = this.slots[index];
    if (!slot) return;
    slot.busy = false;
    slot.lastUsedAt = Date.now();
    this.wakeNext();
  }

  // 在指定槽位跑一轮：发 prompt、收文本与 structured_output，超时则中断。
  // 成功用满 maxUses 轮即重建；失败/超时直接丢弃会话（状态不可信），下次懒重建。
  async runPrompt(
    index: number,
    combinedPrompt: string,
    requestId: string,
    timeoutMs = REQUEST_TIMEOUT_MS,
  ): Promise<{ text: string; structuredOutput: unknown }> {
    const slot = this.slots[index];
    const session = slot.session;
    if (!session) throw new Error('会话槽位没有可用会话');
    let text = '';
    let structuredOutput: unknown;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { Promise.resolve(session.interrupt()).catch(() => {}); } catch { /* timeout is handled below */ }
    }, timeoutMs);
    timer.unref();
    try {
      await session.send(combinedPrompt);
      for await (const message of session.stream()) {
        const raw: any = message && typeof message === 'object' ? message : {};
        if (raw.type === 'assistant' && raw.message && Array.isArray(raw.message.content)) {
          for (const part of raw.message.content) {
            if (part?.type === 'text' && typeof part.text === 'string' && part.text.trim()) {
              text += (text ? '\n' : '') + part.text;
            }
          }
        }
        if (raw.type === 'result') {
          if (raw.is_error && Array.isArray(raw.errors) && raw.errors.length > 0) {
            throw new Error('Workbuddy 执行失败：' + String(raw.errors[0]));
          }
          if (raw.subtype && raw.subtype !== 'success') {
            throw new Error('Workbuddy 执行失败：' + String(raw.subtype));
          }
          if (raw.structured_output !== undefined) structuredOutput = raw.structured_output;
          break;
        }
      }
    } catch (error) {
      this.dropSession(index);
      if (timedOut) throw new Error('Workbuddy 调用超时（' + timeoutMs + ' ms）');
      throw new Error('Workbuddy Agent SDK 调用失败：' + (error instanceof Error ? error.message : String(error)));
    } finally {
      clearTimeout(timer);
    }
    if (timedOut) {
      this.dropSession(index);
      throw new Error('Workbuddy 调用超时（' + timeoutMs + ' ms）');
    }
    // 原生 --json-schema 成功时，SDK 可能只返回 StructuredOutput tool_use，
    // 最终数据放在 result.structured_output，而没有任何 assistant text。
    // 因此只有 text 和 structured_output 都缺失才是空响应；不能误杀健康的 JSON Session。
    // schemaKey 在 acquire 时记录本槽位的模式，用于让日志区分纯文本与结构化调用。
    const structuredMode = slot.schemaKey.length > 0;
    if (!text.trim() && structuredOutput === undefined) {
      console.error(
        '[local-agent][' + requestId + '] workbuddy-empty-output mode=' +
        (structuredMode ? 'structured' : 'text') + ' dropping poisoned session',
      );
      this.dropSession(index);
      throw new Error(
        'Workbuddy 返回了空内容（mode=' + (structuredMode ? 'structured' : 'text') +
        '），会话已丢弃重建；请重试该批次',
      );
    }
    // The document workflow logs role, batch, latency and output counts at the project boundary.
    // Keep internal Session reuse counters out of the default terminal output.
    slot.uses += 1;
    if (slot.uses >= this.maxUses) this.dropSession(index);
    return { text: text.trim(), structuredOutput };
  }

  // 关停/测试用：关闭全部 CLI 子进程并清空。
  closeAll(): void {
    for (let i = 0; i < this.slots.length; i++) this.dropSession(i);
    this.waiters.splice(0).forEach((wake) => { wake(); });
  }

  // 服务启动后后台调用一次：把空闲槽位的 CLI 进程提前拉起。
  // connect 只 boot 进程、不发 prompt（不调模型、不花 token）；initialize 留给首单。
  // 单个失败只丢该槽——首单仍走懒创建，不影响可用性。
  async prewarm(agent: WorkbuddyAgent): Promise<void> {
    const jobs: Promise<void>[] = [];
    for (let i = 0; i < this.slots.length; i++) {
      const slot = this.slots[i];
      if (slot.busy || slot.session) continue;
      slot.busy = true;
      jobs.push((async () => {
        try {
          const prewarmKey = 'shared-slot:' + i + ':' + (agent.model || '<runtime-default>');
          await this.ensureSession(i, agent, prewarmKey);
          await slot.session?.connect?.();
        } catch {
          this.dropSession(i);
        } finally {
          slot.busy = false;
          this.wakeNext();
        }
      })());
    }
    await Promise.all(jobs);
  }

  // 保证槽位有可用会话；模型与槽位不一致时热切换（控制请求，无需重启进程）。
  private async ensureSession(
    index: number,
    agent: WorkbuddyAgent,
    requestedKey: string,
    schema?: Record<string, unknown>,
  ): Promise<void> {
    const slot = this.slots[index];
    if (!slot.session) {
      slot.session = await this.factory(buildTextSessionOptions(agent, schema));
      slot.model = agent.model || '';
      slot.scopeKey = requestedKey;
      slot.schemaKey = schema ? JSON.stringify(schema) : '';
      slot.uses = 0;
      return;
    }
    if (slot.scopeKey !== requestedKey) {
      this.dropSession(index);
      slot.session = await this.factory(buildTextSessionOptions(agent, schema));
      slot.model = agent.model || '';
      slot.scopeKey = requestedKey;
      slot.schemaKey = schema ? JSON.stringify(schema) : '';
      slot.uses = 0;
      return;
    }
    if ((agent.model || '') !== slot.model) {
      await slot.session.setModel?.(agent.model);
      slot.model = agent.model || '';
    }
  }

  private dropSession(index: number): void {
    const slot = this.slots[index];
    if (slot.session) {
      try { slot.session.close(); } catch { /* 关闭失败直接丢弃 */ }
      slot.session = null;
    }
    slot.uses = 0;
    slot.scopeKey = '';
    slot.schemaKey = '';
    slot.model = '';
    slot.lastUsedAt = Date.now();
  }

  private wakeNext(): void {
    const wake = this.waiters.shift();
    if (wake) wake();
  }
}

// 复用会话的 options：与单次 query 一致，但去掉 maxTurns。
// --max-turns 是按进程（会话生命周期）计的预算，不适合复用会话；
// 单轮护栏由 tools:[]（无工具可循环）+ 超时承担。
export function buildTextSessionOptions(agent: WorkbuddyAgent, schema?: Record<string, unknown>): Record<string, any> {
  const { maxTurns: _unused, ...rest } = buildWorkbuddyOptions(agent, schema);
  return rest;
}

// 文本翻译池单例：懒创建，首单才启动 CLI 进程。
let textPool: WorkbuddySessionPool | null = null;

export function getTextPool(factory?: SessionFactory): WorkbuddySessionPool {
  if (!textPool) {
    const create: SessionFactory = factory ?? (async (options) => {
      const sdk = await import('@tencent-ai/agent-sdk');
      return sdk.unstable_v2_createSession(options);
    });
    textPool = new WorkbuddySessionPool(WORKBUDDY_POOL_SIZE, WORKBUDDY_POOL_MAX_USES, create);
  }
  return textPool;
}

// 测试隔离与进程关停用。
export function closeTextPool(): void {
  if (textPool) {
    textPool.closeAll();
    textPool = null;
  }
}
