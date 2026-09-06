import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLeaseGuard } from '../worker/lease';
import { HttpError } from '../worker/core';

afterEach(() => vi.useRealTimers());

describe('transfer liveness under coordinator failures', () => {
  it('keeps a slow but healthy server stream alive across many lease periods', async () => {
    vi.useFakeTimers();
    const extend = vi.fn(async (id: string) => ({ id, due: Date.now() + 180_000 }));
    const guard = createLeaseGuard({ id: 'slow-download', due: Date.now() + 180_000 }, extend);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(extend).toHaveBeenCalledTimes(10);
    expect(guard.signal.aborted).toBe(false);
    guard.stop();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(extend).toHaveBeenCalledTimes(10);
    expect(guard.signal.aborted).toBe(false);
  });

  it('aborts before cleanup eligibility when every heartbeat fails', async () => {
    vi.useFakeTimers();
    const guard = createLeaseGuard({ id: 'outage', due: Date.now() + 180_000 }, async () => { throw new Error('unreachable'); });
    await vi.advanceTimersByTimeAsync(174_999);
    expect(guard.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(guard.signal.aborted).toBe(true);
    guard.stop();
  });

  it('aborts even when a renewal hangs forever rather than rejecting', async () => {
    vi.useFakeTimers();
    const guard = createLeaseGuard({ id: 'hung', due: Date.now() + 180_000 }, () => new Promise(() => {}));
    await vi.advanceTimersByTimeAsync(175_000);
    expect(guard.signal.aborted).toBe(true);
    guard.stop();
  });

  it('stops immediately when the persisted lease is rejected', async () => {
    vi.useFakeTimers();
    const guard = createLeaseGuard({ id: 'cancelled', due: Date.now() + 180_000 }, async () => { throw new HttpError(410, 'LEASE_EXPIRED', 'expired'); });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(guard.signal.aborted).toBe(true);
    guard.stop();
  });
});
