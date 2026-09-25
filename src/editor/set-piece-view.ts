// Editor-only SVG rendering for set pieces: palette thumbnails and the placement ghost. Both are
// built once per piece (and mirror state) in piece-local coordinates; moving the ghost only
// changes one transform, so previews never touch per-part geometry while the pointer moves.
import { objectVertices } from '../level';
import { createGizmo } from './object-gizmos';
import { LABEL_SIZE, setPieceBounds, setPieceParts } from './set-pieces';
import type { SetPiece, SetPiecePart } from './set-pieces';

const SVG_NS = 'http://www.w3.org/2000/svg';
const PREVIEW_ID = 'set-piece-preview';
const THUMBNAIL_PADDING = 0.06;
/** Ghost label text is authored in pixels and scaled into metres. */
const LABEL_TEXT_SCALE = 0.01;

function svg<K extends keyof SVGElementTagNameMap>(tag: K, attributes: Record<string, string | number> = {}): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, String(value));
  return node;
}

function appendParts(group: SVGGElement, parts: readonly SetPiecePart[], ghost: boolean): void {
  const overlays: SVGElement[] = [];
  for (const part of parts) {
    if (part.kind === 'terrain') {
      const points = objectVertices({ ...part, id: PREVIEW_ID }).map((point) => `${point.x},${point.y}`).join(' ');
      group.append(svg('polygon', {
        points, fill: `#${part.color.toString(16).padStart(6, '0')}`, 'vector-effect': 'non-scaling-stroke',
        class: part.illusion ? 'level-set-piece-terrain level-set-piece-illusion' : 'level-set-piece-terrain',
      }));
    } else if (part.kind === 'label') {
      overlays.push(svg('rect', {
        x: part.x - LABEL_SIZE.width / 2, y: part.y - LABEL_SIZE.height / 2,
        width: LABEL_SIZE.width, height: LABEL_SIZE.height, class: 'level-set-piece-label', 'vector-effect': 'non-scaling-stroke',
      }));
      if (ghost) {
        const text = svg('text', {
          transform: `translate(${part.x} ${part.y}) scale(${LABEL_TEXT_SCALE} ${-LABEL_TEXT_SCALE})`,
          'text-anchor': 'middle', 'dominant-baseline': 'central',
        });
        text.textContent = part.text;
        overlays.push(text);
      }
    } else {
      overlays.push(createGizmo({ ...part, id: PREVIEW_ID }, ghost ? 'ghost' : 'normal'));
    }
  }
  group.append(...overlays);
}

/** A small upright picture of the whole piece for its palette button. */
export function createSetPieceThumbnail(piece: SetPiece): SVGSVGElement {
  const { left, right, bottom, top } = piece.bounds;
  const pad = Math.max(right - left, top - bottom) * THUMBNAIL_PADDING;
  const icon = svg('svg', {
    class: 'level-set-piece-thumb', 'aria-hidden': 'true',
    viewBox: `${left - pad} ${-top - pad} ${right - left + pad * 2} ${top - bottom + pad * 2}`,
  });
  const upright = svg('g', { transform: 'scale(1,-1)' });
  appendParts(upright, piece.parts, false);
  icon.append(upright);
  return icon;
}

/**
 * The world-space placement preview, drawn relative to the piece's base anchor. Its baseline shows
 * where the piece will rest; callers translate the group to the anchor.
 */
export function createSetPieceGhost(piece: SetPiece, mirror: boolean): SVGGElement {
  const group = svg('g', { class: 'level-set-piece-ghost' });
  appendParts(group, setPieceParts(piece, mirror), true);
  const { left, right } = setPieceBounds(piece, mirror);
  group.append(svg('line', { class: 'level-set-piece-base', x1: left, y1: 0, x2: right, y2: 0, 'vector-effect': 'non-scaling-stroke' }));
  return group;
}
