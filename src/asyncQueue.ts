/**
 * AsyncQueue is a tiny in-memory queue supporting async iteration with timeout.
 * It is used for client-level listeners and mailbox-level listeners.
 */
export class AsyncQueue<T> {
  private readonly values: T[] = [];
  private readonly waitingResolvers: Array<(value: T | null) => void> = [];
  private closed = false;
  private failure: Error | null = null;

  public push(value: T): void {
    if (this.closed || this.failure !== null) {
      return;
    }
    const resolver = this.waitingResolvers.shift();
    if (resolver !== undefined) {
      resolver(value);
      return;
    }
    this.values.push(value);
  }

  public close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    while (this.waitingResolvers.length > 0) {
      const resolver = this.waitingResolvers.shift();
      if (resolver !== undefined) {
        resolver(null);
      }
    }
  }

  public fail(error: Error): void {
    if (this.failure !== null) {
      return;
    }
    this.failure = error;
    while (this.waitingResolvers.length > 0) {
      const resolver = this.waitingResolvers.shift();
      if (resolver !== undefined) {
        resolver(null);
      }
    }
  }

  public async next(timeoutMs?: number): Promise<T | null> {
    if (this.failure !== null) {
      throw this.failure;
    }
    if (this.values.length > 0) {
      return this.values.shift() as T;
    }
    if (this.closed) {
      return null;
    }

    return await new Promise<T | null>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      const wrappedResolve = (value: T | null): void => {
        if (timer !== null) {
          clearTimeout(timer);
        }
        resolve(value);
      };

      if (typeof timeoutMs === "number" && timeoutMs >= 0) {
        timer = setTimeout(() => {
          const index = this.waitingResolvers.indexOf(wrappedResolve);
          if (index >= 0) {
            this.waitingResolvers.splice(index, 1);
          }
          resolve(null);
        }, timeoutMs);
      }

      this.waitingResolvers.push(wrappedResolve);
    });
  }
}
