// The default character's shapes: the game draws them in the character's materials, and phantoms draw
// the same silhouette as ghosts. Metres, about the character's centre.
import { ExtrudeGeometry, LatheGeometry, Matrix4, Shape, Vector2, Vector3 } from 'three';
import type { Object3D } from 'three';
import { RIG } from './config';

export const PLAYER_FIGURE = {
  // The pot's outline, turned about its axis: [radius, height] pairs from the base up.
  potProfile: [[0.19, -0.47], [0.33, -0.41], [0.44, -0.28], [0.49, 0.05], [0.46, 0.23], [0.43, 0.32]],
  chest: { radius: 0.28, y: 0.56, scale: [0.82, 1.25, 0.77] },
  neck: { top: 0.07, bottom: 0.09, height: 0.16, y: 0.89 },
  helmet: { radius: 0.225, y: 1.095, scaleY: 1.06 },
  // Limbs are unit-length cylinders stretched between their joints: radii at the far and near joint.
  upperArm: { top: 0.065, bottom: 0.073 },
  forearm: { top: 0.055, bottom: 0.07 },
  elbow: 0.077,
  hand: 0.083,
  hammerHead: { depth: 0.22, bevel: 0.012 },
} as const;

export function createPotGeometry(): LatheGeometry {
  return new LatheGeometry(PLAYER_FIGURE.potProfile.map(([radius, height]) => new Vector2(radius, height)), 40);
}

// The hammer head's outline, extruded and centred on the tool's depth.
export function createHammerHeadGeometry(): ExtrudeGeometry {
  const [first, ...rest] = RIG.headVertices;
  const shape = new Shape();
  shape.moveTo(first.x, first.y);
  for (const vertex of rest) shape.lineTo(vertex.x, vertex.y);
  shape.closePath();
  const { depth, bevel } = PLAYER_FIGURE.hammerHead;
  return new ExtrudeGeometry(shape, { depth, bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 1 })
    .translate(0, 0, -depth / 2);
}

const direction = new Vector3();
const across = new Vector3();
const facing = new Vector3();
const basis = new Matrix4();

// Stretches a unit-length limb along its y axis from one joint to the next, bending in `normal`'s plane.
export function placeLimb(limb: Object3D, start: Vector3, end: Vector3, normal: Vector3): void {
  limb.position.addVectors(start, end).multiplyScalar(0.5);
  direction.subVectors(end, start);
  limb.scale.y = direction.length();
  direction.normalize();
  across.crossVectors(direction, normal).normalize();
  facing.crossVectors(across, direction);
  basis.makeBasis(across, direction, facing);
  limb.quaternion.setFromRotationMatrix(basis);
}
