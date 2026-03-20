/**
 * AsyncQueue is a tiny in-memory queue supporting async iteration with timeout.
 * It is used for client-level listeners and mailbox-level listeners.
 */
export class AsyncQueue<T> {
  private readonly values: T[] = [];
  private readonly waitingResolvers: Array<{
    resolve: (value: T | null) => void;
    reject: (error: Error) => void;
  }> = [];
  private closed = false;
  private failure: Error | null = null;

  public push(value: T): void {
    if (this.closed || this.failure !== null) {
      return;
    }
    const waiter = this.waitingResolvers.shift();
    if (waiter !== undefined) {
      waiter.resolve(value);
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
      const waiter = this.waitingResolvers.shift();
      if (waiter !== undefined) {
        waiter.resolve(null);
      }
    }
  }

  public fail(error: Error): void {
    if (this.failure !== null) {
      return;
    }
    this.failure = error;
    while (this.waitingResolvers.length > 0) {
      const waiter = this.waitingResolvers.shift();
      if (waiter !== undefined) {
        waiter.reject(error);
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

    return await new Promise<T | null>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      const wrappedResolve = (value: T | null): void => {
        if (timer !== null) {
          clearTimeout(timer);
        }
        resolve(value);
      };
      const wrappedReject = (error: Error): void => {
        if (timer !== null) {
          clearTimeout(timer);
        }
        reject(error);
      };

      if (typeof timeoutMs === "number" && timeoutMs >= 0) {
        timer = setTimeout(() => {
          const index = this.waitingResolvers.findIndex((item) => item.resolve === wrappedResolve);
          if (index >= 0) {
            this.waitingResolvers.splice(index, 1);
          }
          resolve(null);
        }, timeoutMs);
      }

      this.waitingResolvers.push({
        resolve: wrappedResolve,
        reject: wrappedReject
      });
    });
  }
}
