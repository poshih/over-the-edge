// Generated GLB fixtures for character verification: a Mixamo-named, GPU-skinned humanoid and
// static hammer and pot models. Everything is procedural, so no third-party artwork is involved.
import { BoxGeometry, CylinderGeometry, Euler, LatheGeometry, Matrix4, Quaternion, Vector2, Vector3 } from 'three';

const DEGREES = Math.PI / 180;
const ARM_LENGTHS = { upper: 0.82, forearm: 0.82 };
const SHOULDER = { x: 0.17, y: 1.42 };

// World bind pose in metres for a model facing +Z, so the anatomical left arm is at +X.
// Rotations follow Mixamo: arm and leg joints point their local +Y along the bone.
function humanoidJoints(lengths) {
  const arm = (side, sign) => {
    const rotation = [0, 0, -90 * sign];
    return [
      { name: `${side}Shoulder`, parent: 'Spine2', position: [0.06 * sign, SHOULDER.y, 0], rotation },
      { name: `${side}Arm`, parent: `${side}Shoulder`, position: [SHOULDER.x * sign, SHOULDER.y, 0], rotation },
      { name: `${side}ForeArm`, parent: `${side}Arm`, position: [(SHOULDER.x + lengths.upper) * sign, SHOULDER.y, 0], rotation },
      { name: `${side}Hand`, parent: `${side}ForeArm`, position: [(SHOULDER.x + lengths.upper + lengths.forearm) * sign, SHOULDER.y, 0], rotation },
      { name: `${side}HandIndex1`, parent: `${side}Hand`, position: [(SHOULDER.x + lengths.upper + lengths.forearm + 0.1) * sign, SHOULDER.y, 0.02], rotation },
    ];
  };
  const leg = (side, sign) => [
    { name: `${side}UpLeg`, parent: 'Hips', position: [0.09 * sign, 0.96, 0], rotation: [0, 0, 180] },
    { name: `${side}Leg`, parent: `${side}UpLeg`, position: [0.09 * sign, 0.74, 0], rotation: [0, 0, 180] },
  ];
  return [
    { name: 'Hips', parent: null, position: [0, 1.0, 0], rotation: [0, 0, 0] },
    { name: 'Spine', parent: 'Hips', position: [0, 1.1, 0], rotation: [0, 0, 0] },
    { name: 'Spine1', parent: 'Spine', position: [0, 1.2, 0], rotation: [0, 0, 0] },
    { name: 'Spine2', parent: 'Spine1', position: [0, 1.3, 0], rotation: [0, 0, 0] },
    { name: 'Neck', parent: 'Spine2', position: [0, 1.46, 0], rotation: [0, 0, 0] },
    { name: 'Head', parent: 'Neck', position: [0, 1.54, 0], rotation: [0, 0, 0] },
    { name: 'HeadTop_End', parent: 'Head', position: [0, 1.78, 0], rotation: [0, 0, 0] },
    ...arm('Left', 1), ...arm('Right', -1), ...leg('Left', 1), ...leg('Right', -1),
  ];
}

// Screen-side bone map for the fixture: its anatomical right arm is on the viewer's left.
export function humanoidBoneMap(prefix = '') {
  return Object.freeze(Object.fromEntries(Object.entries({
    body: 'Hips', head: 'Head',
    'left-upper-arm': 'RightArm', 'left-forearm': 'RightForeArm', 'left-hand': 'RightHand',
    'right-upper-arm': 'LeftArm', 'right-forearm': 'LeftForeArm', 'right-hand': 'LeftHand',
  }).map(([joint, name]) => [joint, `${prefix}${name}`])));
}

export const HUMANOID_BONE_MAP = humanoidBoneMap();

export const HUMANOID_ARM = Object.freeze({ ...ARM_LENGTHS, shoulderSpan: SHOULDER.x * 2 });

function bindMatrix(joint) {
  const rotation = new Quaternion().setFromEuler(new Euler(...joint.rotation.map(angle => angle * DEGREES)));
  return new Matrix4().compose(new Vector3(...joint.position), rotation, new Vector3(1, 1, 1));
}

