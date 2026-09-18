import {
  Color, DynamicDrawUsage, Group, InstancedBufferAttribute, InstancedMesh, Matrix4,
  PlaneGeometry, ShaderMaterial, Vector2, Vector4,
} from 'three';
import { createEnemyAtlas } from './enemy-art';
import { ENEMY_BEHAVIOR, ENEMY_DIRECTION, ENEMY_LIMITS, ENEMY_SPECS } from './enemy-types';
import type { EnemyEvent, EnemyPhase, EnemyPose, EnemySpecies } from './enemy-types';
import { InstanceSlots, markInstanceSlot } from './instancing';

const VISUAL = {
  depth: 0.04, alphaCutoff: 0.5, warningColor: 0xffae53,
  warningPulseHz: 5, warningMinimum: 0.3, warningAmplitude: 0.4, hurtFlash: 0.9,
} as const;
const FRAME_RATE: Readonly<Record<EnemySpecies, number>> = { bird: 8, 'hollow-soldier': 6 };
const PHASE: Readonly<Record<EnemyPhase, number>> = {
  patrol: 0, windup: 1, dive: 2, recover: 3, hurt: 4, dead: 5,
};

function dynamicAttribute(attribute: InstancedBufferAttribute): InstancedBufferAttribute {
  attribute.setUsage(DynamicDrawUsage);
  attribute.onUpload(() => attribute.clearUpdateRanges());
  return attribute;
}

function writeVector(attribute: InstancedBufferAttribute, slot: number, value: Vector4): boolean {
  if (attribute.getX(slot) === Math.fround(value.x) && attribute.getY(slot) === Math.fround(value.y) &&
    attribute.getZ(slot) === Math.fround(value.z) && attribute.getW(slot) === Math.fround(value.w)) return false;
  attribute.setXYZW(slot, value.x, value.y, value.z, value.w);
  markInstanceSlot(attribute, slot);
  return true;
}

export class EnemyView {
  readonly root = new Group();
  private readonly instances = new InstanceSlots<EnemyPose>({ capacity: ENEMY_LIMITS.objects, label: 'Enemy sprite' });
  private readonly atlas = createEnemyAtlas();
  private readonly geometry = new PlaneGeometry(1, 1);
  private readonly frames = dynamicAttribute(new InstancedBufferAttribute(new Float32Array(ENEMY_LIMITS.objects * 4), 4));
  private readonly states = dynamicAttribute(new InstancedBufferAttribute(new Float32Array(ENEMY_LIMITS.objects * 4), 4));
  private readonly clock = { value: 0 };
  private readonly material: ShaderMaterial;
  private readonly mesh: InstancedMesh<PlaneGeometry, ShaderMaterial>;
  private readonly matrix = new Matrix4();
  private readonly state = new Vector4();
  private disposed = false;
  private matrixWrites = 0;
  private stateWrites = 0;
  private atlasWrites = 0;
  private poseUpdates = 0;
  private clockWrites = 0;

  constructor() {
    this.root.name = 'enemies';
    this.root.visible = false;
    this.root.matrixAutoUpdate = false;
    this.geometry.setAttribute('atlasFrame', this.frames);
    this.geometry.setAttribute('enemyState', this.states);
    this.material = new ShaderMaterial({
      uniforms: {
        atlas: { value: this.atlas.texture },
        atlasSize: { value: new Vector2(this.atlas.texture.image.width, this.atlas.texture.image.height) },
        time: this.clock,
        warningColor: { value: new Color(VISUAL.warningColor) },
      },
      depthTest: true, depthWrite: true, transparent: false, toneMapped: false,
      vertexShader: `
        attribute vec4 atlasFrame;
        // Facing sign, phase, absolute phase start, animation frames per second.
        attribute vec4 enemyState;
        uniform vec2 atlasSize;
        uniform float time;
        varying vec2 atlasUv;
        varying vec2 artPixel;
        varying float death;
        varying float warning;
        varying float hurt;
        void main() {
          float age = max(0.0, time - enemyState.z);
          death = enemyState.y == ${PHASE.dead}.0
            ? clamp(age / ${ENEMY_BEHAVIOR.deathSeconds}, 0.0, 1.0) : 0.0;
          warning = enemyState.y == ${PHASE.windup}.0
            ? ${VISUAL.warningMinimum} + ${VISUAL.warningAmplitude} *
              (0.5 + 0.5 * sin(age * ${VISUAL.warningPulseHz * Math.PI * 2})) : 0.0;
          hurt = enemyState.y == ${PHASE.hurt}.0
            ? 1.0 - smoothstep(0.0, ${ENEMY_BEHAVIOR.hurtSeconds}, age) : 0.0;
          float frame = mod(floor(time * enemyState.w), ${this.atlas.frameCount}.0);
          vec2 localUv = vec2((uv.x - 0.5) * enemyState.x + 0.5, uv.y);
          vec2 halfTexel = 0.5 / atlasSize;
          atlasUv = atlasFrame.xy + vec2(frame * atlasFrame.z, 0.0) +
            clamp(localUv * atlasFrame.zw, halfTexel, atlasFrame.zw - halfTexel);
          artPixel = localUv * atlasFrame.zw * atlasSize;
          vec3 point = position;
          point.xy *= 1.0 - death;
          gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(point, 1.0);
        }
      `,
      fragmentShader: `
        uniform sampler2D atlas;
        uniform vec3 warningColor;
        varying vec2 atlasUv;
        varying vec2 artPixel;
        varying float death;
        varying float warning;
        varying float hurt;
        float bayer2(vec2 pixel) {
          vec2 bit = mod(pixel, 2.0);
          return 2.0 * bit.x + 3.0 * bit.y - 4.0 * bit.x * bit.y;
        }
        void main() {
          vec4 color = texture2D(atlas, atlasUv);
          if (color.a < ${VISUAL.alphaCutoff}) discard;
          // A fixed 4x4 pixel-space dither dissolves without sorted transparency.
          vec2 pixel = floor(artPixel);
          float threshold = (4.0 * bayer2(pixel) + bayer2(floor(pixel / 2.0)) + 0.5) / 16.0;
          if (death >= threshold) discard;
          color.rgb = mix(color.rgb, warningColor, warning);
          color.rgb = mix(color.rgb, vec3(1.0), hurt * ${VISUAL.hurtFlash});
          gl_FragColor = vec4(color.rgb, 1.0);
          #include <colorspace_fragment>
        }
      `,
    });
    this.mesh = new InstancedMesh(this.geometry, this.material, ENEMY_LIMITS.objects);
    this.mesh.name = 'enemy-sprites';
    this.mesh.count = 0;
    this.mesh.matrixAutoUpdate = false;
    // At most 64 tiny quads: no culling avoids rescanning dormant poses for animated bounds.
    this.mesh.frustumCulled = false;
    dynamicAttribute(this.mesh.instanceMatrix);
    this.root.add(this.mesh);
  }

