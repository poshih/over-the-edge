import { BufferGeometry, Mesh, SkinnedMesh } from 'three';
import type { Object3D } from 'three';
import { ARM_LAYER } from './arm-layer';
import type { AvatarJointId } from './character-profile';

// The mapped joints whose skin is the arms; joints that follow them, such as fingers, count as theirs.
const ARM_JOINTS: ReadonlySet<AvatarJointId> = new Set([
  'left-upper-arm', 'left-forearm', 'left-hand', 'right-upper-arm', 'right-forearm', 'right-hand',
]);
// A vertex is the arms' when more than half its skinning is; a triangle when at least two of its vertices are.
const ARM_SHARE = 0.5;

interface SplitMesh {
  readonly mesh: SkinnedMesh;
  readonly source: BufferGeometry;
  readonly body: BufferGeometry;
  readonly arms: SkinnedMesh;
}

interface MovedMesh {
  readonly mesh: Mesh;
  readonly mask: number;
}

interface Part {
  readonly materialIndex: number;
  readonly indices: number[];
}

// The mapped joint `object` follows: itself, or its nearest mapped ancestor; null above the mapped joints.
function followedJoint(object: Object3D, joints: ReadonlyMap<Object3D, AvatarJointId>): AvatarJointId | null {
  for (let node: Object3D | null = object; node !== null; node = node.parent) {
    const joint = joints.get(node);
    if (joint !== undefined) return joint;
  }
  return null;
}

function isArm(object: Object3D, joints: ReadonlyMap<Object3D, AvatarJointId>): boolean {
  const joint = followedJoint(object, joints);
  return joint !== null && ARM_JOINTS.has(joint);
}

// A geometry drawing `parts` of `source`'s triangles. It shares the source's vertex buffers, which stay the model's,
// and its morph targets only if they move one of its vertices: each geometry carrying them keeps its own morph texture.
function subset(source: BufferGeometry, parts: readonly Part[], name: string): BufferGeometry {
  const geometry = new BufferGeometry();
  geometry.name = name;
  for (const [attribute, buffer] of Object.entries(source.attributes)) geometry.setAttribute(attribute, buffer);
  if (morphsMove(source, parts)) {
    geometry.morphAttributes = source.morphAttributes;
    geometry.morphTargetsRelative = source.morphTargetsRelative;
  }
  const indices: number[] = [];
  for (const part of parts) {
    if (part.indices.length === 0) continue;
    if (source.groups.length > 0) geometry.addGroup(indices.length, part.indices.length, part.materialIndex);
    for (const index of part.indices) indices.push(index);
  }
  geometry.setIndex(indices);
  return geometry;
}

// Whether any of `source`'s morph targets moves a vertex of `parts`: a relative target by a nonzero delta, an
// absolute one by differing from the base attribute.
function morphsMove(source: BufferGeometry, parts: readonly Part[]): boolean {
  const targets = Object.entries(source.morphAttributes).filter(([, attributes]) => attributes.length > 0);
  if (targets.length === 0) return false;
  const used = new Set<number>();
  for (const part of parts) for (const index of part.indices) used.add(index);
  for (const [name, attributes] of targets) {
    const base = source.getAttribute(name);
    for (const attribute of attributes) {
      for (const vertex of used) {
        for (let component = 0; component < attribute.itemSize; component++) {
          const value = attribute.getComponent(vertex, component);
          const rest = source.morphTargetsRelative || base === undefined ? 0 : base.getComponent(vertex, component);
          if (value !== rest) return true;
        }
      }
    }
  }
  return false;
}

// Frees what a subset owns, its index and anything added to it since, but never the model's shared buffers.
function release(geometry: BufferGeometry, source: BufferGeometry): void {
  for (const attribute of Object.keys(geometry.attributes)) {
    if (geometry.getAttribute(attribute) === source.getAttribute(attribute)) geometry.deleteAttribute(attribute);
  }
  geometry.dispose();
}

/**
 * Moves an imported avatar's arm surfaces to the arms' render layer, so they draw over its body (see ARM_LAYER).
 * A skinned mesh's triangles skinned mostly to the arm joints, or to joints that follow them, move to a child mesh
 * on the same skeleton and materials that shares the mesh's vertex buffers; the mesh keeps the rest. A mesh that is
 * all arm, or a rigid mesh following an arm joint, moves whole. Done once, when the view is built; `restore` puts
 * the model back exactly as it was, so the next view of it starts from the model itself.
 */
export class AvatarArmSplit {
  readonly triangles: number;
  private readonly split: SplitMesh[] = [];
  private readonly moved: MovedMesh[] = [];

