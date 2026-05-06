export interface HandlerContext {
  idempotencyKey: string;
  signal: AbortSignal;
  workflowId: string;
  taskId: string;
  attempt: number;
}

export type HandlerFn = (input: unknown, ctx: HandlerContext) => Promise<void>;

export class HandlerRegistry {
  private handlers = new Map<string, HandlerFn>();

  register(name: string, fn: HandlerFn): HandlerFn {
    this.handlers.set(name, fn);
    return fn;
  }

  get(name: string): HandlerFn {
    const fn = this.handlers.get(name);
    if (!fn) {
      throw new Error(`Handler not found: ${name}`);
    }
    return fn;
  }

  has(name: string): boolean {
    return this.handlers.has(name);
  }
}