  apply(event: EnemyEvent): void {
    this.ensureLive();
    switch (event.type) {
      case 'reset': {
        if (event.poses.length > ENEMY_LIMITS.objects) throw new Error('Enemy sprite capacity exceeded.');
        const ids = new Set(event.poses.map((pose) => pose.id));
        if (ids.size !== event.poses.length) throw new Error('Duplicate enemy poses in sprite reset.');
        // Release old slots first, including replacements of a full batch.
        for (const id of this.instances.ids()) if (!ids.has(id)) this.remove(id);
        for (const pose of event.poses) this.upsert(pose);
        break;
      }
      case 'upsert':
        this.upsert(event.pose);
        break;
      case 'remove':
        this.remove(event.id);
        break;
    }
  }

  update(poses: readonly EnemyPose[], time: number): void {
    this.ensureLive();
    for (const pose of poses) this.upsert(pose);
    if (this.clock.value !== time) {
      this.clock.value = time;
      this.clockWrites++;
    }
  }

  inspect() {
    const resources = this.disposed ? 0 : 1;
    return {
      disposed: this.disposed, instances: this.instances.size, triangles: this.mesh.count * 2,
      capacity: this.disposed ? 0 : ENEMY_LIMITS.objects,
      batches: resources, geometries: resources, materials: resources, textures: resources,
      atlasWidth: this.atlas.texture.image.width, atlasHeight: this.atlas.texture.image.height,
      atlasBytes: resources * this.atlas.bytes,
      matrixWrites: this.matrixWrites, stateWrites: this.stateWrites, atlasWrites: this.atlasWrites,
      poseUpdates: this.poseUpdates, clockWrites: this.clockWrites,
      pendingMatrixRanges: this.mesh.instanceMatrix.updateRanges.length,
      pendingStateRanges: this.states.updateRanges.length, pendingAtlasRanges: this.frames.updateRanges.length,
      time: this.clock.value,
      sprites: this.instances.values().map((pose, slot) => ({ ...pose, slot })),
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.instances.clear();
    this.mesh.count = 0;
    this.mesh.instanceMatrix.clearUpdateRanges();
    this.frames.clearUpdateRanges();
    this.states.clearUpdateRanges();
    this.mesh.dispose();
    this.geometry.dispose();
    this.material.dispose();
    this.atlas.texture.dispose();
    this.root.clear();
    this.root.removeFromParent();
    this.root.visible = false;
  }

  private upsert(pose: EnemyPose): void {
    const count = this.instances.size;
    const slot = this.instances.upsert(pose);
    if (this.instances.size !== count) this.syncCount();
    this.writePose(slot, pose);
    this.poseUpdates++;
  }

  private remove(id: string): void {
    const removed = this.instances.remove(id);
    if (removed === undefined) return;
    if (removed.moved !== undefined) this.writePose(removed.slot, removed.moved);
    this.syncCount();
  }

  private syncCount(): void {
    this.mesh.count = this.instances.size;
    this.root.visible = this.instances.size > 0;
  }

  private writePose(slot: number, pose: EnemyPose): void {
    const spec = ENEMY_SPECS[pose.species];
    // Terrain fronts are at z=0, below the player/tool anchors at z>0.2.
    this.matrix.makeScale(spec.width, spec.height, 1).setPosition(pose.x, pose.y, VISUAL.depth);
    const values = this.mesh.instanceMatrix.array;
    const offset = slot * this.mesh.instanceMatrix.itemSize;
    if (this.matrix.elements.some((value, index) => Math.fround(value) !== values[offset + index])) {
      this.mesh.setMatrixAt(slot, this.matrix);
      markInstanceSlot(this.mesh.instanceMatrix, slot);
      this.matrixWrites++;
    }
    const frame = this.atlas.frames.get(pose.species);
    if (frame === undefined) throw new Error(`Missing ${pose.species} sprite frames.`);
    if (writeVector(this.frames, slot, frame)) this.atlasWrites++;
    const rate = pose.phase !== 'dead' && (pose.species === 'bird' || pose.moving) ? FRAME_RATE[pose.species] : 0;
    this.state.set(ENEMY_DIRECTION[pose.facing], PHASE[pose.phase], pose.changedAt, rate);
    if (writeVector(this.states, slot, this.state)) this.stateWrites++;
  }

  private ensureLive(): void {
    if (this.disposed) throw new Error('Cannot update disposed enemy sprites.');
  }
}