class GlbBuilder {
  constructor() {
    this.chunks = [];
    this.offset = 0;
    this.bufferViews = [];
    this.accessors = [];
  }

  view(bytes) {
    const index = this.bufferViews.length;
    this.bufferViews.push({ buffer: 0, byteOffset: this.offset, byteLength: bytes.length });
    const padding = Buffer.alloc((4 - bytes.length % 4) % 4);
    this.chunks.push(bytes, padding);
    this.offset += bytes.length + padding.length;
    return index;
  }

  accessor(array, type, componentType, extra = {}) {
    const bytes = Buffer.from(array.buffer, array.byteOffset, array.byteLength);
    const components = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 }[type];
    this.accessors.push({ bufferView: this.view(bytes), componentType, count: array.length / components, type, ...extra });
    return this.accessors.length - 1;
  }

  write(json) {
    const binary = Buffer.concat(this.chunks);
    const document = { ...json, bufferViews: this.bufferViews, accessors: this.accessors, buffers: [{ byteLength: binary.length }] };
    const text = Buffer.from(JSON.stringify(document));
    const description = Buffer.concat([text, Buffer.alloc((4 - text.length % 4) % 4, 0x20)]);
    const glb = Buffer.alloc(12 + 8 + description.length + 8 + binary.length);
    glb.writeUInt32LE(0x46546c67, 0);
    glb.writeUInt32LE(2, 4);
    glb.writeUInt32LE(glb.length, 8);
    glb.writeUInt32LE(description.length, 12);
    glb.writeUInt32LE(0x4e4f534a, 16);
    description.copy(glb, 20);
    const start = 20 + description.length;
    glb.writeUInt32LE(binary.length, start);
    glb.writeUInt32LE(0x004e4942, start + 4);
    binary.copy(glb, start + 8);
    return glb;
  }
}

function positionBounds(positions) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let index = 0; index < positions.length; index += 3) {
    for (let axis = 0; axis < 3; axis++) {
      min[axis] = Math.min(min[axis], positions[index + axis]);
      max[axis] = Math.max(max[axis], positions[index + axis]);
    }
  }
  return { min, max };
}

// A box around a bone from `from` to `to`, weighted to `joint` and blended into `next` near its end.
function boneBox(from, to, thickness, joint, next, segments = 4) {
  const start = new Vector3(...from);
  const end = new Vector3(...to);
  const length = start.distanceTo(end);
  const geometry = new BoxGeometry(thickness, length, thickness * 0.9, 1, segments, 1);
  geometry.translate(0, length / 2, 0);
  const direction = end.clone().sub(start).normalize();
  const orient = new Matrix4().makeRotationFromQuaternion(new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), direction));
  const positions = geometry.getAttribute('position');
  const joints = [];
  const weights = [];
  for (let index = 0; index < positions.count; index++) {
    const along = positions.getY(index) / length;
    const blend = next === null ? 0 : Math.max(0, Math.min(1, (along - 0.75) / 0.25)) * 0.5;
    joints.push(joint, next ?? 0, 0, 0);
    weights.push(1 - blend, blend, 0, 0);
  }
  geometry.applyMatrix4(orient.setPosition(start));
  return { geometry, joints, weights };
}

