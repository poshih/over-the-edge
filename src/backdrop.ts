import { CircleGeometry, ExtrudeGeometry, Group, Mesh, MeshBasicMaterial, Shape } from 'three';
import type { Object3D } from 'three';
import type { Point } from './config';
import { createInstance, instanceContract, slotPoint } from './plugins/kernel';
import type { Attributed } from './plugins/kernel';
import type { RuntimePlugins } from './plugins/runtime';
import type { GameTheme } from './theme';

export interface Backdrop {
  // Drawn first in the course pass, behind the actors. Scenery never collides. Hide the root when nothing shows,
  // so the view can skip the backdrop's render.
  readonly root: Object3D;
  setTheme(theme: GameTheme): void;
  // The camera's current aim on the obstacle line, reused and read-only.
  follow(camera: Readonly<Point>): void;
  dispose(): void;
}

export type BackdropFactory = (theme: GameTheme) => Backdrop;

function backdropFactory(value: unknown): BackdropFactory {
  if (typeof value !== 'function') throw new TypeError('A backdrop must be a factory.');
  return value as BackdropFactory;
}

export const BACKDROP = slotPoint('scene.backdrop', 'runtime', backdropFactory);

function polygonShape(vertices: readonly Point[]): Shape {
  const shape = new Shape();
  shape.moveTo(vertices[0].x, vertices[0].y);
  for (const vertex of vertices.slice(1)) shape.lineTo(vertex.x, vertex.y);
  shape.closePath();
  return shape;
}

class SceneryBackdrop implements Backdrop {
  readonly root = new Group();
  private readonly mountains: Mesh<ExtrudeGeometry, MeshBasicMaterial>[] = [];
  private readonly sunDisc: Mesh<CircleGeometry, MeshBasicMaterial>;

  constructor(theme: GameTheme) {
    this.root.visible = theme.backdrop.visible || theme.sunDisc.visible;
    this.sunDisc = new Mesh(new CircleGeometry(1.8, 48), new MeshBasicMaterial({ color: theme.sunDisc.color, fog: false }));
    const { backdrop } = theme;
    const layers = [
      { color: backdrop.far, z: -24, base: -5, height: 14 },
      { color: backdrop.middle, z: -16, base: -6, height: 11 },
      { color: backdrop.near, z: -10, base: -8, height: 9 },
    ];
    for (const [layerIndex, layer] of layers.entries()) {
      const vertices: Point[] = [{ x: -70, y: layer.base }, { x: 70, y: layer.base }];
      for (let index = 20; index >= 0; index--) {
        vertices.push({
          x: -70 + index * 7,
          y: layer.base + layer.height * (0.55 + 0.23 * Math.sin(index * 1.7 + layerIndex) + 0.22 * Math.cos(index * 0.71)),
        });
      }
      const mountains = new Mesh(new ExtrudeGeometry(polygonShape(vertices), { depth: 0.1, bevelEnabled: false }),
        new MeshBasicMaterial({ color: layer.color }));
      mountains.position.z = layer.z;
      mountains.visible = backdrop.visible;
      this.mountains.push(mountains);
      this.root.add(mountains);
    }
    this.sunDisc.position.set(-4.2, 8, -35);
    this.sunDisc.visible = theme.sunDisc.visible;
    this.root.add(this.sunDisc);
  }

  setTheme(theme: GameTheme): void {
    this.root.visible = theme.backdrop.visible || theme.sunDisc.visible;
    this.sunDisc.visible = theme.sunDisc.visible;
    this.sunDisc.material.color.set(theme.sunDisc.color);
    const colors = [theme.backdrop.far, theme.backdrop.middle, theme.backdrop.near];
    for (const [index, mountains] of this.mountains.entries()) {
      mountains.visible = theme.backdrop.visible;
      mountains.material.color.set(colors[index]!);
    }
  }

  follow(camera: Readonly<Point>): void {
    this.root.position.x = camera.x * 0.6;
    this.root.position.y = camera.y * 0.25;
  }

  dispose(): void {
    for (const mountains of this.mountains) {
      mountains.geometry.dispose();
      mountains.material.dispose();
    }
    this.sunDisc.geometry.dispose();
    this.sunDisc.material.dispose();
    this.root.clear();
  }
}

export const DEFAULT_BACKDROP: BackdropFactory = (theme) => new SceneryBackdrop(theme);

const BACKDROP_CONTRACT = instanceContract({
  returns: 'a three.js root, setTheme(theme), follow(camera) and dispose()',
  methods: ['setTheme', 'follow', 'dispose'],
  root: true,
});

export function createBackdrop(plugins: RuntimePlugins, theme: GameTheme): Attributed<Backdrop> {
  const factory = plugins.slot(BACKDROP, DEFAULT_BACKDROP);
  const create = factory.value;
  return createInstance(BACKDROP_CONTRACT, factory, () => create(theme));
}
