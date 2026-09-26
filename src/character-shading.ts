import {
  BackSide, BufferAttribute, Color, DataTexture, Mesh, MeshBasicMaterial, MeshLambertMaterial, MeshPhongMaterial,
  MeshStandardMaterial, MeshToonMaterial, NearestFilter, RedFormat, SkinnedMesh, UnsignedByteType, Vector3,
} from 'three';
import type { BufferGeometry, Material, Object3D } from 'three';
import { DEFAULT_CHARACTER_SHADING } from './character-profile';
import type { CharacterShading } from './character-profile';

const GRADIENT_WIDTH = 256;
const OUTLINE_NORMAL = 'outlineNormal';
// Vertices closer than this share one outline direction, closing the hull at hard edges.
const OUTLINE_WELD = 1e-4;

interface ShadedMesh {
  readonly mesh: Mesh;
  readonly source: Material | Material[];
  hull: Mesh | null;
}

type LitMaterial = MeshStandardMaterial | MeshPhongMaterial | MeshLambertMaterial;

function lit(material: Material): material is LitMaterial {
  return material instanceof MeshStandardMaterial || material instanceof MeshPhongMaterial || material instanceof MeshLambertMaterial;
}

// Averages normals of coincident vertices once per geometry, so flat-shaded props keep a closed outline.
function outlineNormals(geometry: BufferGeometry): boolean {
  if (geometry.getAttribute(OUTLINE_NORMAL) !== undefined) return true;
  const position = geometry.getAttribute('position');
  const normal = geometry.getAttribute('normal');
  if (position === undefined || normal === undefined) return false;
  const sums = new Map<string, Vector3>();
  const keys: string[] = [];
  const vector = new Vector3();
  for (let index = 0; index < position.count; index++) {
    const key = `${Math.round(position.getX(index) / OUTLINE_WELD)},${Math.round(position.getY(index) / OUTLINE_WELD)},` +
      `${Math.round(position.getZ(index) / OUTLINE_WELD)}`;
    keys.push(key);
    let sum = sums.get(key);
    if (sum === undefined) {
      sum = new Vector3();
      sums.set(key, sum);
    }
    sum.add(vector.fromBufferAttribute(normal, index));
  }
  const values = new Float32Array(position.count * 3);
  for (let index = 0; index < position.count; index++) {
    const sum = sums.get(keys[index]!)!;
    if (sum.lengthSq() > 1e-12) vector.copy(sum).normalize();
    else vector.fromBufferAttribute(normal, index);
    values[index * 3] = vector.x;
    values[index * 3 + 1] = vector.y;
    values[index * 3 + 2] = vector.z;
  }
  geometry.setAttribute(OUTLINE_NORMAL, new BufferAttribute(values, 3));
  return true;
}

// Alpha-cut and translucent surfaces would outline their whole card, not their silhouette.
function outlines(material: Material | Material[]): boolean {
  return (Array.isArray(material) ? material : [material]).every(entry =>
    !entry.transparent && entry.alphaTest === 0 && !('alphaMap' in entry && entry.alphaMap !== null));
}

/**
 * Switches registered character meshes between their own (PBR) materials and cel twins with an
 * optional inverted-hull outline. Twins and hulls are built on first use, then only swapped: a
 * switch allocates no materials after the first one, and nothing runs per frame.
 */
export class CharacterShadingView {
  private readonly entries = new Map<Mesh, ShadedMesh>();
  private readonly roots = new Map<Object3D, readonly Mesh[]>();
  private readonly twins = new Map<Material, Material>();
  private readonly hulls = new WeakSet<Object3D>();
  private readonly gradient: DataTexture;
  private readonly outline: MeshBasicMaterial;
  private readonly outlineWidth = { value: DEFAULT_CHARACTER_SHADING.outline!.width };
  private shading: CharacterShading = DEFAULT_CHARACTER_SHADING;
  private active = false;
  private bands = 0;
  private materialsCreated = 0;
  private hullsCreated = 0;
  private switches = 0;
  private disposed = false;