// Options produce the invalid variants used by typed-error checks. `prefix` names joints like
// "mixamorig:Hips"; `armScale` shortens the arms so that grips become unreachable; `posed` stores a
// bent elbow in the node hierarchy while the inverse bind matrices keep the T-pose.
export function skinnedAvatarGlb(options = {}) {
  const lengths = { upper: ARM_LENGTHS.upper * (options.armScale ?? 1), forearm: ARM_LENGTHS.forearm * (options.armScale ?? 1) };
  const joints = humanoidJoints(lengths);
  const byName = new Map(joints.map((joint, index) => [joint.name, index]));
  const lookup = name => {
    const index = joints.findIndex(joint => joint.name === name);
    if (index < 0) throw new Error(`Unknown fixture joint ${name}`);
    return index;
  };
  const world = joints.map(bindMatrix);
  const parts = [];
  const part = (material, from, to, thickness, joint, next) => parts.push({ material, ...boneBox(from, to, thickness, lookup(joint), next === null ? null : lookup(next)) });
  part('cloth', [0, 0.98, 0], [0, 1.46, 0], 0.3, 'Spine1', 'Spine2');
  part('skin', [0, 1.46, 0], [0, 1.54, 0], 0.09, 'Neck', 'Head');
  part('skin', [0, 1.54, 0], [0, 1.78, 0], 0.22, 'Head', null);
  for (const [side, sign] of [['Left', 1], ['Right', -1]]) {
    const x = offset => (SHOULDER.x + offset) * sign;
    part('cloth', [0.06 * sign, SHOULDER.y, 0], [x(0), SHOULDER.y, 0], 0.14, `${side}Shoulder`, `${side}Arm`);
    part('cloth', [x(0), SHOULDER.y, 0], [x(lengths.upper), SHOULDER.y, 0], 0.13, `${side}Arm`, `${side}ForeArm`);
    part('cloth', [x(lengths.upper), SHOULDER.y, 0], [x(lengths.upper + lengths.forearm), SHOULDER.y, 0], 0.11, `${side}ForeArm`, `${side}Hand`);
    part('skin', [x(lengths.upper + lengths.forearm), SHOULDER.y, 0], [x(lengths.upper + lengths.forearm + 0.16), SHOULDER.y, 0], 0.12, `${side}Hand`, `${side}HandIndex1`);
    part('cloth', [0.09 * sign, 0.96, 0], [0.09 * sign, 0.74, 0], 0.16, `${side}UpLeg`, `${side}Leg`);
    part('cloth', [0.09 * sign, 0.74, 0], [0.09 * sign, 0.6, 0], 0.14, `${side}Leg`, null);
  }
  const builder = new GlbBuilder();
  const primitives = [];
  for (const [materialIndex, material] of ['cloth', 'skin'].entries()) {
    const group = parts.filter(entry => entry.material === material);
    const positions = [], normals = [], jointData = [], weightData = [], indices = [];
    for (const entry of group) {
      const base = positions.length / 3;
      positions.push(...entry.geometry.getAttribute('position').array);
      normals.push(...entry.geometry.getAttribute('normal').array);
      jointData.push(...entry.joints);
      weightData.push(...entry.weights);
      indices.push(...Array.from(entry.geometry.index.array, index => index + base));
      entry.geometry.dispose();
    }
    if (options.unnormalized && materialIndex === 0) for (let component = 0; component < 4; component++) weightData[component] *= 0.5;
    const attributes = {
      POSITION: builder.accessor(new Float32Array(positions), 'VEC3', 5126, positionBounds(positions)),
      NORMAL: builder.accessor(new Float32Array(normals), 'VEC3', 5126),
      JOINTS_0: builder.accessor(new Uint8Array(jointData), 'VEC4', 5121),
      WEIGHTS_0: builder.accessor(new Float32Array(weightData), 'VEC4', 5126),
    };
    if (options.extraInfluences) {
      attributes.JOINTS_1 = builder.accessor(new Uint8Array(jointData.length), 'VEC4', 5121);
      attributes.WEIGHTS_1 = builder.accessor(new Float32Array(weightData.length), 'VEC4', 5126);
    }
    primitives.push({ attributes, indices: builder.accessor(new Uint16Array(indices), 'SCALAR', 5123), material: materialIndex });
  }
  const inverse = new Float32Array(joints.length * 16);
  world.forEach((matrix, index) => inverse.set(matrix.clone().invert().elements, index * 16));
  const inverseBindMatrices = builder.accessor(inverse, 'MAT4', 5126);
  // Joints live under an "Armature" node that stores centimetres, as many exporters do.
  const armatureScale = 0.01;
  const armature = new Matrix4().makeScale(armatureScale, armatureScale, armatureScale);
  const nodes = joints.map((joint, index) => {
    const parentWorld = joint.parent === null ? armature : world[byName.get(joint.parent)];
    const local = parentWorld.clone().invert().multiply(world[index]);
    const translation = new Vector3();
    const rotation = new Quaternion();
    const scale = new Vector3();
    local.decompose(translation, rotation, scale);
    if (options.posed && joint.name === 'LeftForeArm') rotation.multiply(new Quaternion().setFromEuler(new Euler(0, 0, 40 * DEGREES)));
    return {
      // A duplicated joint name makes name-based bone maps ambiguous.
      name: `${options.prefix ?? ''}${options.duplicateName !== undefined && joint.name === 'Spine1' ? options.duplicateName : joint.name}`,
      translation: translation.toArray().map(value => Math.round(value * 1e6) / 1e6),
      rotation: rotation.toArray(),
    };
  });
  joints.forEach((joint, index) => {
    if (joint.parent === null) return;
    const parent = nodes[byName.get(joint.parent)];
    (parent.children ??= []).push(index);
  });
  const armatureIndex = nodes.length;
  nodes.push({ name: 'Armature', scale: [armatureScale, armatureScale, armatureScale], children: [lookup('Hips')] });
  const meshIndex = nodes.length;
  nodes.push({ name: 'Body', mesh: 0, skin: 0 });
  for (let index = 0; index < (options.extraNodes ?? 0); index++) nodes.push({ name: `Extra${index}` });
  const extras = Array.from({ length: options.extraNodes ?? 0 }, (_, index) => meshIndex + 1 + index);
  const json = {
    asset: { version: '2.0', generator: 'Over the Edge character fixture' },
    scene: 0,
    scenes: [{ nodes: [armatureIndex, meshIndex, ...extras] }],
    nodes,
    meshes: [{ name: 'Body', primitives }],
    materials: [
      { name: 'Cloth', pbrMetallicRoughness: { baseColorFactor: [0.18, 0.42, 0.62, 1], metallicFactor: 0, roughnessFactor: 0.7 } },
      { name: 'Skin', pbrMetallicRoughness: { baseColorFactor: [0.86, 0.6, 0.45, 1], metallicFactor: 0, roughnessFactor: 0.6 } },
    ],
    skins: [{
      name: 'Humanoid', skeleton: lookup('Hips'), joints: joints.map((_, index) => index),
      ...options.omitBindMatrices ? {} : { inverseBindMatrices },
    }],
  };
  return builder.write(json);
}

