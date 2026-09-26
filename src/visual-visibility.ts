import type { Object3D } from 'three';

export class VisualVisibility {
  private replacement: Object3D | null = null;
  private covered = false;
  private enabled = true;
  private readonly defaults: readonly Object3D[];
  private readonly onReplacement: ((next: Object3D | null, previous: Object3D | null) => void) | undefined;

  constructor(defaults: readonly Object3D[], options: {
    onReplacement?: (next: Object3D | null, previous: Object3D | null) => void;
  } = {}) {
    this.defaults = defaults;
    this.onReplacement = options.onReplacement;
  }

  setReplacement(replacement: Object3D | null): void {
    const previous = this.replacement;
    this.replacement = replacement;
    this.update();
    if (previous !== replacement) this.onReplacement?.(replacement, previous);
  }

  setCovered(options: { covered: boolean }): void {
    this.covered = options.covered;
    this.update();
  }

  setEnabled(options: { enabled: boolean }): void {
    if (this.enabled === options.enabled) return;
    this.enabled = options.enabled;
    this.update();
  }

  private update(): void {
    for (const object of this.defaults) object.visible = this.enabled && !this.covered && this.replacement === null;
    if (this.replacement) this.replacement.visible = this.enabled && !this.covered;
  }
}
