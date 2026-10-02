import type { Point } from '../config';
import { BOARD_CELL, boardSquareBounds, boardSquareName } from '../level-board';
import type { BoardSquare } from '../level-board';

const SVG = 'http://www.w3.org/2000/svg';
// Board lines and square names keep at least these gaps on screen, thinning out as the view zooms out.
const LINE_PIXELS = 12;
const NAME_PIXELS = 96;
// A square's name sits this far inside its top-left corner.
const NAME_INSET = { x: 4, y: 13 } as const;

// The overlay as the board sees it: its size in pixels and the mapping between course positions and its pixels.
export interface BoardViewport {
  readonly width: number;
  readonly height: number;
  readonly toScreen: (point: Point) => Point;
  readonly toWorld: (screen: Point) => Point;
}

// The smallest of 1, 2 and 5 times a power of ten that is at least `minimum`.
export function niceStep(minimum: number): number {
  const power = 10 ** Math.floor(Math.log10(minimum));
  for (const factor of [1, 2, 5]) if (factor * power >= minimum) return factor * power;
  return 10 * power;
}

function svg<K extends keyof SVGElementTagNameMap>(name: K, className: string): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG, name);
  node.setAttribute('class', className);
  return node;
}

/**
 * Draws the level board (src/level-board.ts) in the level editor's overlay, in screen pixels so names stay readable at
 * any zoom: the lines between squares, the squares' names and a highlighted square. A draw touches only the squares in
 * view, thinned out when zoomed out, never the level's objects.
 */
export class LevelBoardView {
  readonly root = svg('g', 'level-board');
  private readonly lines = svg('path', 'level-board-lines');
  private readonly names = svg('g', 'level-board-names');
  private readonly hover = svg('rect', 'level-board-hover');
  private readonly hoverName = svg('text', 'level-board-hover-name');
  // Name labels, reused from draw to draw; the first `shown` are in use.
  private readonly pool: SVGTextElement[] = [];
  private shown = 0;
  private left = 0;
  private square: BoardSquare | null = null;

  constructor() {
    this.root.append(this.lines, this.hover, this.names, this.hoverName);
    this.hover.setAttribute('hidden', '');
    this.hoverName.setAttribute('hidden', '');
  }

  // Column A's left edge.
  setLeft(left: number): void {
    this.left = left;
  }

  // The square to highlight, such as the one under the pointer; null for none.
  setHover(square: BoardSquare | null): void {
    this.square = square;
  }

  draw(view: BoardViewport): void {
    const origin = view.toScreen({ x: 0, y: 0 });
    const cell = view.toScreen({ x: BOARD_CELL, y: 0 }).x - origin.x;
    if (!(cell > 0)) return;
    const corner = view.toWorld({ x: 0, y: 0 });
    const far = view.toWorld({ x: view.width, y: view.height });
    const lineStep = Math.max(1, niceStep(LINE_PIXELS / cell));
    const nameStep = Math.max(1, niceStep(NAME_PIXELS / cell));
    // Columns from A rightward, and rows bottom to top, in view.
    const firstColumn = Math.max(0, Math.floor((corner.x - this.left) / BOARD_CELL));
    const lastColumn = Math.floor((far.x - this.left) / BOARD_CELL);
    const firstRow = Math.floor(far.y / BOARD_CELL) + 1;
    const lastRow = Math.floor(corner.y / BOARD_CELL) + 1;
    const boardX = Math.max(0, view.toScreen({ x: this.left, y: 0 }).x);
    let path = '';
    if (boardX < view.width) {
      // Column k starts at x = left + 10 k; row r ends at y = 10 r.
      for (let k = Math.ceil(firstColumn / lineStep) * lineStep; k <= lastColumn + 1; k += lineStep) {
        path += `M${view.toScreen({ x: this.left + k * BOARD_CELL, y: 0 }).x.toFixed(1)} 0V${view.height}`;
      }
      for (let r = Math.ceil((firstRow - 1) / lineStep) * lineStep; r <= lastRow; r += lineStep) {
        path += `M${boardX.toFixed(1)} ${view.toScreen({ x: 0, y: r * BOARD_CELL }).y.toFixed(1)}H${view.width}`;
      }
    }
    this.lines.setAttribute('d', path);
    let used = 0;
    for (let column = Math.ceil(firstColumn / nameStep) * nameStep; column <= lastColumn; column += nameStep) {
      for (let row = Math.ceil(firstRow / nameStep) * nameStep; row <= lastRow; row += nameStep) {
        this.place(this.label(used++), { column, row }, view);
      }
    }
    for (let index = used; index < this.shown; index++) this.pool[index]!.setAttribute('hidden', '');
    this.shown = used;
    this.drawHover(view);
  }

  // Moves only the highlight, for a pointer moving over a still view.
  drawHover(view: BoardViewport): void {
    const name = this.square === null ? null : boardSquareName(this.square);
    this.hover.toggleAttribute('hidden', name === null);
    this.hoverName.toggleAttribute('hidden', name === null);
    if (name === null) return;
    const bounds = boardSquareBounds(this.left, this.square!);
    const topLeft = view.toScreen({ x: bounds.left, y: bounds.top });
    const bottomRight = view.toScreen({ x: bounds.right, y: bounds.bottom });
    this.hover.setAttribute('x', topLeft.x.toFixed(1));
    this.hover.setAttribute('y', topLeft.y.toFixed(1));
    this.hover.setAttribute('width', Math.max(0, bottomRight.x - topLeft.x).toFixed(1));
    this.hover.setAttribute('height', Math.max(0, bottomRight.y - topLeft.y).toFixed(1));
    this.place(this.hoverName, this.square!, view);
  }

  private label(index: number): SVGTextElement {
    let label = this.pool[index];
    if (label === undefined) {
      label = svg('text', 'level-board-name');
      this.pool.push(label);
      this.names.append(label);
    }
    if (index >= this.shown) label.removeAttribute('hidden');
    return label;
  }

  // Names `square` inside its top-left corner.
  private place(label: SVGTextElement, square: BoardSquare, view: BoardViewport): void {
    const corner = view.toScreen({ x: this.left + square.column * BOARD_CELL, y: square.row * BOARD_CELL });
    label.setAttribute('x', (corner.x + NAME_INSET.x).toFixed(1));
    label.setAttribute('y', (corner.y + NAME_INSET.y).toFixed(1));
    const name = boardSquareName(square) ?? '';
    if (label.textContent !== name) label.textContent = name;
  }
}
