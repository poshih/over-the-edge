import type { ContentSession, ContentStatistics } from './content-session';

const PREFIX = 'gettingover:release:';
const MARKS = [
  'start', 'attempt-start', 'manifest-ready', 'boot-content-loaded',
  'loading-unblocked', 'input-enabled', 'failed', 'aborted',
] as const;
const MEASURES = ['boot-to-input', 'navigation-to-input'] as const;
type ReleaseMark = (typeof MARKS)[number];

interface ReleaseMarkDetail {
  readonly attempt: number;
  readonly statistics?: ContentStatistics;
}

export class ReleaseMeasurements {
  private attempt = 0;
  private startedAt = 0;
  private finished = false;
  private closed = false;
  private readonly marked = new Set<ReleaseMark>();

  start(): void {
    if (this.closed) return;
    this.startedAt = performance.now();
    this.clear();
    this.attempt = 0;
    this.mark('start', null, this.startedAt);
  }

  beginAttempt(): void {
    if (this.closed) return;
    this.clear();
    this.attempt++;
    // Retrying replaces the entries, but boot time still begins at Release.run().
    this.mark('start', null, this.startedAt);
    this.mark('attempt-start');
  }

  mark(name: ReleaseMark, session: ContentSession | null = null, startTime?: number): void {
    if (this.closed || this.finished || this.marked.has(name)) return;
    const detail: ReleaseMarkDetail = session === null
      ? { attempt: this.attempt }
      : { attempt: this.attempt, statistics: session.statistics() };
    performance.mark(`${PREFIX}${name}`, { detail, startTime });
    this.marked.add(name);
    this.finished = name === 'input-enabled' || name === 'failed' || name === 'aborted';
    if (name === 'input-enabled') {
      performance.measure(`${PREFIX}boot-to-input`, `${PREFIX}start`, `${PREFIX}input-enabled`);
      performance.measure(`${PREFIX}navigation-to-input`, { start: 0, end: `${PREFIX}input-enabled` });
    }
  }

  close(): void {
    this.closed = true;
  }

  private clear(): void {
    for (const name of MARKS) performance.clearMarks(`${PREFIX}${name}`);
    for (const name of MEASURES) performance.clearMeasures(`${PREFIX}${name}`);
    this.marked.clear();
    this.finished = false;
  }
}
