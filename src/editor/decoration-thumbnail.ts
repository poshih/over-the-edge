import { Color, Vector3 } from 'three';
import type { BufferGeometry } from 'three';
import type { DecorationGeometry } from '../decoration-geometry';

const LIGHT = new Vector3(-0.45, 0.65, 0.62).normalize();
const PADDING = 4;

interface Triangle {
  readonly points: readonly [number, number, number, number, number, number];
  readonly depth: number;
  readonly style: string;
}

function collect(geometry: BufferGeometry | null, glow: boolean, place: (x: number, y: number) => [number, number], into: Triangle[]): void {
  if (geometry === null) return;
  const position = geometry.getAttribute('position');
  const color = geometry.getAttribute('color');
  const a = new Vector3();
  const b = new Vector3();
  const c = new Vector3();
  const normal = new Vector3();
  const shaded = new Color();
  for (let index = 0; index + 2 < position.count; index += 3) {
    a.fromBufferAttribute(position, index);
    b.fromBufferAttribute(position, index + 1);
    c.fromBufferAttribute(position, index + 2);
    normal.subVectors(c, b).cross(new Vector3().subVectors(a, b)).normalize();
    // Faces turned away from the viewer are hidden behind the ones that face it.
    if (normal.z < 0) continue;
    const light = glow ? 1 : 0.32 + 0.68 * Math.max(0, normal.dot(LIGHT));
    shaded.setRGB(color.getX(index) * light, color.getY(index) * light, color.getZ(index) * light);
    const [ax, ay] = place(a.x, a.y);
    const [bx, by] = place(b.x, b.y);
    const [cx, cy] = place(c.x, c.y);
    into.push({ points: [ax, ay, bx, by, cx, cy], depth: (a.z + b.z + c.z) / 3, style: shaded.getStyle() });
  }
}

/** A front view of a decoration model, painted far to near with simple lighting, for the library grid. */
export function decorationThumbnail(model: DecorationGeometry, width = 120, height = 72): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.className = 'level-decoration-thumb';
  canvas.setAttribute('aria-hidden', 'true');
  const context = canvas.getContext('2d');
  if (context === null) return canvas;
  const scale = Math.min((width - PADDING * 2) / model.width, (height - PADDING * 2) / model.height);
  const place = (x: number, y: number): [number, number] => [width / 2 + x * scale, height - PADDING - y * scale];
  const triangles: Triangle[] = [];
  collect(model.lit, false, place, triangles);
  collect(model.glow, true, place, triangles);
  triangles.sort((first, second) => first.depth - second.depth);
  context.lineJoin = 'round';
  context.lineWidth = 0.6;
  for (const triangle of triangles) {
    const [ax, ay, bx, by, cx, cy] = triangle.points;
    context.beginPath();
    context.moveTo(ax, ay);
    context.lineTo(bx, by);
    context.lineTo(cx, cy);
    context.closePath();
    context.fillStyle = triangle.style;
    context.strokeStyle = triangle.style;
    context.fill();
    context.stroke();
  }
  return canvas;
}
