import { STANDARD_AVATAR_DRIVER } from '../avatar-driver';
import type { AvatarDriver } from '../avatar-driver';
import { NO_AVATAR_MOTION } from '../avatar-motion-data';
import type { AvatarMotionEntry } from '../avatar-motion-data';
import { inspectCharacterModel, resolveAvatarHair, resolveAvatarJoints, suggestAvatarBoneMap } from '../character-model-inspect';
import type { CharacterModelReport } from '../character-model-inspect';
import {
  AVATAR_MODEL_ID, CHARACTER_MODEL_LIMITS, CharacterModelError, encodeModel, HAMMER_MODEL_ID, isAvatarJoint, NO_AVATAR_HAIR,
  POT_MODEL_ID, validateAvatarBoneMap,
} from '../character-profile';
import type {
  AvatarHair, AvatarJointId, AvatarModelProfile, AvatarModelSettings, CharacterModel, PartialAvatarBoneMap, PropModelRole,
} from '../character-profile';
import { DirectionalError } from '../directional-data';
import { SkeletonError } from '../skeleton-data';
import { encodePng, FLIPBOOK_LIMITS, flipbookSizeMessage, inspectPng, SPRITE_FILE_BYTES, SPRITE_LIMITS, SpriteError } from '../sprite-data';
import type { SpriteDocument } from '../sprite-data';
import { freeLayerId, selectionEntry } from './character-commands';
import type { CharacterImage, PrimaryCommands } from './character-commands';
import type { ImportRunner, PendingContext, PreparedImport } from './document/import-runner';
import type { ProjectCommandInfo, ProjectRefusal } from './document/project-commands';
import type { ProjectDocument } from './document/project-document';
import type { EditOutcome, FileInput, ImportOptions } from './document/project-imports';
import { ProjectApiError } from './project-client';
import { ServerModelError } from './server-models';

// The avatar waiting for its bone map, as the Character tab shows it.
export interface AvatarMapping {
  readonly name: string;
  readonly report: CharacterModelReport;
  readonly boneMap: PartialAvatarBoneMap;
  readonly issue: CharacterModelError;
}

/**
 * The primary character's imports: each is a pending edit from before its file is read or downloaded until its step,
 * on the runner every import of the project shares. An avatar whose bone map does not resolve stays that one pending
 * edit while the designer maps it.
 */
export interface CharacterImports {
  image(input: FileInput, anchor: string, options: ImportOptions): Promise<EditOutcome<SpriteDocument>>;
  frames(layer: string, files: readonly File[], options: ImportOptions): Promise<EditOutcome<SpriteDocument>>;
  // `model`, a server avatar's own settings, maps it; otherwise its joints map automatically, and the avatar's own GLB
  // imported again keeps its driver, hair and motions.
  avatar(input: FileInput, options: ImportOptions & { readonly model?: AvatarModelSettings }): Promise<EditOutcome<SpriteDocument>>;
  prop(role: PropModelRole, input: FileInput, options: ImportOptions): Promise<EditOutcome<SpriteDocument>>;
  profile(input: FileInput, options: ImportOptions): Promise<EditOutcome<SpriteDocument>>;
  profileValue(value: unknown, options: ImportOptions): Promise<EditOutcome<SpriteDocument>>;
  // A profile `read` downloads, such as a server copy.
  profileRead(read: (signal: AbortSignal) => Promise<unknown>, options: ImportOptions): Promise<EditOutcome<SpriteDocument>>;
  // Maps `joint` to the skin joint `name`, or unmaps it with null. While an avatar waits for its map this edits that map,
  // 'unchanged', and that avatar's import makes the step once the map resolves; otherwise it maps the current avatar,
  // which waits likewise while its map does not resolve.
  avatarBone(joint: AvatarJointId, name: string | null, options: ImportOptions): Promise<EditOutcome<SpriteDocument>>;
  mapping(): AvatarMapping | null;
  // Cancels the avatar waiting for its bone map.
  cancelAvatar(): void;
  dispose(): void;
}

export interface CharacterImportsOptions {
  readonly document: ProjectDocument;
  readonly runner: ImportRunner;
  readonly commands: PrimaryCommands;
  // Hears the avatar waiting for its bone map change.
  readonly onMapping: () => void;
}

