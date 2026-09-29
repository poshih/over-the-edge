import { DoubleSide, MeshBasicMaterial, MeshStandardMaterial } from 'three';
import { builtInDecoration, builtInGeometry } from './decoration-models';
import { DecorationView } from './decoration-view';
import type { DecorationMesh } from './decoration-view';

// Both sides render, so a copy mirrored by a negative scale is not culled as facing away.
const litMaterial = new MeshStandardMaterial({ vertexColors: true, roughness: 0.92, metalness: 0.05, flatShading: true, side: DoubleSide });
const glowMaterial = new MeshBasicMaterial({ vertexColors: true, toneMapped: false, side: DoubleSide });
const meshes = new Map<string, DecorationMesh>();

/** A built-in placeholder as a drawable model: its lit surfaces and its glowing ones. */
export function builtInDecorationMesh(id: string): DecorationMesh | null {
  const existing = meshes.get(id);
  if (existing !== undefined) return existing;
  const model = builtInDecoration(id);
  if (model === undefined) return null;
  const geometry = builtInGeometry(model);
  const mesh: DecorationMesh = Object.freeze({
    parts: Object.freeze([
      ...(geometry.lit === null ? [] : [{ geometry: geometry.lit, material: litMaterial }]),
      ...(geometry.glow === null ? [] : [{ geometry: geometry.glow, material: glowMaterial }]),
    ]),
    flatShaded: true, width: geometry.width, height: geometry.height, depth: geometry.depth,
  });
  meshes.set(id, mesh);
  return mesh;
}

/** Draws a level's decorations with the built-in library. Releases include this only when their level has decorations. */
export function createDecorationView(): DecorationView {
  return new DecorationView(builtInDecorationMesh);
}
