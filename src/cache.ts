interface Entry<T> {
  value: T;
  expiresAt: number;
}

/** Minimal TTL map. Expired entries are evicted lazily on read. */
export class TtlCache<T> {
  private store = new Map<string, Entry<T>>();

  get(key: string): T | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: T, ttlMs: number): void {
    this.store.set(key, { value, expiresAt: Date.now() + ttlMs });
  }

  delete(key: string): void {
    this.store.delete(key);
  }

  get size(): number {
    return this.store.size;
  }
}

/**
 * Collapses concurrent identical requests into one execution — Stremio
 * often retries stream requests and prefetches, so without this a single
 * lookup could fan out into dozens of parallel provider sweeps.
 */
export class SingleFlight {
  private inflight = new Map<string, Promise<unknown>>();

  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const existing = this.inflight.get(key);
    if (existing) return existing as Promise<T>;
    const p = fn().finally(() => {
      this.inflight.delete(key);
    });
    this.inflight.set(key, p);
    return p;
  }
}