interface AvatarCandidate {
  readonly name: string;
  readonly report: CharacterModelReport;
  readonly boneMap: PartialAvatarBoneMap;
  readonly driver: AvatarDriver;
  readonly hair: AvatarHair;
  readonly motion: readonly AvatarMotionEntry[];
  readonly cancel: () => void;
}

interface Waiting {
  mapping: AvatarMapping;
  readonly hair: AvatarHair;
  readonly finish: (boneMap: PartialAvatarBoneMap) => void;
  readonly cancel: () => void;
}

interface AvatarTarget {
  readonly avatar: AvatarModelProfile | null;
  readonly model: CharacterModel | null;
}

const PROP_MODEL_IDS: Readonly<Record<PropModelRole, string>> = { hammer: HAMMER_MODEL_ID, pot: POT_MODEL_ID };
// Numeric collation orders frame-2 before frame-10, independent of the browser locale.
const FRAME_ORDER = new Intl.Collator('en', { numeric: true });

function refusal(error: unknown): ProjectRefusal {
  if (error instanceof SpriteError) return error;
  if (error instanceof SkeletonError || error instanceof DirectionalError || error instanceof ProjectApiError ||
    error instanceof ServerModelError || error instanceof DOMException) {
    return new SpriteError(error.message, { cause: error });
  }
  throw error;
}

function modelName(name: string): string {
  const stem = name.replace(/\.glb$/i, '').trim().slice(0, CHARACTER_MODEL_LIMITS.name);
  return stem.length > 0 ? stem : 'Character model';
}

function checkModelName(name: string): void {
  if (!/\.glb$/i.test(name) || name.length > 255) {
    throw new CharacterModelError('invalid-model', 'Choose one binary glTF (.glb) file.');
  }
}

function checkModelSize(file: Blob): void {
  if (file.size === 0 || file.size > CHARACTER_MODEL_LIMITS.bytes) {
    throw new CharacterModelError('model-limits', `Choose a GLB file no larger than ${CHARACTER_MODEL_LIMITS.bytes / 1024 ** 2} MiB.`);
  }
}

function checkPng(file: File): void {
  if (file.type !== 'image/png' && !/\.png$/i.test(file.name)) throw new SpriteError('Choose one PNG (.png) image file.');
  if (file.size === 0 || file.size > SPRITE_LIMITS.imageBytes) {
    throw new SpriteError(`Choose a PNG image no larger than ${Math.floor(SPRITE_LIMITS.imageBytes / 1024 ** 2)} MiB.`);
  }
}

function checkFrame(file: File): void {
  if (file.type !== 'image/png' && !/\.png$/i.test(file.name)) {
    throw new SpriteError(`Flipbook frame "${file.name}" is not a PNG (.png) image.`);
  }
  if (file.size === 0 || file.size > SPRITE_LIMITS.imageBytes) {
    throw new SpriteError(`Flipbook frame "${file.name}" must be a PNG no larger than ${Math.floor(SPRITE_LIMITS.imageBytes / 1024 ** 2)} MiB.`);
  }
}

function checkProfileSize(file: Blob): void {
  if (file.size > SPRITE_FILE_BYTES) {
    throw new SpriteError(`Profile JSON must be at most ${Math.floor(SPRITE_FILE_BYTES / 1024 ** 2)} MiB.`);
  }
}

function parseProfile(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new SpriteError('The sprite document is not valid JSON.', { cause: error });
  }
}

function withBone(boneMap: PartialAvatarBoneMap, joint: AvatarJointId, name: string | null): PartialAvatarBoneMap {
  const next: Partial<Record<AvatarJointId, string>> = { ...boneMap };
  if (name === null || name === '') delete next[joint];
  else next[joint] = name;
  return Object.freeze(next);
}

// Why the map does not resolve against the model, or null once it does. Invalid intermediate maps, such as a duplicate
// while two joints swap, stay form input.
function mappingIssue(report: CharacterModelReport, boneMap: PartialAvatarBoneMap, hair: AvatarHair): CharacterModelError | null {
  try {
    resolveAvatarHair(report, resolveAvatarJoints(report, boneMap), hair);
    return null;
  } catch (error) {
    if (error instanceof CharacterModelError) return error;
    throw error;
  }
}

