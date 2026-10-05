// Shutdown is best-effort for every owned part, but never hides a failure. Keep the first thrown value (including
// null or undefined), finish the remaining actions, then rethrow it. Used only for lifecycle cleanup, not per frame.
export class Disposal {
  private failed = false;
  private firstError: unknown;

  run(action: () => void): void {
    try {
      action();
    } catch (error) {
      if (!this.failed) {
        this.failed = true;
        this.firstError = error;
      }
    }
  }

  finish(): void {
    if (this.failed) throw this.firstError;
  }
}
