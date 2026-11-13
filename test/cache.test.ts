import { describe, expect, it, vi } from 'vitest';
import { SingleFlight, TtlCache } from '../src/cache.js';

describe('TtlCache', () => {
  it('stores and returns values', () => {
    const c = new TtlCache<string>();
    c.set('k', 'v', 1000);
    expect(c.get('k')).toBe('v');
  });

  it('expires after ttl', () => {
    vi.useFakeTimers();
    const c = new TtlCache<string>();
    c.set('k', 'v', 100);
    vi.advanceTimersByTime(150);
    expect(c.get('k')).toBeUndefined();
    vi.useRealTimers();
  });

  it('deletes keys', () => {
    const c = new TtlCache<string>();
    c.set('k', 'v', 1000);
    c.delete('k');
    expect(c.get('k')).toBeUndefined();
  });
});

describe('SingleFlight', () => {
  it('collapses concurrent calls into one execution', async () => {
    let calls = 0;
    const sf = new SingleFlight();
    const fn = async (): Promise<number> => {
      calls++;
      await new Promise((r) => setTimeout(r, 10));
      return 42;
    };
    const [a, b] = await Promise.all([sf.run('k', fn), sf.run('k', fn)]);
    expect(calls).toBe(1);
    expect(a).toBe(42);
    expect(b).toBe(42);
  });

  it('runs again after the previous call settles', async () => {
    const sf = new SingleFlight();
    await sf.run('k', async () => 1);
    await sf.run('k', async () => 2);
    expect(await sf.run('k', async () => 3)).toBe(3);
  });

  it('clears inflight entry even when fn rejects', async () => {
    const sf = new SingleFlight();
    await expect(sf.run('k', async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(await sf.run('k', async () => 'ok')).toBe('ok');
  });
});