// Rewrites a GLB's JSON chunk, for malformed-file checks; the binary chunk is kept as is.
export function patchGlbJson(glb, mutate) {
  const length = glb.readUInt32LE(12);
  const json = JSON.parse(glb.subarray(20, 20 + length).toString('utf8'));
  mutate(json);
  const text = Buffer.from(JSON.stringify(json));
  const description = Buffer.concat([text, Buffer.alloc((4 - text.length % 4) % 4, 0x20)]);
  const binary = glb.subarray(20 + length);
  const result = Buffer.alloc(20 + description.length + binary.length);
  glb.copy(result, 0, 0, 12);
  result.writeUInt32LE(result.length, 8);
  result.writeUInt32LE(description.length, 12);
  result.writeUInt32LE(0x4e4f534a, 16);
  description.copy(result, 20);
  binary.copy(result, 20 + description.length);
  return result;
}

// A static hammer: origin at the butt of the handle, handle along +X, head centred at 1.5 m.
export function hammerGlb(options = {}) {
  const length = options.length ?? 1.5;
  const handle = new CylinderGeometry(0.04, 0.045, length, 12, 1);
  handle.rotateZ(-Math.PI / 2);
  handle.translate(length / 2, 0, 0);
  const head = new BoxGeometry(0.2, 0.58, 0.22);
  head.translate(length, 0, 0);
  if (options.axis === 'y') {
    handle.rotateZ(Math.PI / 2);
    head.rotateZ(Math.PI / 2);
  }
  const builder = new GlbBuilder();
  const primitives = [handle, head].map((geometry, material) => {
    const positions = Array.from(geometry.getAttribute('position').array);
    const primitive = {
      attributes: {
        POSITION: builder.accessor(new Float32Array(positions), 'VEC3', 5126, positionBounds(positions)),
        NORMAL: builder.accessor(new Float32Array(geometry.getAttribute('normal').array), 'VEC3', 5126),
      },
      indices: builder.accessor(new Uint16Array(geometry.index.array), 'SCALAR', 5123),
      material,
    };
    geometry.dispose();
    return primitive;
  });
  return builder.write({
    asset: { version: '2.0', generator: 'Over the Edge hammer fixture' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ name: 'Hammer', mesh: 0 }],
    meshes: [{ name: 'Hammer', primitives }],
    materials: [
      { name: 'Wood', pbrMetallicRoughness: { baseColorFactor: [0.5, 0.3, 0.16, 1], metallicFactor: 0, roughnessFactor: 0.8 } },
      { name: 'Iron', pbrMetallicRoughness: { baseColorFactor: [0.3, 0.32, 0.36, 1], metallicFactor: 0.8, roughnessFactor: 0.35 } },
    ],
  });
}