  constructor(scene: Object3D, joints: ReadonlyMap<Object3D, AvatarJointId>) {
    const meshes: Mesh[] = [];
    scene.traverse((object) => { if (object instanceof Mesh) meshes.push(object); });
    let triangles = 0;
    for (const mesh of meshes) {
      if (!(mesh instanceof SkinnedMesh)) {
        if (isArm(mesh, joints)) {
          triangles += triangleCount(mesh.geometry);
          this.move(mesh);
        }
        continue;
      }
      const parts = partition(mesh, joints);
      if (parts === null) continue;
      const armTriangles = parts.arms.reduce((sum, part) => sum + part.indices.length / 3, 0);
      if (armTriangles === 0) continue;
      triangles += armTriangles;
      if (parts.body.every((part) => part.indices.length === 0)) {
        this.move(mesh);
        continue;
      }
      const source = mesh.geometry;
      const body = subset(source, parts.body, source.name);
      const arms = new SkinnedMesh(subset(source, parts.arms, `${source.name || 'surface'}:arms`), mesh.material);
      arms.name = `${mesh.name || 'mesh'}:arms`;
      arms.bind(mesh.skeleton, mesh.bindMatrix);
      arms.bindMode = mesh.bindMode;
      arms.frustumCulled = mesh.frustumCulled;
      arms.castShadow = mesh.castShadow;
      arms.receiveShadow = mesh.receiveShadow;
      arms.renderOrder = mesh.renderOrder;
      if (Object.keys(arms.geometry.morphAttributes).length > 0) {
        arms.morphTargetInfluences = mesh.morphTargetInfluences;
        arms.morphTargetDictionary = mesh.morphTargetDictionary;
      }
      arms.layers.set(ARM_LAYER);
      mesh.geometry = body;
      // A child with no transform of its own, so it moves exactly like the mesh it came from.
      mesh.add(arms);
      this.split.push({ mesh, source, body, arms });
    }
    this.triangles = triangles;
  }

  restore(): void {
    for (const { mesh, source, body, arms } of this.split) {
      arms.removeFromParent();
      if (mesh.geometry === body) mesh.geometry = source;
      release(body, source);
      release(arms.geometry, source);
    }
    this.split.length = 0;
    for (const { mesh, mask } of this.moved) mesh.layers.mask = mask;
    this.moved.length = 0;
  }

  private move(mesh: Mesh): void {
    this.moved.push({ mesh, mask: mesh.layers.mask });
    mesh.layers.set(ARM_LAYER);
  }
}

// A skinned mesh's triangles by material group, sorted into arms and body; null when it has no skin to read.
function partition(mesh: SkinnedMesh, joints: ReadonlyMap<Object3D, AvatarJointId>): { arms: Part[]; body: Part[] } | null {
  const geometry = mesh.geometry;
  const skinIndex = geometry.getAttribute('skinIndex');
  const skinWeight = geometry.getAttribute('skinWeight');
  const position = geometry.getAttribute('position');
  if (skinIndex === undefined || skinWeight === undefined || position === undefined) return null;
  const armBones = mesh.skeleton.bones.map((bone) => isArm(bone, joints));
  if (!armBones.includes(true)) return { arms: [], body: [] };
  const armVertices = new Uint8Array(position.count);
  for (let vertex = 0; vertex < position.count; vertex++) {
    let total = 0;
    let arm = 0;
    for (let component = 0; component < skinWeight.itemSize; component++) {
      const weight = skinWeight.getComponent(vertex, component);
      total += weight;
      if (weight > 0 && armBones[skinIndex.getComponent(vertex, component)] === true) arm += weight;
    }
    armVertices[vertex] = total > 0 && arm > total * ARM_SHARE ? 1 : 0;
  }
  const index = geometry.getIndex();
  const vertexAt = (corner: number): number => index === null ? corner : index.getX(corner);
  const corners = index === null ? position.count : index.count;
  const groups = geometry.groups.length > 0 ? geometry.groups : [{ start: 0, count: corners, materialIndex: 0 }];
  const arms: Part[] = [];
  const body: Part[] = [];
  for (const group of groups) {
    const armPart: Part = { materialIndex: group.materialIndex ?? 0, indices: [] };
    const bodyPart: Part = { materialIndex: group.materialIndex ?? 0, indices: [] };
    const end = Math.min(corners, group.start + group.count);
    for (let corner = group.start; corner + 2 < end; corner += 3) {
      const a = vertexAt(corner);
      const b = vertexAt(corner + 1);
      const c = vertexAt(corner + 2);
      const part = armVertices[a]! + armVertices[b]! + armVertices[c]! >= 2 ? armPart : bodyPart;
      part.indices.push(a, b, c);
    }
    arms.push(armPart);
    body.push(bodyPart);
  }
  return { arms, body };
}

function triangleCount(geometry: BufferGeometry): number {
  return (geometry.getIndex()?.count ?? geometry.getAttribute('position')?.count ?? 0) / 3;
}
