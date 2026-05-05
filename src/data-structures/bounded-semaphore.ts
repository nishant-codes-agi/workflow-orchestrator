export class BoundedSemaphore {
  private count: number;
  private waiters: Array<() => void> = [];

  constructor(private readonly limit: number) {
    this.count = limit;
  }

  async acquire(): Promise<void> {
    if (this.count > 0) {
      this.count--;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  release(): void {
    const next = this.waiters.shift();
    if (next) {
      next();
    } else {
      this.count++;
    }
  }

  availablePermits(): number {
    return this.count;
  }
}
