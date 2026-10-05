import { BufferAttribute, BufferGeometry, CircleGeometry, Group, Line, LineDashedMaterial, Mesh, MeshBasicMaterial, RingGeometry } from 'three';
import type { Object3D } from 'three';
import type { Point } from './config';
import { PluginError, slotPoint } from './plugins/kernel';
import type { RuntimePlugins } from './plugins/runtime';
import type { GameTheme } from './theme';

export interface AimMarks {
  // Marks draw over the characters and their arms, under the tool. All their materials must ignore depth
  // (depthTest: false), leaving the depth shared by arms and tool alone.
  readonly root: Object3D;
  setTheme(theme: GameTheme): void;
  update(tip: Readonly<Point>, cursor: Readonly<Point>): void;
  dispose(): void;
}

export type AimMarksFactory = (theme: GameTheme) => AimMarks;

function marksFactory(value: unknown): AimMarksFactory {
  if (typeof value !== 'function') throw new TypeError('Aim marks must be a factory.');
  return value as AimMarksFactory;
}

export const AIM_MARKS = slotPoint('scene.aim-marks', 'runtime', marksFactory);

class RingAimMarks implements AimMarks {
  readonly root = new Group();
  private readonly cursor = new Group();
  private readonly cursorMaterial: MeshBasicMaterial;
  private readonly targetMaterial: LineDashedMaterial;
  private readonly targetLine: Line;
  private readonly positions = new BufferAttribute(new Float32Array(6), 3);
  private readonly distances = new BufferAttribute(new Float32Array(2), 1);

  constructor(theme: GameTheme) {
    this.cursorMaterial = new MeshBasicMaterial({ color: theme.aim.cursor, transparent: true, opacity: 0.9, depthTest: false });
    this.cursor.add(new Mesh(new RingGeometry(0.075, 0.09, 24), this.cursorMaterial));
    this.cursor.add(new Mesh(new CircleGeometry(0.018, 12), this.cursorMaterial));
    this.cursor.renderOrder = 20;
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', this.positions);
    geometry.setAttribute('lineDistance', this.distances);
    this.targetMaterial = new LineDashedMaterial({
      color: theme.aim.line, transparent: true, opacity: 0.45, dashSize: 0.07, gapSize: 0.05, depthTest: false,
    });
    this.targetLine = new Line(geometry, this.targetMaterial);
    this.targetLine.frustumCulled = false;
    this.root.add(this.cursor, this.targetLine);
  }

  setTheme(theme: GameTheme): void {
    this.cursorMaterial.color.set(theme.aim.cursor);
    this.targetMaterial.color.set(theme.aim.line);
  }

  update(tip: Readonly<Point>, cursor: Readonly<Point>): void {
    this.cursor.position.set(cursor.x, cursor.y, 1);
    this.positions.setXYZ(0, tip.x, tip.y, 0.8);
    this.positions.setXYZ(1, cursor.x, cursor.y, 0.8);
    this.positions.needsUpdate = true;
    // Line.computeLineDistances() allocates a new attribute each call. The same distance, measured from the
    // float32 positions as three.js does, fits in this one reused attribute.
    const dx = this.positions.getX(1) - this.positions.getX(0);
    const dy = this.positions.getY(1) - this.positions.getY(0);
    this.distances.setX(1, Math.sqrt(dx * dx + dy * dy));
    this.distances.needsUpdate = true;
  }

  dispose(): void {
    for (const mesh of this.cursor.children as Mesh[]) mesh.geometry.dispose();
    this.cursorMaterial.dispose();
    this.targetLine.geometry.dispose();
    this.targetMaterial.dispose();
    this.root.clear();
  }
}

export const DEFAULT_AIM_MARKS: AimMarksFactory = (theme) => new RingAimMarks(theme);

export function createAimMarks(plugins: RuntimePlugins, theme: GameTheme): AimMarks {
  const factory = plugins.slot(AIM_MARKS, DEFAULT_AIM_MARKS);
  const plugin = plugins.owner(AIM_MARKS);
  let marks: unknown;
  try { marks = factory(theme); } catch (error) {
    throw new PluginError('plugin-failed', `Plugin "${plugin ?? 'engine'}" failed creating "${AIM_MARKS.id}".`, plugin, AIM_MARKS.id, { cause: error });
  }
  const root: unknown = typeof marks === 'object' && marks !== null ? Reflect.get(marks, 'root') : undefined;
  if (typeof root !== 'object' || root === null || Reflect.get(root, 'isObject3D') !== true ||
    typeof Reflect.get(marks as object, 'setTheme') !== 'function' || typeof Reflect.get(marks as object, 'update') !== 'function' ||
    typeof Reflect.get(marks as object, 'dispose') !== 'function') {
    throw new PluginError('invalid-contribution',
      `Plugin "${plugin ?? 'engine'}": aim marks must return a three.js root, setTheme(theme), update(tip, cursor) and dispose().`, plugin, AIM_MARKS.id);
  }
  return marks as AimMarks;
}
