import { REQUEST_TIMEOUT_MS, WORKBUDDY_POOL_MAX_USES, WORKBUDDY_POOL_SIZE } from '../config.ts';
import { buildWorkbuddyOptions, type WorkbuddyAgent } from './workbuddy.ts';

// SDK 会话的最小使用面：正式用 Session，测试用假对象。
export interface PooledSession {
  send(message: string): Promise<void>;
  stream(): AsyncGenerator<any, void>;
  interrupt(): Promise<void>;
  close(): void;
  setModel?(model: string): Promise<void>;
}

export type SessionFactory = (options: Record<string, any>) => PooledSession | Promise<PooledSession>;

interface Slot {
  session: PooledSession | null;
  model: string;
  uses: number;
  busy: boolean;
}

// 长驻 Workbuddy 会话池：CLI 进程一次启动、多次复用，摊掉每单约 4s 的启动+初始化开销。
//
// 为什么不用 daemon（--serve）：daemon 是交互式 Agent 服务，走 Gateway Protocol
// 的 /api/v1/runs（有状态 Agent run），给按 chunk 计量的无头翻译用是重协议+多一层
// HTTP。池复用的是 SDK Session，即文档里 --input-format stream-json 长驻进程的
// SDK 等价物：stdin 常开、不重启进程，send/stream 即多轮。
//
// 约束：
// - 一个会话同时只能跑一轮（串行），池大小对齐扩展侧扇出（默认 4）。
// - 每 send 一次历史就变长（输入 token 与耗时 creep），用满 maxUses 轮即重建。
// - 文学 JSON 模式不用池：量小且天然串行，沿用单次 query（见 workbuddy.ts）。
export class WorkbuddySessionPool {
  private slots: Slot[];
  private waiters: Array<() => void> = [];

  constructor(
    private readonly size: number,
    private readonly maxUses: number,
    private readonly factory: SessionFactory,
  ) {
    this.slots = Array.from({ length: size }, () => ({ session: null, model: '', uses: 0, busy: false }));
  }

  // 取一个空闲槽位并保证会话就绪；全忙时排队等（不另起进程，避免无界膨胀）。
  async acquire(agent: WorkbuddyAgent): Promise<number> {
    for (;;) {
      const index = this.slots.findIndex((slot) => !slot.busy);
      if (index >= 0) {
        const slot = this.slots[index];
        slot.busy = true;
        try {
          await this.ensureSession(index, agent);
        } catch (error) {
          slot.busy = false;
          this.wakeNext();
          throw error;
        }
        return index;
      }
      await new Promise<void>((resolve) => { this.waiters.push(resolve); });
    }
  }

  release(index: number): void {
    this.slots[index].busy = false;
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
    const startedAt = Date.now();
    let text = '';
    let structuredOutput: unknown;
    // 首个正文 token 到达时间：之前是排队+模型首 token，之后是生成。
    let firstTextAt = 0;
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
              if (!firstTextAt) firstTextAt = Date.now();
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
    console.info(
      '[local-agent][' + requestId + '] workbuddy-timing ttftMs=' + (firstTextAt ? firstTextAt - startedAt : -1) +
      ' totalMs=' + (Date.now() - startedAt) +
      ' textChars=' + text.trim().length +
      ' uses=' + (slot.uses + 1) +
      ' structured=' + (structuredOutput === undefined ? 'none' : 'native'),
    );
    slot.uses += 1;
    if (slot.uses >= this.maxUses) this.dropSession(index);
    return { text: text.trim(), structuredOutput };
  }

  // 关停/测试用：关闭全部 CLI 子进程并清空。
  closeAll(): void {
    for (let i = 0; i < this.slots.length; i++) this.dropSession(i);
    this.waiters.splice(0).forEach((wake) => { wake(); });
  }

  // 保证槽位有可用会话；模型与槽位不一致时热切换（控制请求，无需重启进程）。
  private async ensureSession(index: number, agent: WorkbuddyAgent): Promise<void> {
    const slot = this.slots[index];
    if (!slot.session) {
      slot.session = await this.factory(buildTextSessionOptions(agent));
      slot.model = agent.model || '';
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
  }

  private wakeNext(): void {
    const wake = this.waiters.shift();
    if (wake) wake();
  }
}

// 复用会话的 options：与单次 query 一致，但去掉 maxTurns。
// --max-turns 是按进程（会话生命周期）计的预算，不适合复用会话；
// 单轮护栏由 tools:[]（无工具可循环）+ 超时承担。
export function buildTextSessionOptions(agent: WorkbuddyAgent): Record<string, any> {
  const { maxTurns: _unused, ...rest } = buildWorkbuddyOptions(agent);
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
