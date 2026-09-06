import { HEARTBEAT_MS } from '../shared/contracts';
import { HttpError } from './core';
import type { LeaseHandle } from './state';

/** Local watchdog is deliberately earlier than the durable expiry: if the
 * coordinator is unreachable, stop reading before cleanup can delete R2. */
export function createLeaseGuard(initial: LeaseHandle, extend: (id: string) => Promise<LeaseHandle>) {
  const controller = new AbortController();
  let handle = initial;
  let stopped = false;
  let renewal: ReturnType<typeof setTimeout>;
  let watchdog: ReturnType<typeof setTimeout>;
  const armWatchdog = () => {
    clearTimeout(watchdog);
    watchdog = setTimeout(() => controller.abort(new Error('Transfer lease expired')), Math.max(0, handle.due - Date.now() - 5000));
  };
  const renew = async () => {
    if (stopped || controller.signal.aborted) return;
    let delay = HEARTBEAT_MS;
    try {
      const next = await extend(handle.id);
      if (!stopped && !controller.signal.aborted) { handle = next; armWatchdog(); }
    } catch (error) {
      if (error instanceof HttpError && error.status === 410) controller.abort(new Error('Transfer no longer active'));
      delay = 10_000;
    }
    if (!stopped && !controller.signal.aborted) renewal = setTimeout(() => void renew(), delay);
  };
  armWatchdog();
  renewal = setTimeout(() => void renew(), HEARTBEAT_MS);
  return {
    signal: controller.signal,
    update(next: LeaseHandle) { handle = next; armWatchdog(); },
    stop() { stopped = true; clearTimeout(renewal); clearTimeout(watchdog); },
    abort() { controller.abort(); },
  };
}
