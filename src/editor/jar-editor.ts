import { RIG } from '../config';
import {
  DEFAULT_POT_OUTLINE, POT_OUTLINE_LIMITS, POT_OUTLINE_TOP, PotOutlineError, potMeasures, samePotOutline, validatePotOutline,
} from '../pot-outline';
import type { PotOutline } from '../pot-outline';
import type { History } from './document/history';
import { applyProjectCommand } from './document/project-commands';
import type { ProjectCommands } from './document/project-commands';
import { createOutlineEditor, outlineStepLabel } from './outline-editor';
import type { OutlineEditor } from './outline-editor';

function regularJar(radius: number, sides: number): PotOutline {
  return validatePotOutline(Array.from({ length: sides }, (_, index) => {
    const angle = (index + 0.5) / sides * 2 * Math.PI;
    return { x: radius * Math.cos(angle), y: radius * Math.sin(angle) };
  }));
}

// Starting points: the built-in jar, a round one that rolls, and a bucket that stands wide at its mouth.
const PRESETS: readonly { readonly label: string; readonly outline: PotOutline }[] = [
  { label: 'Jar', outline: DEFAULT_POT_OUTLINE },
  { label: 'Round', outline: regularJar(0.45, 12) },
  { label: 'Bucket', outline: validatePotOutline([{ x: -0.32, y: -0.48 }, { x: 0.32, y: -0.48 }, { x: 0.46, y: 0.32 }, { x: -0.46, y: 0.32 }]) },
];

function metres(value: number): string {
  return `${Number(value.toFixed(3))} m`;
}

/**
 * Physics / Jar: the jar's collision outline, a game setting, shaped on a canvas around the player's root, with the
 * shoulder hinge above it and the highest its top may reach. Mirror keeps its left and right alike. Each change is an
 * undo step.
 */
export function createJarEditor(options: {
  readonly mount: HTMLElement;
  readonly history: History;
  readonly commands: ProjectCommands;
}): OutlineEditor {
  const { history, commands } = options;
  return createOutlineEditor({
    key: 'jar', noun: 'jar outline', chooser: null,
    canvasLabel: 'Jar outline: the player\'s root at the centre, the shoulder hinge above it',
    reach: POT_OUTLINE_LIMITS.reach, vertices: POT_OUTLINE_LIMITS.vertices,
    validate: validatePotOutline, refused: (error): error is PotOutlineError => error instanceof PotOutlineError,
    mirror: { flips: 'x', title: 'Keep both sides of the jar alike; turning it on mirrors its right side' },
    presets: PRESETS,
    backdrop: (view, mark) => `<line class="outline-editor-limit" x1="${-view}" y1="${POT_OUTLINE_TOP}" x2="${view}" ` +
      `y2="${POT_OUTLINE_TOP}"></line><circle class="outline-editor-mark" cx="${RIG.shoulder.x}" cy="${RIG.shoulder.y}" ` +
      `r="${0.02 * mark}"></circle>`,
    limit: (point) => ({ x: point.x, y: Math.min(point.y, POT_OUTLINE_TOP) }),
    readout: (pot) => {
      const { bottom, top, area } = potMeasures(pot);
      const xs = pot.map((point) => point.x);
      return `${pot.length} points · ${metres(Math.max(...xs) - Math.min(...xs))} wide by ${metres(top - bottom)} tall · ` +
        `its base ${metres(-bottom)} below the root · ${Number(area.toFixed(3))} m²`;
    },
    help: () => 'The jar\'s collision outline, a game setting: every character\'s jar collides as it, and the default jar ' +
      'and phantoms are drawn from it. It holds the player\'s root, at the centre, and stays below the dashed line, under ' +
      'the shoulder hinge where the hammer turns. Its base is where heights, the hurt box and bonfire reach are measured ' +
      'from, and its area is the volume liquids hold up. A change rebuilds the player and restarts the run.',
    fallback: DEFAULT_POT_OUTLINE,
  }, {
    mount: options.mount,
    history,
    outlines: () => [{ id: null, name: 'Jar', outline: history.document.get('settings').rig.pot }],
    apply: (edit) => applyProjectCommand(history, commands.pot(edit.before, edit.after, {
      label: outlineStepLabel(edit.action, 'jar outline'),
      place: { tab: 'physics', section: 'physics-jar', select: null },
      coalesce: edit.action.kind === 'nudge' ? edit.action.key : null,
    })),
    subscribe: (listener) => history.document.subscribe('settings', (change, cause) => {
      if (!samePotOutline(change.before.rig.pot, change.after.rig.pot)) listener(cause);
    }),
  });
}