// Selects what the step made: the layer it added or changed.
function selecting(info: ProjectCommandInfo, id: string): ProjectCommandInfo {
  const select = { before: info.place.select?.before ?? [], after: [selectionEntry('layer', id)] };
  return { ...info, place: { ...info.place, select } };
}

export function createCharacterImports(options: CharacterImportsOptions): CharacterImports {
  const { document, runner, commands } = options;
  // Stops this service's imports; the runner outlives it.
  const lifecycle = new AbortController();
  let waiting: Waiting | null = null;
  // The native PNG decode under way, settled however it ends.
  let decoding: Promise<void> | null = null;
  const primary = (): SpriteDocument => document.get('characters/primary');

  function edit<P>(
    input: ImportOptions,
    start: (work: PendingContext) => P,
    build: (work: PendingContext, prepared: P) => Promise<PreparedImport<SpriteDocument>>,
  ): Promise<EditOutcome<SpriteDocument>> {
    return runner.edit({ info: input.info, signal: AbortSignal.any([input.signal, lifecycle.signal]) }, refusal, start, build);
  }

  async function read(work: PendingContext, input: FileInput, check: (file: File) => void): Promise<File> {
    work.check();
    const file = 'read' in input ? await work.wait(() => input.read(work.signal)) : input;
    work.check();
    check(file);
    return file;
  }

  async function bytesOf(work: PendingContext, file: Blob): Promise<Uint8Array<ArrayBuffer>> {
    const bytes = new Uint8Array(await work.wait(() => file.arrayBuffer()));
    work.check();
    return bytes;
  }

  // The PNG decodes, as the rig decodes it, before it joins the profile. One native decode runs at a time: a stopped
  // import's decode keeps its turn until the browser settles it, closing its own bitmap if late.
  async function decodes(work: PendingContext, bytes: Uint8Array<ArrayBuffer>): Promise<void> {
    while (decoding !== null) await work.wait(() => decoding!);
    work.check();
    const native = createImageBitmap(new Blob([bytes], { type: 'image/png' })).then((bitmap) => bitmap.close());
    const turn: Promise<void> = native.then(() => undefined, () => undefined);
    decoding = turn;
    void turn.then(() => { if (decoding === turn) decoding = null; });
    try {
      await work.wait(() => native);
    } catch (error) {
      if (error instanceof DOMException && error.name !== 'AbortError') {
        throw new SpriteError('The PNG could not be decoded.', { cause: error });
      }
      throw error;
    }
    work.check();
  }

  // Claims the avatar: another avatar import, or a change of the avatar or its model, stops this one.
  function avatarTarget(work: PendingContext): AvatarTarget {
    const current = primary();
    const avatar = current.avatar ?? null;
    const model = avatar === null ? null : current.models?.find((entry) => entry.id === avatar.model) ?? null;
    work.target('characters/primary/avatar', ['characters/primary'], () => {
      const now = primary();
      return (now.avatar ?? null) === avatar && (avatar === null || now.models?.find((entry) => entry.id === avatar.model) === model);
    });
    return { avatar, model };
  }

  // The settings once the candidate's bone map resolves against its model; meanwhile it waits as the avatar being mapped.
  function mapped(work: PendingContext, candidate: AvatarCandidate): Promise<AvatarModelSettings> {
    const settings = (boneMap: PartialAvatarBoneMap): AvatarModelSettings => Object.freeze({
      boneMap: validateAvatarBoneMap(boneMap), driver: candidate.driver, hair: candidate.hair, motion: candidate.motion,
    });
    const issue = mappingIssue(candidate.report, candidate.boneMap, candidate.hair);
    if (issue === null) return Promise.resolve(settings(candidate.boneMap));
    return work.wait(() => new Promise<AvatarModelSettings>((resolve) => {
      const entry: Waiting = {
        mapping: Object.freeze({ name: candidate.name, report: candidate.report, boneMap: candidate.boneMap, issue }),
        hair: candidate.hair,
        finish: (boneMap) => resolve(settings(boneMap)),
        cancel: candidate.cancel,
      };
      waiting = entry;
      work.own(() => {
        if (waiting !== entry) return;
        waiting = null;
        options.onMapping();
      });
      options.onMapping();
    }));
  }

  function avatarStep(model: CharacterModel, settings: AvatarModelSettings, info: ProjectCommandInfo): PreparedImport<SpriteDocument> {
    return { command: () => commands.avatar({ model, settings }, info), value: primary };
  }

  function profileStep(work: PendingContext, value: unknown, info: ProjectCommandInfo): PreparedImport<SpriteDocument> {
    work.check();
    const profile = commands.checked(value);
    return { command: () => commands.profile(profile, info), value: primary };
  }

  // A whole profile replaces the character, so any change of it meanwhile drops this one.
  function profileTarget(work: PendingContext): void {
    const expected = primary();
    work.target('characters/primary', ['characters/primary'], () => primary() === expected);
  }

  const imports: CharacterImports = {
    image(input, anchor, request) {
      return edit(request, () => {
        if (!('read' in input)) checkPng(input);
      }, async (work) => {
        const file = await read(work, input, checkPng);
        const bytes = await bytesOf(work, file);
        const size = inspectPng(bytes);
        await decodes(work, bytes);
        const image: CharacterImage = Object.freeze({ name: input.name.replace(/\.png$/i, ''), source: encodePng(bytes), ...size });
        return {
          command: () => {
            const id = freeLayerId(primary());
            return commands.imageLayer(id, image, anchor, selecting(request.info, id));
          },
          value: primary,
        };
      });
    },
    frames(layer, files, request) {
      return edit(request, (work) => {
        if (files.length < FLIPBOOK_LIMITS.minimumFrames || files.length > FLIPBOOK_LIMITS.maximumFrames) {
          throw new SpriteError(`Choose ${FLIPBOOK_LIMITS.minimumFrames}-${FLIPBOOK_LIMITS.maximumFrames} PNG frames for a flipbook.`);
        }
        for (const file of files) checkFrame(file);
        const current = primary().layers.find((candidate) => candidate.id === layer);
        if (current === undefined) throw new SpriteError(`The character profile has no layer "${layer}".`);
        // The exact layer it read: any change of it, even one undone again, or another layer under its ID stops this one.
        work.target(`characters/primary/layers/${layer}/frames`, ['characters/primary'],
          () => primary().layers.find((candidate) => candidate.id === layer) === current);
        return current.name;
      }, async (work, name) => {
        const frames: CharacterImage[] = [];
        let reference: { readonly id: string; readonly width: number; readonly height: number } | null = null;
        for (const file of [...files].sort((left, right) => FRAME_ORDER.compare(left.name, right.name))) {
          const bytes = await bytesOf(work, file);
          const size = { id: file.name, ...inspectPng(bytes) };
          if (reference === null) reference = size;
          else if (size.width !== reference.width || size.height !== reference.height) {
            throw new SpriteError(flipbookSizeMessage(name, size, reference));
          }
          await decodes(work, bytes);
          frames.push(Object.freeze({ name: file.name.replace(/\.png$/i, ''), source: encodePng(bytes), width: size.width, height: size.height }));
        }
        if (new Set(frames.map((frame) => frame.source)).size !== frames.length) {
          throw new SpriteError('Two chosen flipbook frames are identical PNGs. Choose a distinct image for every frame.');
        }
        return { command: () => commands.frames(layer, frames, selecting(request.info, layer)), value: primary };
      });
    },
    avatar(input, request) {
      const task = new AbortController();
      return edit({ info: request.info, signal: AbortSignal.any([request.signal, task.signal]) }, (work) => {
        checkModelName(input.name);
        if (!('read' in input)) checkModelSize(input);
        return avatarTarget(work);
      }, async (work, target) => {
        const bytes = await bytesOf(work, await read(work, input, checkModelSize));
        const report = inspectCharacterModel(bytes.buffer, 'avatar');
        const source = encodeModel(bytes);
        const name = modelName(input.name);
        // The avatar's own GLB again: its settings were made for these joints.
        const own = target.avatar !== null && target.model !== null && target.model.source === source
          ? { avatar: target.avatar, model: target.model } : null;
        const model = own !== null && own.model.name === name ? own.model : Object.freeze({ id: AVATAR_MODEL_ID, name, source });
        commands.inspected(model, report);
        const base = request.model ?? {
          boneMap: suggestAvatarBoneMap(report),
          driver: own?.avatar.driver ?? STANDARD_AVATAR_DRIVER,
          hair: own?.avatar.hair ?? NO_AVATAR_HAIR,
          motion: own?.avatar.motion ?? NO_AVATAR_MOTION,
        };
        const settings = await mapped(work, { name, report, ...base, cancel: () => task.abort() });
        return avatarStep(model, settings, request.info);
      });
    },
    prop(role, input, request) {
      return edit(request, (work) => {
        checkModelName(input.name);
        if (!('read' in input)) checkModelSize(input);
        const current = primary();
        const expected = current[role];
        const model = expected === undefined ? null : current.models?.find((entry) => entry.id === expected.model) ?? null;
        work.target(`characters/primary/${role}`, ['characters/primary'], () => {
          const now = primary();
          return now[role] === expected && (expected === undefined || now.models?.find((entry) => entry.id === expected.model) === model);
        });
        return model;
      }, async (work, current) => {
        const bytes = await bytesOf(work, await read(work, input, checkModelSize));
        const report = inspectCharacterModel(bytes.buffer, role);
        const source = encodeModel(bytes);
        const name = modelName(input.name);
        const model = current !== null && current.source === source && current.name === name
          ? current : Object.freeze({ id: PROP_MODEL_IDS[role], name, source });
        commands.inspected(model, report);
        return { command: () => commands.prop(role, model, request.info), value: primary };
      });
    },
    profile(input, request) {
      return edit(request, (work) => {
        if (!('read' in input)) checkProfileSize(input);
        profileTarget(work);
      }, async (work) => {
        const file = await read(work, input, checkProfileSize);
        const text = await work.wait(() => file.text());
        return profileStep(work, parseProfile(text), request.info);
      });
    },
    profileValue(value, request) {
      return edit(request, profileTarget, async (work) => profileStep(work, value, request.info));
    },
    profileRead(download, request) {
      return edit(request, profileTarget, async (work) => profileStep(work, await work.wait(() => download(work.signal)), request.info));
    },
    avatarBone(joint, name, request) {
      if (!isAvatarJoint(joint)) throw new Error(`Unknown avatar joint "${String(joint)}".`);
      const entry = waiting;
      if (entry !== null) {
        const boneMap = withBone(entry.mapping.boneMap, joint, name);
        let outcome: EditOutcome<SpriteDocument>;
        try {
          const issue = mappingIssue(entry.mapping.report, boneMap, entry.hair);
          if (issue === null) {
            waiting = null;
            entry.finish(boneMap);
          } else {
            entry.mapping = Object.freeze({ ...entry.mapping, boneMap, issue });
          }
          outcome = Object.freeze({ kind: 'unchanged', value: primary() });
        } catch (error) {
          outcome = Object.freeze({ kind: 'refused', error: refusal(error) });
        }
        options.onMapping();
        return Promise.resolve(outcome);
      }
      const task = new AbortController();
      return edit({ info: request.info, signal: AbortSignal.any([request.signal, task.signal]) }, (work) => {
        const target = avatarTarget(work);
        if (target.avatar === null || target.model === null) {
          throw new SpriteError('Import a skinned avatar GLB before editing its bone map.');
        }
        // The map resolves against the model the document holds, so it waits for that model's report.
        const report = commands.report(target.model, 'avatar');
        if (report === null) throw new SpriteError('The avatar model is still loading; try again once it appears.');
        return { avatar: target.avatar, model: target.model, report };
      }, async (work, { avatar, model, report }) => {
        const settings = await mapped(work, {
          name: model.name, report, boneMap: withBone(avatar.boneMap, joint, name), driver: avatar.driver, hair: avatar.hair,
          motion: avatar.motion, cancel: () => task.abort(),
        });
        return avatarStep(model, settings, request.info);
      });
    },
    mapping() {
      return waiting?.mapping ?? null;
    },
    cancelAvatar() {
      waiting?.cancel();
    },
    dispose() {
      lifecycle.abort();
    },
  };
  return Object.freeze(imports);
}
