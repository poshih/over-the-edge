import { RIG } from '../config';
import { DEFAULT_HAMMER_HEAD, HAMMER_HEAD_LIMITS, HammerHeadError, hammerHeadBack, validateHammerHead } from '../hammer-head';
import type { HammerHead } from '../hammer-head';
import { createOutlineEditor } from './outline-editor';
import type { OutlineEditor } from './outline-editor';

// A hammer whose head the editor shapes: the default hammer (id null), whose head is a game setting, or a library hammer.
export interface HeadedHammer {
  readonly id: string | null;
  readonly name: string;
  readonly head: HammerHead;
}

export type HammerHeadEditor = OutlineEditor;

function regularHead(radius: number, sides: number): HammerHead {
  return validateHammerHead(Array.from({ length: sides }, (_, index) => {
    const angle = (index + 0.5) / sides * 2 * Math.PI;
    return { x: radius * Math.cos(angle), y: radius * Math.sin(angle) };
  }));
}

// Starting points: the built-in sledge, a round head, and a sledge with a pick for hooking ledges.
const PRESETS: readonly { readonly label: string; readonly outline: HammerHead }[] = [
  { label: 'Sledge', outline: DEFAULT_HAMMER_HEAD },
  { label: 'Round', outline: regularHead(0.2, 12) },
  { label: 'Pick', outline: validateHammerHead([
    { x: -0.1, y: -0.23 }, { x: -0.06, y: -0.29 }, { x: 0.06, y: -0.29 }, { x: 0.1, y: -0.23 },
    { x: 0.1, y: 0.12 }, { x: 0, y: 0.45 }, { x: -0.1, y: 0.12 },
  ]) },
];

function metres(value: number): string {
  return `${Number(value.toFixed(3))} m`;
}

/**
 * Physics / Hammer head: each hammer's collision outline, shaped on a canvas around the head's centre, where the
 * handle ends. Mirror keeps the two sides of the handle alike.
 */
export function createHammerHeadEditor(options: {
  readonly mount: HTMLElement;
  // The default hammer first, then the library's hammers.
  readonly hammers: () => readonly HeadedHammer[];
  // Stores a hammer's new head; false when it was refused, which the store reports.
  readonly setHead: (id: string | null, head: HammerHead) => boolean;
}): HammerHeadEditor {
  return createOutlineEditor({
    key: 'hammer-head', noun: 'hammer head outline',
    chooser: { label: 'Hammer', name: (hammer) => hammer.id === null ? hammer.name : `Library: ${hammer.name}` },
    canvasLabel: 'Hammer head outline: the handle comes in from the left to the head\'s centre',
    reach: HAMMER_HEAD_LIMITS.reach, vertices: HAMMER_HEAD_LIMITS.vertices,
    validate: validateHammerHead, refused: (error): error is HammerHeadError => error instanceof HammerHeadError,
    mirror: { flips: 'y', title: 'Keep both sides of the handle alike; turning it on mirrors the side above the handle' },
    presets: PRESETS,
    backdrop: (view) => `<rect class="outline-editor-handle" x="${-view}" y="${-RIG.handleHalfWidth}" width="${view}" ` +
      `height="${2 * RIG.handleHalfWidth}"></rect>`,
    readout: (head) => {
      const xs = head.map((point) => point.x), ys = head.map((point) => point.y);
      return `${head.length} points · ${metres(Math.max(...xs) - Math.min(...xs))} along the handle by ${
        metres(Math.max(...ys) - Math.min(...ys))} across · reaches ${metres(hammerHeadBack(head))} back down the handle`;
    },
    help: (hammer) => hammer?.id === null || hammer === undefined
      ? 'The default hammer\'s head, a game setting: it collides whenever no library hammer is shown, and phantoms show it.'
      : `${hammer.name}'s own head: it collides while this hammer is shown, as when the game's ` +
        'backend selects it or Project / Model library previews it.',
    fallback: DEFAULT_HAMMER_HEAD,
  }, {
    mount: options.mount,
    outlines: () => options.hammers().map((hammer) => ({ id: hammer.id, name: hammer.name, outline: hammer.head })),
    setOutline: options.setHead,
  });
}
