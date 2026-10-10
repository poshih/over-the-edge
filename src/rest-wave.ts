import { AdditiveBlending, Mesh, PlaneGeometry, ShaderMaterial, Vector2, Vector3 } from 'three';
import type { MomentEffect } from './effects';
import { BONFIRE } from './hazards';
import type { Moment } from './moments';
import { OBSTACLE_LINE } from './obstacle-line';
import type { SceneFrame } from './scene-frame';

// As the player lights a bonfire, a wave of firelight sweeps out from its fire across the whole screen and leaves the
// screen glowing, then settles: the player is healed and every enemy is back home at full health. With reduced motion
// the screen only glows.
const WAVE = {
  // Seconds: the glow swells over `rise`, the front reaches past the view's farthest corner after `sweep`, and the glow
  // has settled after `life`.
  rise: 0.12, sweep: 0.85, life: 1.6,
  // The front's half-width in metres as it leaves the fire, and how much wider it grows for each metre it travels.
  band: 0.8, spread: 0.18,
  // How much light the front adds at the fire, and the glow it leaves behind.
  front: 0.9, glow: 0.32,
  // The quad reaches this share of the view's size past each edge, so no edge ever shows.
  margin: 0.05,
  // Over everything else in the top pass.
  renderOrder: 40,
} as const;

// Firelight, in linear light.
const TINT = [1, 0.62, 0.24] as const;

const VERTEX = /* glsl */ `
varying vec2 vWorld;
void main() {
  vec4 world = modelMatrix * vec4(position, 1.0);
  vWorld = world.xy;
  gl_Position = projectionMatrix * viewMatrix * world;
}
`;

// The front, a soft band `band` metres either side of a circle `front` metres around the fire, and the glow inside it.
const FRAGMENT = /* glsl */ `
uniform vec3 tint;
uniform vec2 centre;
uniform float front;
uniform float band;
uniform float frontLight;
uniform float glowLight;
varying vec2 vWorld;
void main() {
  float offset = (distance(vWorld, centre) - front) / band;
  float wave = exp(-offset * offset) * frontLight;
  float inside = 1.0 - smoothstep(-1.0, 0.5, offset);
  gl_FragColor = vec4(tint * (wave + inside * glowLight), 1.0);
}
`;

/** The engine's rest effect: one quad over the whole view in the top pass, drawn only while the wave shows. */
export class RestWave implements MomentEffect {
  readonly root: Mesh<PlaneGeometry, ShaderMaterial>;
  readonly pass = 'top';
  readonly moments = Object.freeze(['bonfire', 'placed'] as const);
  private readonly uniforms = {
    tint: { value: new Vector3(TINT[0], TINT[1], TINT[2]) },
    centre: { value: new Vector2() },
    front: { value: 0 },
    band: { value: 0 },
    frontLight: { value: 0 },
    glowLight: { value: 0 },
  };
  // The run seconds the bonfire was lit at, while the wave shows, and whether it only glows.
  private start: number | null = null;
  private still = false;

  constructor() {
    const material = new ShaderMaterial({
      uniforms: this.uniforms, vertexShader: VERTEX, fragmentShader: FRAGMENT,
      // Light adds to everything drawn, and the top ignores depth.
      transparent: true, blending: AdditiveBlending, depthTest: false, depthWrite: false,
    });
    this.root = new Mesh(new PlaneGeometry(1, 1), material);
    this.root.frustumCulled = false;
    this.root.renderOrder = WAVE.renderOrder;
    this.root.visible = false;
  }

  moment(moment: Moment): void {
    // A new run or a return after a death ends it.
    if (moment.type === 'placed') this.end();
    else if (moment.type === 'bonfire') {
      this.uniforms.centre.value.set(moment.x, moment.y + BONFIRE.height / 2);
      this.start = moment.time;
      this.still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    }
  }

  update(frame: SceneFrame): boolean {
    const start = this.start;
    if (start === null) return false;
    const age = Math.max(0, frame.time - start);
    if (age >= WAVE.life) {
      this.end();
      return false;
    }
    // Cover the course plane's rectangle the camera shows, which is the whole screen.
    const { left, right, bottom, top } = frame.view;
    this.root.position.set((left + right) / 2, (bottom + top) / 2, OBSTACLE_LINE);
    this.root.scale.set((right - left) * (1 + 2 * WAVE.margin), (top - bottom) * (1 + 2 * WAVE.margin), 1);
    const centre = this.uniforms.centre.value;
    const reach = Math.hypot(Math.max(centre.x - left, right - centre.x), Math.max(centre.y - bottom, top - centre.y));
    const swept = Math.min(1, age / WAVE.sweep);
    const front = this.still ? reach + WAVE.band : (reach + WAVE.band) * (1 - (1 - swept) ** 3);
    this.uniforms.front.value = front;
    this.uniforms.band.value = WAVE.band + front * WAVE.spread;
    this.uniforms.frontLight.value = this.still ? 0 : WAVE.front * Math.sqrt(1 - swept);
    // The glow holds while the front sweeps, then settles.
    const settle = 1 - Math.max(0, (age - WAVE.sweep) / (WAVE.life - WAVE.sweep));
    this.uniforms.glowLight.value = WAVE.glow * Math.min(1, age / WAVE.rise) * settle * settle;
    this.root.visible = true;
    return true;
  }

  dispose(): void {
    this.root.geometry.dispose();
    this.root.material.dispose();
  }

  private end(): void {
    this.start = null;
    this.root.visible = false;
  }
}