  constructor() {
    this.gradient = new DataTexture(new Uint8Array(GRADIENT_WIDTH), GRADIENT_WIDTH, 1, RedFormat, UnsignedByteType);
    this.gradient.name = 'character-cel-gradient';
    this.gradient.minFilter = NearestFilter;
    this.gradient.magFilter = NearestFilter;
    this.gradient.generateMipmaps = false;
    this.setBands(DEFAULT_CHARACTER_SHADING.bands);
    this.outline = new MeshBasicMaterial({ color: new Color(DEFAULT_CHARACTER_SHADING.outline!.color), side: BackSide, toneMapped: false });
    this.outline.name = 'character-outline';
    this.outline.onBeforeCompile = (shader) => {
      shader.uniforms.outlineWidth = this.outlineWidth;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>
          uniform float outlineWidth;
          attribute vec3 ${OUTLINE_NORMAL};`)
        .replace('#include <project_vertex>', `#include <project_vertex>
          #ifdef USE_SKINNING
            vec3 outlineDirection = ( skinMatrix * vec4( ${OUTLINE_NORMAL}, 0.0 ) ).xyz;
          #else
            vec3 outlineDirection = ${OUTLINE_NORMAL};
          #endif
          // View-space extrusion keeps a constant world width under the orthographic camera, even
          // for scaled models, and follows the skinned surface.
          mvPosition.xyz += normalize( normalMatrix * outlineDirection ) * outlineWidth;
          gl_Position = projectionMatrix * mvPosition;`);
    };
    this.outline.customProgramCacheKey = () => 'character-outline';
  }

  // Registers every mesh under `root`; each is shown in the current look immediately.
  register(root: Object3D): void {
    if (this.disposed || this.roots.has(root)) return;
    const meshes: Mesh[] = [];
    root.traverse((object) => {
      if (!(object instanceof Mesh) || this.hulls.has(object)) return;
      const mesh = object;
      if (this.entries.has(mesh)) return;
      this.entries.set(mesh, { mesh, source: mesh.material, hull: null });
      meshes.push(mesh);
    });
    this.roots.set(root, meshes);
    for (const mesh of meshes) this.show(this.entries.get(mesh)!);
  }

  // Restores the original materials and releases twins no other mesh uses.
  unregister(root: Object3D): void {
    const meshes = this.roots.get(root);
    if (meshes === undefined) return;
    this.roots.delete(root);
    for (const mesh of meshes) {
      const entry = this.entries.get(mesh);
      if (entry === undefined) continue;
      this.entries.delete(mesh);
      mesh.material = entry.source;
      entry.hull?.removeFromParent();
      for (const source of Array.isArray(entry.source) ? entry.source : [entry.source]) this.release(source);
    }
  }

  // `active` is false outside Avatar mode, where every registered mesh keeps its own material.
  apply(shading: CharacterShading, active: boolean): void {
    if (this.disposed) return;
    const changedLook = active !== this.active || shading.mode !== this.shading.mode;
    this.shading = shading;
    this.active = active;
    if (changedLook) this.switches++;
    if (shading.bands !== this.bands) this.setBands(shading.bands);
    if (shading.outline !== null) {
      this.outline.color.set(shading.outline.color);
      this.outlineWidth.value = shading.outline.width;
    }
    for (const entry of this.entries.values()) this.show(entry);
  }

  inspect() {
    const cel = this.active && this.shading.mode === 'cel';
    let hullsVisible = 0;
    let skinnedHulls = 0;
    let sharedSkeletons = true;
    for (const entry of this.entries.values()) {
      if (entry.hull?.visible && entry.hull.parent === entry.mesh) hullsVisible++;
      if (entry.hull instanceof SkinnedMesh) {
        skinnedHulls++;
        if (!(entry.mesh instanceof SkinnedMesh) || entry.hull.skeleton !== entry.mesh.skeleton) sharedSkeletons = false;
      }
    }
    return {
      mode: cel ? 'cel' as const : 'pbr' as const,
      requested: { ...this.shading, outline: this.shading.outline === null ? null : { ...this.shading.outline } },
      active: this.active,
      meshes: this.entries.size,
      twins: this.twins.size,
      materialsCreated: this.materialsCreated,
      hullsCreated: this.hullsCreated,
      hullsVisible,
      skinnedHulls,
      sharedSkeletons,
      switches: this.switches,
      outlineMaterialId: this.outline.uuid,
      gradientTextureId: this.gradient.uuid,
    };
  }

  dispose(): void {
    if (this.disposed) return;
    for (const root of [...this.roots.keys()]) this.unregister(root);
    for (const twin of this.twins.values()) twin.dispose();
    this.twins.clear();
    this.outline.dispose();
    this.gradient.dispose();
    this.disposed = true;
  }

  private show(entry: ShadedMesh): void {
    const cel = this.active && this.shading.mode === 'cel';
    const target = cel ? this.twinOf(entry.source) : entry.source;
    if (entry.mesh.material !== target) entry.mesh.material = target;
    const outlined = cel && this.shading.outline !== null && outlines(entry.source) && outlineNormals(entry.mesh.geometry);
    if (outlined && entry.hull === null) entry.hull = this.createHull(entry.mesh);
    if (entry.hull !== null) entry.hull.visible = outlined;
  }

  private twinOf(source: Material | Material[]): Material | Material[] {
    if (Array.isArray(source)) return source.map(material => this.twinOf(material) as Material);
    if (!lit(source)) return source;
    let twin = this.twins.get(source);
    if (twin === undefined) {
      twin = this.createTwin(source);
      this.twins.set(source, twin);
    }
    return twin;
  }

  private release(source: Material): void {
    const twin = this.twins.get(source);
    if (twin === undefined) return;
    const users = [...this.entries.values()].some(entry =>
      (Array.isArray(entry.source) ? entry.source : [entry.source]).includes(source));
    if (users) return;
    twin.dispose();
    this.twins.delete(source);
  }

  private createTwin(source: LitMaterial): MeshToonMaterial {
    const standard = source instanceof MeshStandardMaterial ? source : null;
    const twin = new MeshToonMaterial({
      name: `${source.name || 'character'}:cel`,
      color: source.color,
      map: source.map,
      gradientMap: this.gradient,
      lightMap: source.lightMap,
      lightMapIntensity: source.lightMapIntensity,
      aoMap: source.aoMap,
      aoMapIntensity: source.aoMapIntensity,
      emissive: source.emissive,
      emissiveIntensity: source.emissiveIntensity,
      emissiveMap: source.emissiveMap,
      bumpMap: source.bumpMap,
      bumpScale: source.bumpScale,
      normalMap: source.normalMap,
      normalMapType: source.normalMapType,
      normalScale: source.normalScale,
      displacementMap: standard?.displacementMap ?? null,
      displacementScale: standard?.displacementScale ?? 1,
      displacementBias: standard?.displacementBias ?? 0,
      alphaMap: source.alphaMap,
      alphaTest: source.alphaTest,
      alphaHash: source.alphaHash,
      transparent: source.transparent,
      opacity: source.opacity,
      side: source.side,
      vertexColors: source.vertexColors,
      depthTest: source.depthTest,
      depthWrite: source.depthWrite,
      fog: source.fog,
    });
    this.materialsCreated++;
    return twin;
  }

  private createHull(mesh: Mesh): Mesh {
    let hull: Mesh;
    if (mesh instanceof SkinnedMesh) {
      // Sharing the skeleton keeps the outline on the deforming surface during IK.
      const skinned = new SkinnedMesh(mesh.geometry, this.outline);
      skinned.bind(mesh.skeleton, mesh.bindMatrix);
      skinned.bindMode = mesh.bindMode;
      hull = skinned;
    } else {
      hull = new Mesh(mesh.geometry, this.outline);
    }
    hull.name = `${mesh.name || 'mesh'}:outline`;
    hull.frustumCulled = mesh.frustumCulled;
    hull.morphTargetInfluences = mesh.morphTargetInfluences;
    hull.morphTargetDictionary = mesh.morphTargetDictionary;
    hull.raycast = () => {};
    this.hulls.add(hull);
    this.hullsCreated++;
    mesh.add(hull);
    return hull;
  }

  private setBands(bands: number): void {
    const data = this.gradient.image.data as Uint8Array;
    for (let texel = 0; texel < GRADIENT_WIDTH; texel++) {
      const band = Math.min(bands - 1, Math.floor(texel * bands / GRADIENT_WIDTH));
      data[texel] = Math.round(255 * band / (bands - 1));
    }
    this.gradient.needsUpdate = true;
    this.bands = bands;
  }
}
