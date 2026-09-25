import { ExtrudeGeometry, Shape } from 'three';
import { shapeVertices } from './level';
import type { LevelShape } from './level';

export function terrainGeometry(shape: LevelShape): ExtrudeGeometry {
  const outline = new Shape();
  if (shape.type === 'circle') {
    // Three.js samples a full arc at twice curveSegments.
    outline.absarc(0, 0, 0.5, 0, Math.PI * 2, false);
  } else {
    const vertices = shapeVertices(shape);
    outline.moveTo(vertices[0].x, vertices[0].y);
    for (let index = 1; index < vertices.length; index++) outline.lineTo(vertices[index].x, vertices[index].y);
    outline.closePath();
  }
  const geometry = new ExtrudeGeometry(outline, { depth: 1, steps: 1, bevelEnabled: false, curveSegments: 32 });
  geometry.translate(0, 0, -1);
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}
