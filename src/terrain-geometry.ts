import { ExtrudeGeometry, Path, Shape } from 'three';
import { polygonArea } from './level';
import type { Outline, TerrainCollision } from './level';

// Whether `point`, a vertex of another outline, lies inside `outline`; outlines of one collision never touch.
function inside(outline: Outline, point: Outline[number]): boolean {
  let result = false;
  for (let i = 0, j = outline.length - 1; i < outline.length; j = i++) {
    const a = outline[j];
    const b = outline[i];
    if ((a.y > point.y) !== (b.y > point.y) && point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x) result = !result;
  }
  return result;
}

function trace<T extends Path>(path: T, outline: Outline): T {
  path.moveTo(outline[0].x, outline[0].y);
  for (let index = 1; index < outline.length; index++) path.lineTo(outline[index].x, outline[index].y);
  path.closePath();
  return path;
}

/**
 * A terrain collision extruded through unit depth, centred on z = 0: the look of a built-in mesh or a drawn outline, and
 * of a mesh drawn as its collision. Each counterclockwise outline is a face, and each clockwise one a hole in the
 * smallest face around it.
 */
export function terrainGeometry(collision: TerrainCollision): ExtrudeGeometry {
  const shapes: Shape[] = [];
  if (collision.type === 'circle') {
    // Three.js samples a full arc at twice curveSegments.
    const circle = new Shape();
    circle.absarc(0, 0, 0.5, 0, Math.PI * 2, false);
    shapes.push(circle);
  } else {
    const faces = collision.loops.filter((loop) => polygonArea(loop) > 0);
    const shapeOf = new Map(faces.map((face) => [face, trace(new Shape(), face)]));
    for (const loop of collision.loops) {
      if (polygonArea(loop) > 0) continue;
      let owner: Outline | null = null;
      for (const face of faces) {
        if (inside(face, loop[0]) && (owner === null || polygonArea(face) < polygonArea(owner))) owner = face;
      }
      if (owner !== null) shapeOf.get(owner)!.holes.push(trace(new Path(), loop));
    }
    shapes.push(...shapeOf.values());
  }
  const geometry = new ExtrudeGeometry(shapes, { depth: 1, steps: 1, bevelEnabled: false, curveSegments: 32 });
  // Unit depth centred on z = 0: an object reaches half its depth each side of the obstacle line.
  geometry.translate(0, 0, -0.5);
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}
