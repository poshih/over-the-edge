const CAPACITY = 8192;

export interface RenderTimeMeasurements {
  readonly label: string | null;
  readonly samples: number;
  readonly retained: number;
  readonly p95: number | null;
  readonly p99: number | null;
  readonly max: number | null;
}

export class ViewMeasurements {
  private buffer: Float64Array | null = null;
  private label: string | null = null;
  private total = 0;
  private maximum: number | null = null;
  private active = false;

  get capturing(): boolean { return this.active; }

  start(label: string): void {
    this.buffer = new Float64Array(CAPACITY);
    this.label = label;
    this.total = 0;
    this.maximum = null;
    this.active = true;
  }

  stop(): void { this.active = false; }

  record(duration: number): void {
    if (!this.active) return;
    this.buffer![this.total % CAPACITY] = duration;
    this.total++;
    if (this.maximum === null || duration > this.maximum) this.maximum = duration;
  }

  samples(): number[] {
    const retained = Math.min(this.total, CAPACITY);
    const result = new Array<number>(retained);
    for (let index = 0; index < retained; index++) {
      result[index] = this.buffer![(this.total - retained + index) % CAPACITY]!;
    }
    return result;
  }

  read(): RenderTimeMeasurements {
    const sorted = this.samples().sort((a, b) => a - b);
    const retained = sorted.length;
    return {
      label: this.label, samples: this.total, retained,
      p95: retained === 0 ? null : sorted[Math.ceil(0.95 * retained) - 1]!,
      p99: retained === 0 ? null : sorted[Math.ceil(0.99 * retained) - 1]!,
      max: this.maximum,
    };
  }
}
