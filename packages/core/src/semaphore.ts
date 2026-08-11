export class Semaphore {
  readonly #capacity: number;
  #active = 0;
  readonly #waiters: Array<{
    readonly resolve: (release: () => void) => void;
    readonly reject: (error: unknown) => void;
    readonly signal: AbortSignal;
    readonly onAbort: () => void;
  }> = [];

  constructor(capacity: number) {
    this.#capacity = capacity;
  }

  acquire(signal: AbortSignal): Promise<() => void> {
    if (signal.aborted) {
      return Promise.reject(signal.reason);
    }

    if (this.#active < this.#capacity) {
      this.#active += 1;
      return Promise.resolve(this.#releaseOnce());
    }

    return new Promise((resolve, reject) => {
      const waiter = {
        resolve,
        reject,
        signal,
        onAbort: () => {
          const index = this.#waiters.indexOf(waiter);
          if (index >= 0) {
            this.#waiters.splice(index, 1);
          }
          reject(signal.reason);
        },
      };
      signal.addEventListener("abort", waiter.onAbort, { once: true });
      this.#waiters.push(waiter);
    });
  }

  #releaseOnce(): () => void {
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;

      const waiter = this.#waiters.shift();
      if (waiter === undefined) {
        this.#active -= 1;
        return;
      }

      waiter.signal.removeEventListener("abort", waiter.onAbort);
      waiter.resolve(this.#releaseOnce());
    };
  }
}
