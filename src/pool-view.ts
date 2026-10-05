import { BoxGeometry, Group, InstancedMesh, MeshBasicMaterial, MeshStandardMaterial } from 'three';
import type { BufferGeometry } from 'three';
import type { LevelObject, PoolObject } from './level';
import { LIQUID_LABELS, LIQUID_LIMITS } from './liquids';
import type { Liquid } from './liquids';
import { ObjectView } from './object-view';

// How much of what is in a pool shows through the liquid in front of it.
const FRONT_OPACITY: Readonly<Record<Liquid, number>> = { lava: 0.55, swamp: 0.65 };

const VARYINGS = 'varying vec3 vLiquidPoint;\nvarying float vLiquidDepth;';

// Each point's world position, and how far below its pool's surface, the top of the unit box, it is.
const POSITION = `{
  vec4 liquidPoint = vec4(transformed, 1.0);
  vec4 liquidTop = vec4(0.0, 0.5, 0.0, 1.0);
  #ifdef USE_INSTANCING
    liquidPoint = instanceMatrix * liquidPoint;
    liquidTop = instanceMatrix * liquidTop;
  #endif
  vLiquidPoint = (modelMatrix * liquidPoint).xyz;
  vLiquidDepth = (modelMatrix * liquidTop).y - vLiquidPoint.y;
}`;

const NOISE = `uniform float liquidTime;
float liquidHash(vec2 p) {
  vec3 q = fract(vec3(p.xyx) * 0.1031);
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}
float liquidNoise(vec2 p) {
  vec2 cell = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(liquidHash(cell), liquidHash(cell + vec2(1.0, 0.0)), u.x),
    mix(liquidHash(cell + vec2(0.0, 1.0)), liquidHash(cell + vec2(1.0, 1.0)), u.x), u.y);
}
float liquidPattern(vec2 p) {
  return 0.55 * liquidNoise(p) + 0.3 * liquidNoise(p * 2.03 + 3.7) + 0.15 * liquidNoise(p * 4.1 + 7.3);
}`;

// Each liquid's colour, in linear light. The faces across the obstacle line and the surface share one world-space
// pattern, so pools of any size show it at one scale.
const COLORS: Readonly<Record<Liquid, string>> = {
  // Molten rock, deeper red further down, under drifting dark crust split by glowing veins, its surface white-hot.
  lava: `vec3 liquidColor() {
    vec2 p = vec2(vLiquidPoint.x, vLiquidPoint.y + vLiquidPoint.z) * 0.7;
    float flow = liquidTime * 0.08;
    float crust = liquidPattern(p + vec2(flow, -0.3 * flow));
    float veins = 1.0 - smoothstep(0.02, 0.09, abs(liquidPattern(p * 1.6 - vec2(0.5 * flow, flow)) - 0.5));
    vec3 color = mix(vec3(1.0, 0.3, 0.03), vec3(0.42, 0.035, 0.008), 0.75 * smoothstep(0.0, 3.0, vLiquidDepth));
    color = mix(color, vec3(0.07, 0.018, 0.01), 0.9 * smoothstep(0.52, 0.72, crust));
    color = mix(color, vec3(1.0, 0.7, 0.18), 0.85 * veins);
    return mix(color, vec3(1.0, 0.82, 0.32), 1.0 - smoothstep(0.0, 0.1, vLiquidDepth));
  }`,
  // Murky water, darker further down, with scum drifting near its surface.
  swamp: `vec3 liquidColor() {
    vec2 p = vec2(vLiquidPoint.x, vLiquidPoint.y + vLiquidPoint.z) * 0.9;
    float scum = liquidPattern(p + vec2(liquidTime * 0.02, 0.0));
    vec3 color = mix(vec3(0.075, 0.09, 0.028), vec3(0.018, 0.026, 0.01), smoothstep(0.0, 2.5, vLiquidDepth));
    color = mix(color, vec3(0.17, 0.18, 0.055), smoothstep(0.55, 0.78, scum) * (1.0 - smoothstep(0.0, 0.7, vLiquidDepth)));
    return mix(color, vec3(0.2, 0.21, 0.07), 1.0 - smoothstep(0.0, 0.05, vLiquidDepth));
  }`,
};

// Half of a unit box split along the obstacle line: behind it (-1) or in front of it (1).
function half(side: -1 | 1): BufferGeometry {
  const geometry = new BoxGeometry(1, 1, 0.5);
  geometry.translate(0, 0, side * 0.25);
  return geometry;
}

function liquidMaterial(liquid: Liquid, clock: { value: number }, opacity: number): MeshBasicMaterial | MeshStandardMaterial {
  const translucent = opacity < 1;
  const parameters = { transparent: translucent, opacity, depthWrite: !translucent };
  // Lava glows: unlit, at its full brightness. Swamp takes the scene's light.
  const material = liquid === 'lava'
    ? new MeshBasicMaterial({ ...parameters, toneMapped: false })
    : new MeshStandardMaterial({ ...parameters, roughness: 0.3, metalness: 0 });
  material.onBeforeCompile = (shader) => {
    shader.uniforms.liquidTime = clock;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${VARYINGS}`)
      .replace('#include <fog_vertex>', `#include <fog_vertex>\n${POSITION}`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${VARYINGS}\n${NOISE}\n${COLORS[liquid]}`)
      .replace('#include <color_fragment>', '#include <color_fragment>\n\tdiffuseColor.rgb = liquidColor();');
  };
  material.customProgramCacheKey = () => `pool-${liquid}`;
  return material;
}

/**
 * The level's pools of one liquid, each a box on the obstacle line split along it. The half behind the line draws with
 * the course, which hides it behind the terrain in front of it; the half in front draws translucent in the front pass,
 * over the actors, so whatever is in the liquid looks in it, though like everything in that pass it stays under a 3D
 * character's arms and the hammer. The liquid moves in its shaders, from world position and the run's time, so frames
 * write nothing per pool.
 */
export class PoolView extends ObjectView<PoolObject> {
  // The pools' halves in front of the obstacle line.
  readonly front = new Group();
  private readonly clock: { value: number };

  constructor(liquid: Liquid) {
    const clock = { value: 0 };
    const front = new InstancedMesh(half(1), liquidMaterial(liquid, clock, FRONT_OPACITY[liquid]), LIQUID_LIMITS.pools);
    super({
      matches: (object: LevelObject): object is PoolObject => object.kind === 'pool' && object.liquid === liquid,
      capacity: LIQUID_LIMITS.pools, label: `${LIQUID_LABELS[liquid]} pool`,
      meshes: [new InstancedMesh(half(-1), liquidMaterial(liquid, clock, 1), LIQUID_LIMITS.pools), front],
      transform: (object, matrix) => matrix.makeScale(object.width, object.height, object.depth).setPosition(object.x, object.y, 0),
    });
    this.front.add(front);
    this.clock = clock;
  }

  update(time: number): void {
    this.updateBounds();
    this.front.visible = this.root.visible;
    if (this.root.visible) this.clock.value = time;
  }

  override dispose(): void {
    super.dispose();
    this.front.clear();
    this.front.removeFromParent();
  }
}
