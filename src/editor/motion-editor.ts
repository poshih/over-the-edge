import { setText } from '../dom';
import type { RigJson } from '../avatar-driver';
import type { AvatarMotionEntry } from '../avatar-motion-data';
import { SpriteError } from '../sprite-data';
import type { AvatarMotionControl, AvatarMotionControls, AvatarMotionNumberControl, AvatarMotionPath } from './avatar-motion-controls';
import type { ProjectCommandInfo } from './document/project-commands';
import type { LeanPreview } from '../waist-lean';
import { createRangeControl } from './range-control';
import type { RangeControl } from './range-control';
import type { SpriteEditorSnapshot, SpriteEditorState } from './sprite-state';

// One rendered control: the motion it edits, where its number sits in that motion's configuration, and its range.
interface BoundControl {
  readonly motion: string;
  readonly path: AvatarMotionPath;
  readonly control: RangeControl;
}

// A number a kind's controls describe, with its path from the configuration's root.
interface DescribedNumber {
  readonly group: string | null;
  readonly path: AvatarMotionPath;
  readonly spec: AvatarMotionNumberControl;
}

// The controls one motion shows.
interface MotionLayout {
  readonly id: string;
  readonly numbers: readonly DescribedNumber[];
}

// A control's number in a configuration, when the path reaches one.
function read(config: RigJson, path: AvatarMotionPath): RigJson | undefined {
  let value: RigJson | undefined = config;
  for (const step of path) {
    if (typeof step === 'number') value = Array.isArray(value) ? value[step] : undefined;
    else value = typeof value === 'object' && value !== null && !Array.isArray(value) && Object.hasOwn(value, step)
      ? (value as Readonly<Record<string, RigJson>>)[step] : undefined;
    if (value === undefined) return undefined;
  }
  return value;
}

function readNumber(config: RigJson, path: AvatarMotionPath): number | null {
  const value = read(config, path);
  return typeof value === 'number' ? value : null;
}

// A copy of `config` with the number at `path`, which read() found, replaced.
function write(config: RigJson, path: AvatarMotionPath, value: number, at = 0): RigJson {
  if (at === path.length) return value;
  const step = path[at]!;
  if (Array.isArray(config)) return config.map((item, index) => index === step ? write(item, path, value, at + 1) : item);
  const record = config as Readonly<Record<string, RigJson>>;
  return { ...record, [step]: write(record[step as string]!, path, value, at + 1) };
}

// Every number a kind's controls describe in one motion's configuration, with its path from the configuration's root;
// a list's controls repeat for each of its items, titled by the item's title field.
function describedNumbers(config: RigJson, controls: readonly AvatarMotionControl[]): DescribedNumber[] {
  const numbers: DescribedNumber[] = [];
  for (const control of controls) {
    if (!('list' in control)) {
      if (readNumber(config, control.path) !== null) numbers.push({ group: null, path: control.path, spec: control });
      continue;
    }
    const items = read(config, control.list);
    if (!Array.isArray(items)) continue;
    items.forEach((item: RigJson, index: number) => {
      const title = read(item, [control.title]);
      const group = typeof title === 'string' || typeof title === 'number' ? String(title) : `Item ${index + 1}`;
      for (const spec of control.controls) {
        const path = [...control.list, index, ...spec.path];
        if (readNumber(config, path) !== null) numbers.push({ group, path, spec });
      }
    });
  }
  return numbers;
}

function samePath(left: AvatarMotionPath, right: AvatarMotionPath): boolean {
  return left === right || left.length === right.length && left.every((step, index) => step === right[index]);
}

// Whether two layouts show the same controls, compared field by field rather than serialised on every input.
function sameLayout(left: readonly MotionLayout[], right: readonly MotionLayout[]): boolean {
  return left.length === right.length && left.every((motion, index) => {
    const other = right[index]!;
    return motion.id === other.id && motion.numbers.length === other.numbers.length && motion.numbers.every((number, at) => {
      const counterpart = other.numbers[at]!;
      return number.group === counterpart.group && number.spec === counterpart.spec && samePath(number.path, counterpart.path);
    });
  });
}

