import {
  BufferGeometry, Color, DoubleSide, Float32BufferAttribute, InstancedMesh, MeshBasicMaterial,
  RingGeometry, ShaderMaterial, Sphere, Vector3,
} from 'three';
import { TRIGGER_LIMITS, triggerBounds } from './level';
import { MarkerView } from './marker-view';

const WIND = {
  depth: -0.08, color: 0x397f86, opacity: 0.75, speed: 0.65, travel: 0.85, bottom: 0.05,
  ringInner: 0.35, ringOuter: 0.5, ringSegments: 32, ringHeight: 0.12,
  columns: [-0.28, 0, 0.28], boundsWidth: 0.4, boundsHeight: 1,
} as const;
const CHEVRON = [
  [-0.1, 0], [0, 0.1], [0, 0.04], [-0.07, -0.03],
  [0, 0.1], [0.1, 0], [0.07, -0.03], [0, 0.04],
] as const;
const CHEVRON_INDICES = [0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7] as const;

function windGeometry(): BufferGeometry {
  const positions: number[] = [];
  const phases: number[] = [];
  const indices: number[] = [];
  for (const [index, x] of WIND.columns.entries()) {
    const first = positions.length / 3;
    for (const [dx, y] of CHEVRON) {
      positions.push(x + dx, y, 0);
      phases.push(index / WIND.columns.length);
    }
    for (const vertex of CHEVRON_INDICES) indices.push(first + vertex);
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setAttribute('phase', new Float32BufferAttribute(phases, 1));
  geometry.setIndex(indices);
  // Culling includes the full shader-driven motion, not only the resting vertices.
  geometry.boundingSphere = new Sphere(
    new Vector3(0, WIND.boundsHeight / 2, 0), Math.hypot(WIND.boundsWidth, WIND.boundsHeight / 2),
  );
  return geometry;
}

export class UpdraftView extends MarkerView {
  private readonly clock: { value: number };

  constructor() {
    const clock = { value: 0 };
    const ring = new RingGeometry(WIND.ringInner, WIND.ringOuter, WIND.ringSegments);
    ring.scale(1, WIND.ringHeight, 1);
    ring.translate(0, WIND.bottom, 0);
    const flow = new ShaderMaterial({
      uniforms: { time: clock, color: { value: new Color(WIND.color) } },
      transparent: true, depthWrite: false, side: DoubleSide, toneMapped: false,
      vertexShader: `
        attribute float phase;
        uniform float time;
        varying float fade;
        void main() {
          float cycle = fract(time * ${WIND.speed} + phase);
          vec3 point = position;
          point.y += ${WIND.bottom} + cycle * ${WIND.travel};
          fade = sin(cycle * 3.141592653589793);
          gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(point, 1.0);
        }
      `,
      fragmentShader: `
        uniform vec3 color;
        varying float fade;
        void main() {
          gl_FragColor = vec4(color, fade * ${WIND.opacity});
          #include <colorspace_fragment>
        }
      `,
    });
    super({
      kind: 'updraft',
      meshes: [
        new InstancedMesh(ring, new MeshBasicMaterial({ color: WIND.color, side: DoubleSide, toneMapped: false }), TRIGGER_LIMITS.objects),
        new InstancedMesh(windGeometry(), flow, TRIGGER_LIMITS.objects),
      ],
      transform: (object, matrix) => {
        const bounds = triggerBounds(object);
        return matrix.makeScale(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY, 1)
          .setPosition(object.x, bounds.minY, WIND.depth);
      },
    });
    this.clock = clock;
  }

  update(time: number): void {
    this.updateBounds();
    if (this.root.visible) this.clock.value = time;
  }
}
