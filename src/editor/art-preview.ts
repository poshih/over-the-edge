import {
  AmbientLight, DirectionalLight, Mesh, MeshStandardMaterial, OrthographicCamera, Scene, Vector3, WebGLRenderer,
} from 'three';
import { ArtError } from '../art-types';
import type { TerrainObject } from '../level';
import { terrainGeometry } from '../terrain-geometry';
import { loadVisualModel } from '../visual-model';
import type { LoadedVisual } from '../visual-model';

export async function terrainGuide(object: TerrainObject): Promise<Blob> {
  const geometry = terrainGeometry(object.shape);
  const material = new MeshStandardMaterial({ color: object.color, roughness: 0.95 });
  const mesh = new Mesh(geometry, material);
  mesh.scale.set(object.width, object.height, object.depth);
  mesh.name = 'terrain-guide';
  try {
    const { GLTFExporter } = await import('three/addons/exporters/GLTFExporter.js');
    const data = await new GLTFExporter().parseAsync(mesh, { binary: true });
    if (!(data instanceof ArrayBuffer)) throw new ArtError('The terrain guide could not be exported as a GLB.');
    return new Blob([data], { type: 'model/gltf-binary' });
  } finally { geometry.dispose(); material.dispose(); }
}

export class ArtPreview {
  private readonly canvas: HTMLCanvasElement;
  private renderer: WebGLRenderer | null = null;
  private model: LoadedVisual | null = null;
  private revision = 0;
  private disposed = false;

  constructor(canvas: HTMLCanvasElement) { this.canvas = canvas; }

  async show(blob: Blob): Promise<void> {
    const revision = ++this.revision;
    const model = await loadVisualModel(blob);
    if (this.disposed || revision !== this.revision) { model.dispose(); return; }
    this.model?.dispose();
    this.model = model;
    this.renderer ??= new WebGLRenderer({ canvas: this.canvas, antialias: true, alpha: false });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.setSize(320, 200, false);
    this.renderer.setClearColor(0xd8e3d6);
    const scene = new Scene();
    scene.add(model.scene, new AmbientLight(0xffffff, 2));
    const light = new DirectionalLight(0xfff2d9, 3);
    light.position.set(-3, 5, 8); scene.add(light);
    const size = model.bounds.getSize(new Vector3());
    const span = Math.max(size.x / 1.6, size.y, size.z) * 1.25;
    const center = model.bounds.getCenter(new Vector3());
    const camera = new OrthographicCamera(-span * 0.8, span * 0.8, span / 2, -span / 2, 0.001, span * 20);
    camera.position.set(center.x, center.y, model.bounds.max.z + span * 3);
    camera.lookAt(center);
    this.renderer.render(scene, camera);
    this.canvas.hidden = false;
  }

  dispose(): void {
    this.disposed = true; this.revision++;
    this.model?.dispose(); this.renderer?.dispose();
  }
}
