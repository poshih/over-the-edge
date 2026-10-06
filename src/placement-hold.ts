import { Disposal } from './disposal';

/**
 * Prepared presentation changes wait for a new player placement, never for the death screen's clear.
 * Callers validate and prepare everything refusable before deferring; an apply must not fail for
 * caller input. A thrown apply is an engine invariant violation: remaining work is cancelled and
 * placement waiters are rejected. Cancellation releases resources still owned by that work.
 */
export class PlacementHold {
  private held = false;
  private disposed = false;
  private placing = false;
  private readonly changes: { readonly apply: () => void; readonly cancel?: () => void }[] = [];
  private readonly waiting = new Set<{ resolve(): void; reject(error: unknown): void }>();

  begin(): void { this.held = true; }
  defer(change: () => void, cancel?: () => void): boolean {
    if (this.disposed) throw new DOMException('The presentation was disposed.', 'AbortError');
    if (!this.held) return false;
    this.changes.push({ apply: change, cancel }); return true;
  }
  async wait(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (this.disposed) throw new DOMException('The presentation was disposed.', 'AbortError');
    if (!this.held) return;
    await new Promise<void>((resolve, reject) => {
      const waiter = {
        resolve: () => { signal.removeEventListener('abort', abort); this.waiting.delete(waiter); resolve(); },
        reject: (error: unknown) => { signal.removeEventListener('abort', abort); this.waiting.delete(waiter); reject(error); },
      };
      const abort = () => waiter.reject(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
      this.waiting.add(waiter);
    });
  }
  place(): void {
    if (this.disposed || this.placing) return;
    const changes = this.changes.splice(0);
    this.held = false;
    this.placing = true;
    let applied = 0;
    try {
      for (; applied < changes.length; applied++) changes[applied]!.apply();
      for (const waiter of this.waiting) waiter.resolve();
    } catch (error) {
      for (const waiter of this.waiting) waiter.reject(error);
      const disposal = new Disposal();
      disposal.run(() => { throw error; });
      for (; applied < changes.length; applied++) {
        const cancel = changes[applied]!.cancel;
        if (cancel !== undefined) disposal.run(cancel);
      }
      disposal.finish();
    } finally { this.placing = false; }
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const disposal = new Disposal();
    for (const change of this.changes) if (change.cancel !== undefined) disposal.run(change.cancel);
    this.changes.length = 0;
    const error = new DOMException('The presentation was disposed before placement.', 'AbortError');
    for (const waiter of this.waiting) waiter.reject(error);
    disposal.finish();
  }
}