// The physical pot's outline from its bottom-centre: base, lower wall, widest point and rim.
export const POT_OUTLINE = Object.freeze([[0.2, 0], [0.44, 0.19], [0.5, 0.6], [0.43, 0.8]]);

// A static pot: +Y up, origin at the bottom-centre, front badge facing +Z, walls on the physical
// outline. `origin: 'centre'` or 'edge', `axis: 'z'` and `scale` produce convention violations.
export function potGlb(options = {}) {
  const inner = [[0.39, 0.8], [0.45, 0.6], [0.4, 0.22], [0.17, 0.05], [0, 0.05]];
  const profile = [[0, 0], ...POT_OUTLINE, ...inner].map(([x, y]) => new Vector2(x, y));
  const body = new LatheGeometry(profile, 32);
  const badge = new BoxGeometry(0.16, 0.12, 0.04);
  badge.translate(0, 0.42, 0.49);
  const transform = new Matrix4();
  if (options.origin === 'centre') transform.makeTranslation(0, -0.4, 0);
  if (options.origin === 'edge') transform.makeTranslation(0.5, 0, 0);
  if (options.axis === 'z') transform.makeRotationX(Math.PI / 2);
  if (options.scale !== undefined) transform.makeScale(options.scale, options.scale, options.scale);
  const builder = new GlbBuilder();
  const primitives = [body, badge].map((geometry, material) => {
    geometry.applyMatrix4(transform);
    const positions = Array.from(geometry.getAttribute('position').array);
    const primitive = {
      attributes: {
        POSITION: builder.accessor(new Float32Array(positions), 'VEC3', 5126, positionBounds(positions)),
        NORMAL: builder.accessor(new Float32Array(geometry.getAttribute('normal').array), 'VEC3', 5126),
      },
      indices: builder.accessor(new Uint16Array(geometry.index.array), 'SCALAR', 5123),
      material,
    };
    geometry.dispose();
    return primitive;
  });
  return builder.write({
    asset: { version: '2.0', generator: 'Over the Edge pot fixture' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ name: 'Pot', mesh: 0 }],
    meshes: [{ name: 'Pot', primitives }],
    materials: [
      { name: 'Glaze', doubleSided: true, pbrMetallicRoughness: { baseColorFactor: [0.2, 0.46, 0.4, 1], metallicFactor: 0.1, roughnessFactor: 0.35 } },
      { name: 'Badge', pbrMetallicRoughness: { baseColorFactor: [0.92, 0.86, 0.72, 1], metallicFactor: 0, roughnessFactor: 0.6 } },
    ],
  });
}
