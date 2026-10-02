import type { Point } from './config';

/**
 * The level board names 10 m squares of a level like a chessboard, so a designer can point a person or a language model
 * at an area in one word: "D7". Rows count 10 m bands up from the ground at y = 0: row 1 is 0-10 m high, row 7 60-70 m
 * and row 0 the band just below the ground. Columns are lettered A, B, ... Z, AA, AB, ... left to right from A, the
 * 10 m band, on multiples of 10 m, that holds the level's leftmost terrain point.
 */
export const BOARD_CELL = 10;

// A square: its column, counted from A = 0, and its row number.
export interface BoardSquare {
  readonly column: number;
  readonly row: number;
}

export interface BoardBounds {
  readonly left: number;
  readonly right: number;
  readonly bottom: number;
  readonly top: number;
}

// Column A's left edge, for a level whose leftmost terrain point is `terrainLeft` (null without terrain).
export function boardLeft(terrainLeft: number | null): number {
  return terrainLeft === null ? 0 : Math.floor(terrainLeft / BOARD_CELL) * BOARD_CELL;
}

// The square holding `point`, on a board whose column A starts at `left`; its column is negative left of A.
export function boardSquareAt(left: number, point: Point): BoardSquare {
  return { column: Math.floor((point.x - left) / BOARD_CELL), row: Math.floor(point.y / BOARD_CELL) + 1 };
}

export function boardSquareBounds(left: number, square: BoardSquare): BoardBounds {
  const x = left + square.column * BOARD_CELL;
  const y = (square.row - 1) * BOARD_CELL;
  return { left: x, right: x + BOARD_CELL, bottom: y, top: y + BOARD_CELL };
}

// A column's letters: 0 is A, 25 Z, 26 AA.
export function boardColumnName(column: number): string {
  let name = '';
  for (let rest = column + 1; rest > 0; rest = Math.floor((rest - 1) / 26)) name = String.fromCharCode(65 + (rest - 1) % 26) + name;
  return name;
}

// A square's name, such as D7; null left of column A.
export function boardSquareName(square: BoardSquare): string | null {
  return square.column < 0 ? null : `${boardColumnName(square.column)}${square.row}`;
}

// The square a name such as D7, aa12 or C0 names; null for anything else.
export function parseBoardSquare(name: string): BoardSquare | null {
  const match = /^([a-z]{1,3})(-?\d{1,4})$/i.exec(name.trim());
  if (match === null) return null;
  let column = 0;
  for (const letter of match[1]!.toUpperCase()) column = column * 26 + letter.charCodeAt(0) - 64;
  return { column: column - 1, row: Number(match[2]) };
}
