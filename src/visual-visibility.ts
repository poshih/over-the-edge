import type { Object3D } from 'three';

export class VisualVisibility {
  private replacement: Object3D | null = null;
  private covered = false;
  private readonly defaults: readonly Object3D[];

  constructor(defaults: readonly Object3D[]) {
    this.defaults = defaults;
  }

  setReplacement(replacement: Object3D | null): void {
    this.replacement = replacement;
    this.update();
  }

  setCovered(options: { covered: boolean }): void {
    this.covered = options.covered;
    this.update();
  }

  private update(): void {
    for (const object of this.defaults) object.visible = !this.covered && this.replacement === null;
    if (this.replacement) this.replacement.visible = !this.covered;
  }
}
