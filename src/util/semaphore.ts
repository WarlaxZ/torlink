// Minimal counting semaphore. `acquire()` resolves immediately while under the
// limit, otherwise queues until a `release()` hands over a slot (FIFO). Each
// acquire must be balanced by exactly one release.
export class Semaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  // Slots not currently held (0 when full). Handy for assertions.
  get available(): number {
    return Math.max(0, this.limit - this.active);
  }

  acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  release(): void {
    const next = this.waiters.shift();
    if (next) {
      // Hand the slot straight to the next waiter — active count is unchanged.
      next();
      return;
    }
    if (this.active > 0) this.active--;
  }
}