// The undo key of one number: a motion kind and the typed steps of its path.
function motionKey(id: string, path: AvatarMotionPath): string {
  return `character-motion/${encodeURIComponent(id)}/${path.map((step) => typeof step === 'number' ? `#${step}` : encodeURIComponent(step)).join('/')}`;
}

/**
 * Workshop / Character / Secondary motion: the imported avatar's motions, each with the controls its kind describes in
 * a workshop facet's AVATAR_MOTION_CONTROLS (docs/workshop-plugins.md), a reset to their defaults, and a sway and a jolt that move the
 * avatar in the running game so the motion can be judged without playing. A change is a step of the profile, where the
 * kind checks it again against the model; a scrub is one step. Hair shows here too; its chains are edited in the
 * profile JSON.
 */
export function createMotionEditor(options: {
  readonly mount: HTMLElement;
  readonly state: SpriteEditorState;
  // The registered motion kinds, and their controls.
  readonly kinds: readonly string[];
  readonly controls: () => AvatarMotionControls;
  readonly preview: (kind: LeanPreview) => void;
  readonly signal: AbortSignal;
}): { render(snapshot: SpriteEditorSnapshot, disabled: boolean): void } {
  const { state } = options;
  const root = document.createElement('div');
  root.className = 'character-motion';
  root.innerHTML = `
    <p class="appearance-format">Secondary motion moves an imported avatar's unmapped joints after the body, head and arms
      are posed: its hair chains, and the motion kinds the game registers in kinds facets, such as tails, ears
      or dangling accessories. A profile lists its kinds in <code>avatar.motion</code>; each runs only on the avatar it
      is configured for.</p>
    <p class="appearance-format character-motion-status" role="status" aria-live="polite"></p>
    <div class="character-motion-list"></div>
    <div class="character-action-row">
      <button type="button" class="button character-motion-sway" title="Rock the upper body about the waist for a few seconds">Sway</button>
      <button type="button" class="button character-motion-jolt" title="Kick the upper body once">Jolt</button>
    </div>
    <p class="appearance-format">Sway and Jolt move the avatar in the running game, without playing; they wait while the
      game is paused.</p>`;
  const status = root.querySelector<HTMLParagraphElement>('.character-motion-status')!;
  const list = root.querySelector<HTMLDivElement>('.character-motion-list')!;
  const sway = root.querySelector<HTMLButtonElement>('.character-motion-sway')!;
  const jolt = root.querySelector<HTMLButtonElement>('.character-motion-jolt')!;
  sway.addEventListener('click', () => options.preview('sway'), { signal: options.signal });
  jolt.addEventListener('click', () => options.preview('jolt'), { signal: options.signal });
  options.mount.append(root);

  let layout: readonly MotionLayout[] = [];
  let layoutEvents: AbortController | null = null;
  let bound: BoundControl[] = [];
  let resets: { readonly motion: number; readonly button: HTMLButtonElement }[] = [];

  const info = (label: string): ProjectCommandInfo =>
    ({ label, place: { tab: 'character', section: 'character-motion', select: null }, coalesce: null });

  // Changes motion `id`'s configuration as the profile holds it when the step runs.
  function change(id: string, label: string, update: (config: RigJson) => RigJson): void {
    state.apply(state.commands.avatarMotion((current) => current.map((entry): AvatarMotionEntry => {
      if (entry.id !== id) return entry;
      return { id, config: update(entry.config) };
    }), info(label)));
  }

  function defaults(config: RigJson, numbers: readonly DescribedNumber[]): RigJson {
    return numbers.reduce((next, { path, spec }) => write(next, path, spec.default), config);
  }

  function describe(entries: readonly AvatarMotionEntry[]): readonly MotionLayout[] {
    const controls = options.controls();
    return entries.map((entry) => ({ id: entry.id, numbers: describedNumbers(entry.config, controls.get(entry.id)?.controls ?? []) }));
  }

  function build(motions: readonly MotionLayout[]): void {
    layoutEvents?.abort();
    layoutEvents = new AbortController();
    const signal = layoutEvents.signal;
    bound = [];
    resets = [];
    list.replaceChildren(...motions.map(({ id, numbers }, motion) => {
      const group = document.createElement('fieldset');
      group.className = 'tuning-group character-motion-entry';
      group.dataset.motion = id;
      const legend = document.createElement('legend');
      legend.textContent = id;
      group.append(legend);
      let parent: HTMLElement = group;
      let current: string | null = null;
      numbers.forEach(({ group: title, path, spec }, index) => {
        if (title !== current) {
          current = title;
          if (title === null) parent = group;
          else {
            parent = document.createElement('fieldset');
            parent.className = 'tuning-group character-motion-item';
            const itemLegend = document.createElement('legend');
            itemLegend.textContent = title;
            parent.append(itemLegend);
            group.append(parent);
          }
        }
        const label = `Set ${id} ${spec.label}`;
        const key = motionKey(id, path);
        const control = createRangeControl(spec, {
          id: `character-motion-${motion}-${index}`, name: `motion-${id}-${path.join('.')}`, signal,
          history: state.history, stepLabel: label,
          // Positions shift as motions come and go; the motion and its path name the number.
          coalesceKey: () => key,
          onInput: (value) => change(id, label, (config) => {
            if (readNumber(config, path) === null) throw new SpriteError(`Motion "${id}" no longer has this setting.`);
            return write(config, path, value);
          }),
        });
        parent.append(control.row);
        bound.push({ motion: id, path, control });
      });
      if (numbers.length === 0) {
        const note = document.createElement('p');
        note.className = 'appearance-format';
        note.textContent = 'This kind describes no Workshop controls; edit its configuration in the profile JSON.';
        group.append(note);
      } else {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'button character-motion-reset';
        button.textContent = `Reset ${id}`;
        // The kind's controls as the profile holds them when the step runs.
        button.addEventListener('click', () => change(id, `Reset ${id}`,
          (config) => defaults(config, describedNumbers(config, options.controls().get(id)?.controls ?? []))), { signal });
        group.append(button);
        resets.push({ motion, button });
      }
      return group;
    }));
  }

  return {
    render(snapshot, disabled) {
      const avatar = snapshot.document.characterRiggingType === 'avatar-3d' && snapshot.avatarModel?.pending !== true
        ? snapshot.document.avatar : undefined;
      const entries = avatar?.motion ?? [];
      const described = describe(entries);
      // The controls are rebuilt only when what they show changes, so a slider keeps its focus while it drags.
      if (!sameLayout(described, layout)) build(described);
      layout = described;
      const values = new Map(entries.map((entry) => [entry.id, entry.config]));
      for (const { motion, path, control } of bound) {
        const value = readNumber(values.get(motion)!, path);
        if (value !== null) control.setValue(value, { disabled });
      }
      for (const { motion, button } of resets) {
        const { numbers } = described[motion]!;
        const config = entries[motion]!.config;
        // Its numbers are all the defaults already exactly when a reset changes nothing.
        button.disabled = disabled || numbers.every(({ path, spec }) => readNumber(config, path) === spec.default);
      }
      const chains = avatar?.hair.chains ?? [];
      const hair = chains.length === 0 ? '' : `Hair: ${chains.length} chain${chains.length === 1 ? '' : 's'} over ` +
        `${chains.reduce((sum, chain) => sum + chain.joints.length, 0)} joints, edited in the profile JSON's avatar.hair. `;
      const kinds = options.kinds.length === 0 ? 'This game registers no motion kinds.' : `Registered kinds: ${options.kinds.join(', ')}.`;
      setText(status, avatar === undefined ? 'Import a skinned avatar GLB above to give it secondary motion.' :
        `${hair}${entries.length === 0 ? `No motion kinds run on this avatar. ${kinds}` :
          disabled ? `${kinds} The controls wait until the avatar's joints are known.` : kinds}`);
      const moving = avatar !== undefined && (chains.length > 0 || entries.length > 0);
      sway.disabled = !moving;
      jolt.disabled = !moving;
    },
  };
}
