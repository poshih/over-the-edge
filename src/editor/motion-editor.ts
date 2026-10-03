import { setText } from '../dom';
import type { RigJson } from '../avatar-driver';
import type { AvatarMotionEntry } from '../avatar-motion-data';
import type { AvatarMotionControls, AvatarMotionNumberControl, AvatarMotionPath } from '../avatar-motion';
import type { LeanPreview } from '../waist-lean';
import { createRangeControl } from './range-control';
import type { RangeControl } from './range-control';
import type { SpriteEditorSnapshot, SpriteEditorState } from './sprite-state';

// One rendered control: the motion it edits, where its number sits in that motion's configuration, and its range.
interface BoundControl {
  readonly motion: number;
  readonly path: AvatarMotionPath;
  readonly spec: AvatarMotionNumberControl;
  readonly control: RangeControl;
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
function describedNumbers(config: RigJson, controls: AvatarMotionControls[string]):
  { readonly group: string | null; readonly path: AvatarMotionPath; readonly spec: AvatarMotionNumberControl }[] {
  const numbers: { group: string | null; path: AvatarMotionPath; spec: AvatarMotionNumberControl }[] = [];
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

/**
 * Workshop / Character / Secondary motion: the imported avatar's motions, each with the controls its kind describes in
 * the avatar rig module's editor-only `controls`, a reset to their defaults, and a sway and a jolt that move the
 * avatar in the running game so the motion can be judged without playing. A change goes to the draft profile, where
 * the kind re-validates it against the model, and through Save and Revert. Hair shows here too; its chains are edited
 * in the profile JSON.
 */
export function createMotionEditor(options: {
  readonly mount: HTMLElement;
  readonly state: SpriteEditorState;
  // The registered motion kinds, and their controls.
  readonly kinds: readonly string[];
  readonly controls: AvatarMotionControls;
  readonly preview: (kind: LeanPreview) => void;
  readonly signal: AbortSignal;
}): { render(snapshot: SpriteEditorSnapshot, disabled: boolean): void } {
  const root = document.createElement('div');
  root.className = 'character-motion';
  root.innerHTML = `
    <p class="appearance-format">Secondary motion moves an imported avatar's unmapped joints after the body, head and arms
      are posed: its hair chains, and the motion kinds the game registers in its avatar rig module, such as tails, ears
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

  let layout: string | null = null;
  let layoutEvents: AbortController | null = null;
  let bound: BoundControl[] = [];
  let resets: { readonly motion: number; readonly button: HTMLButtonElement }[] = [];

  function motions(): readonly AvatarMotionEntry[] {
    return options.state.snapshot().document.avatar?.motion ?? [];
  }

  function change(index: number, update: (config: RigJson) => RigJson): void {
    const current = motions();
    const entry = current[index];
    if (entry === undefined) return;
    options.state.setAvatarMotion(current.map((other, at) => at === index ? { id: entry.id, config: update(entry.config) } : other));
  }

  function defaults(config: RigJson, id: string): RigJson {
    return describedNumbers(config, options.controls[id] ?? []).reduce((next, { path, spec }) => write(next, path, spec.default), config);
  }

  function build(entries: readonly AvatarMotionEntry[]): void {
    layoutEvents?.abort();
    layoutEvents = new AbortController();
    const signal = layoutEvents.signal;
    bound = [];
    resets = [];
    list.replaceChildren(...entries.map((entry, motion) => {
      const group = document.createElement('fieldset');
      group.className = 'tuning-group character-motion-entry';
      group.dataset.motion = entry.id;
      const legend = document.createElement('legend');
      legend.textContent = entry.id;
      group.append(legend);
      const numbers = describedNumbers(entry.config, options.controls[entry.id] ?? []);
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
        const control = createRangeControl(spec, {
          id: `character-motion-${motion}-${index}`, name: `motion-${entry.id}-${path.join('.')}`, signal,
          onInput: (value) => change(motion, config => write(config, path, value)),
        });
        parent.append(control.row);
        bound.push({ motion, path, spec, control });
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
        button.textContent = `Reset ${entry.id}`;
        button.addEventListener('click', () => change(motion, config => defaults(config, entry.id)), { signal });
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
      // The controls are rebuilt only when what they show changes, so a slider keeps its focus while it drags.
      const shape = JSON.stringify(entries.map(entry => [entry.id,
        describedNumbers(entry.config, options.controls[entry.id] ?? []).map(({ group, path, spec }) => [group, path, spec.label])]));
      if (shape !== layout) {
        layout = shape;
        build(entries);
      }
      for (const { motion, path, control } of bound) {
        const value = readNumber(entries[motion]!.config, path);
        if (value !== null) control.setValue(value, { disabled });
      }
      for (const { motion, button } of resets) {
        const entry = entries[motion]!;
        button.disabled = disabled || JSON.stringify(defaults(entry.config, entry.id)) === JSON.stringify(entry.config);
      }
      const chains = avatar?.hair.chains ?? [];
      const hair = chains.length === 0 ? '' : `Hair: ${chains.length} chain${chains.length === 1 ? '' : 's'} over ` +
        `${chains.reduce((sum, chain) => sum + chain.joints.length, 0)} joints, edited in the profile JSON's avatar.hair. `;
      const kinds = options.kinds.length === 0 ? 'This game registers no motion kinds.' : `Registered kinds: ${options.kinds.join(', ')}.`;
      setText(status, avatar === undefined ? 'Import a skinned avatar GLB above to give it secondary motion.' :
        `${hair}${entries.length === 0 ? `No motion kinds run on this avatar. ${kinds}` : kinds}`);
      const moving = avatar !== undefined && (chains.length > 0 || entries.length > 0);
      sway.disabled = disabled || !moving;
      jolt.disabled = disabled || !moving;
    },
  };
}
