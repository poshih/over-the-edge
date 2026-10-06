// The default character's shapes: the game draws them in the character's materials, and phantoms draw
// the same silhouette as ghosts. Metres, about the character's centre.
import { ExtrudeGeometry, LatheGeometry, Matrix4, Shape, Vector2, Vector3 } from 'three';
import type { Object3D } from 'three';
import type { HammerHead } from './hammer-head';
import { PLAYER_FIGURE } from './player-figure-data';
export { PLAYER_FIGURE } from './player-figure-data';

export function createPotGeometry(): LatheGeometry {
  return new LatheGeometry(PLAYER_FIGURE.potProfile.map(([radius, height]) => new Vector2(radius, height)), 40);
}

// A hammer head's collision outline, extruded and centred on the tool's depth.
export function createHammerHeadGeometry(head: HammerHead): ExtrudeGeometry {
  const [first, ...rest] = head;
  const shape = new Shape();
  shape.moveTo(first!.x, first!.y);
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
