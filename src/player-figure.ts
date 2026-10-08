// The default character's shapes: the game draws them in the character's materials, and phantoms draw
// the same silhouette as ghosts. Metres, about the character's centre.
import { BufferGeometry, ExtrudeGeometry, Float32BufferAttribute, Matrix4, Shape, Vector3 } from 'three';
import type { Object3D } from 'three';
import type { HammerHead } from './hammer-head';
import { potSpan } from './pot-outline';
import type { PotOutline } from './pot-outline';
import { PLAYER_FIGURE } from './player-figure-data';
export { PLAYER_FIGURE } from './player-figure-data';

// Points round each of the jar's rings.
const JAR_SEGMENTS = 40;

/**
 * The jar drawn from its collision outline: at each of the outline's heights a ring across its span there, so from the
 * front the jar shows exactly its outline, and it is as deep as it is wide. Its base is closed; its mouth stays open.
 */
export function createPotGeometry(outline: PotOutline): BufferGeometry {
  const heights = [...new Set(outline.map((point) => point.y))].sort((a, b) => a - b);
  const span = { left: 0, right: 0 };
  const positions: number[] = [];
  const indices: number[] = [];
  const ring = (y: number): void => {
    potSpan(outline, y, span);
    const centre = (span.left + span.right) / 2, radius = (span.right - span.left) / 2;
    for (let segment = 0; segment < JAR_SEGMENTS; segment++) {
      const angle = segment / JAR_SEGMENTS * Math.PI * 2;
      positions.push(centre + radius * Math.cos(angle), y, radius * Math.sin(angle));
    }
  };
  for (const y of heights) ring(y);
  // Each band between two rings, facing out.
  for (let level = 0; level + 1 < heights.length; level++) {
    for (let segment = 0; segment < JAR_SEGMENTS; segment++) {
      const next = (segment + 1) % JAR_SEGMENTS;
      const a = level * JAR_SEGMENTS + segment, b = level * JAR_SEGMENTS + next;
      const c = (level + 1) * JAR_SEGMENTS + next, d = (level + 1) * JAR_SEGMENTS + segment;
      indices.push(a, d, b, b, d, c);
    }
  }
  // The base, facing down, on vertices of its own so its edge stays sharp.
  const base = positions.length / 3;
  ring(heights[0]!);
  potSpan(outline, heights[0]!, span);
  positions.push((span.left + span.right) / 2, heights[0]!, 0);
  for (let segment = 0; segment < JAR_SEGMENTS; segment++) {
    indices.push(base + JAR_SEGMENTS, base + segment, base + (segment + 1) % JAR_SEGMENTS);
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
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
