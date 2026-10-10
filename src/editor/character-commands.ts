import { AVATAR_MOTION_LIMITS, NO_AVATAR_MOTION, validateAvatarMotion } from '../avatar-motion-data';
import type { AvatarMotionEntry } from '../avatar-motion-data';
import type { AvatarRigRegistry, PreparedAvatarRig, RunningAvatarMotions } from '../avatar-rig';
import { SPRITE_TARGET_IDS, VISUAL_PART_IDS } from '../character';
import { checkEmbeddedCharacterModels } from '../character-model-check';
import type { CharacterModelReport, CharacterModelUsage } from '../character-model-inspect';
import {
  characterAssets, characterModel, checkEmbeddedModel, validateAvatarModelSettings, validateCharacterModels,
} from '../character-profile';
import type { AvatarModelProfile, CharacterModel, PropModelRole } from '../character-profile';
import { DirectionalError, validateDirectionalPresentation } from '../directional-data';
import { FACING_DIRECTIONS, SKELETON_LIMITS, SkeletonError, validateSkeleton } from '../skeleton-data';
import { autoWeights, restPose } from '../skeleton-pose';
import {
  DEFAULT_SPRITE_RIGGING, embeddedPng, EMPTY_SPRITES, FLIPBOOK_LIMITS, flipbookSizeMessage, inspectPng, SPRITE_LIMITS,
  SpriteError, spriteLayerImages, validateArmForwardDistance, validateArms, validateCharacterRiggingType, validateGrips,
  validateSpriteAnchors, validateSpriteBudget, validateSpriteDocument, validateSpriteLayer, validateSpriteRigging,
  validateWaistLean,
} from '../sprite-data';
import type { SpriteDocument, SpriteImage, SpriteLayer } from '../sprite-data';
import { text } from '../sprite-fields';
import type { Command } from './document/history';
import { keep } from './document/project-commands';
import type { ProjectCommandInfo } from './document/project-commands';
import type { ProjectDocument, SomeSectionChange } from './document/project-document';
import { adapterFor } from './document/sections';
import type { CharacterCommands, SpriteLayerEdit } from './document/visual-contract';
import type { SpriteAnchorInput } from './sprite-state';

// A PNG an import read, checked and decoded, with its size in pixels.
export interface CharacterImage {
  readonly name: string;
  readonly source: string;
  readonly width: number;
  readonly height: number;
}

/** CharacterCommands, and the builders the character's own imports, Revert and New use, under the same rules. */
export interface PrimaryCommands extends CharacterCommands {
  // The exact profile a save holds, or EMPTY_SPRITES for New; refused unless the character can hold it as it is.
  stored(value: SpriteDocument, info: ProjectCommandInfo): Command;
  // A new layer `id` showing `image` on `anchor`, fitted to its bounds; a PNG the profile holds already is shared.
  imageLayer(id: string, image: CharacterImage, anchor: string, info: ProjectCommandInfo): Command;
  // Layer `id` showing `frames` by aim, in order, keeping its start angle and, where it still fits, its hysteresis.
  frames(id: string, frames: readonly CharacterImage[], info: ProjectCommandInfo): Command;
  // `value` checked once as a whole profile, before the step that takes it.
  checked(value: unknown): SpriteDocument;
  // Keeps the report an import inspected of `model` for the step that takes it.
  inspected(model: CharacterModel, report: CharacterModelReport): void;
  // `model`'s report, its import's or the rendered model's; null while the model loads.
  report(model: CharacterModel, usage: CharacterModelUsage): CharacterModelReport | null;
}

export interface CharacterCommandsOptions {
  readonly document: ProjectDocument;
  readonly anchors: readonly SpriteAnchorInput[];
  readonly targetIds: readonly string[];
  readonly avatarRigs: AvatarRigRegistry;
  // Reports of the models the character rig has loaded.
  readonly describeModel: (source: string, usage: CharacterModelUsage) => CharacterModelReport | null;
}

interface Assets {
  readonly avatar: { readonly model: CharacterModel; readonly profile: AvatarModelProfile } | null;
  readonly hammer: CharacterModel | null;
  readonly pot: CharacterModel | null;
}

// An avatar's model fitted to its bone map by a motion check, and the motions the latest check prepared on it.
interface FittedAvatar {
  readonly boneMap: AvatarModelProfile['boneMap'];
  readonly resolved: PreparedAvatarRig['resolved'];
  readonly binds: PreparedAvatarRig['binds'];
  readonly running: RunningAvatarMotions;
}

const NO_CHANGES: readonly SomeSectionChange[] = Object.freeze([]);
const PRIMARY = adapterFor('characters/primary');
const DEFAULT_FLIPBOOK_HYSTERESIS = 1;

function nextId(prefix: string, taken: ReadonlySet<string>): string {
  let index = taken.size + 1;
  let candidate = `${prefix}-${index}`;
  while (taken.has(candidate)) {
    index += 1;
    candidate = `${prefix}-${index}`;
  }
  return candidate;
}

// A free ID for a new layer of `profile`.
export function freeLayerId(profile: SpriteDocument): string {
  return nextId('layer', new Set(profile.layers.map((layer) => layer.id)));
}

// A Sprites step's selection names each target with its kind, as in "layer:layer-2" or "bone:bone-1", so each editor
// restores its own targets on Undo and Redo.
export function selectionEntry(kind: string, id: string): string {
  return `${kind}:${id}`;
}

// The IDs of `kind` a step's selection names, in order.
export function selectionIds(entries: readonly string[], kind: string): string[] {
  const prefix = `${kind}:`;
  return entries.flatMap((entry) => entry.startsWith(prefix) ? [entry.slice(prefix.length)] : []);
}

// Skeleton and directional refusals are the character's.
function sprite<T>(run: () => T): T {
  try {
    return run();
  } catch (error) {
    if (error instanceof SkeletonError || error instanceof DirectionalError) throw new SpriteError(error.message, { cause: error });
    throw error;
  }
}

// Drops images no layer displays any more, as the profile format requires.
function usedImages(images: readonly SpriteImage[], layers: readonly SpriteLayer[]): readonly SpriteImage[] {
  const used = new Set(layers.flatMap(spriteLayerImages));
  return images.every((image) => used.has(image.id)) ? images : Object.freeze(images.filter((image) => used.has(image.id)));
}

// `next`'s entries, each one equal to `current`'s of its ID being that one.
function keyed<T extends { readonly id: string }>(next: readonly T[], current: readonly T[] | undefined): readonly T[] {
  const previous = new Map((current ?? []).map((entry) => [entry.id, entry]));
  const entries = next.map((entry) => keep(entry, previous.get(entry.id)));
  if (current !== undefined && entries.length === current.length && entries.every((entry, index) => entry === current[index])) {
    return current;
  }
  return entries.every((entry, index) => entry === next[index]) ? next : Object.freeze(entries);
}

// `next`, a checked profile, sharing `current`'s equal branches. Images, layers and models match by ID, so a removal or
// a reorder keeps the others, embedded sources and all.
function keepProfile(next: SpriteDocument, current: SpriteDocument): SpriteDocument {
  if (next === current) return current;
  let equal = Object.keys(next).length === Object.keys(current).length;
  let reused = false;
  const entries = Object.entries(next).map(([key, value]: [string, unknown]): [string, unknown] => {
    const previous: unknown = Reflect.get(current, key);
    const kept = key === 'images' || key === 'layers' || key === 'models'
      ? keyed(value as readonly { readonly id: string }[], previous as readonly { readonly id: string }[] | undefined)
      : keep(value, previous);
    if (!Object.hasOwn(current, key) || kept !== previous) equal = false;
    if (kept !== value) reused = true;
    return [key, kept];
  });
  if (equal) return current;
  return reused ? Object.freeze(Object.fromEntries(entries)) as SpriteDocument : next;
}

// The profile's sprite fields, without its character assets.
function spriteFields(profile: SpriteDocument): Omit<SpriteDocument, 'models' | 'avatar' | 'hammer' | 'pot'> {
  const { schemaVersion, characterRiggingType, armForwardDistance, waistLean, grips, arms, images, layers, skeleton, presentation } = profile;
  return { schemaVersion, characterRiggingType, armForwardDistance, waistLean, grips, arms, images, layers, skeleton, presentation };
}

function fitWithinAnchor(anchor: SpriteAnchorInput, size: { readonly width: number; readonly height: number }): { width: number; height: number } {
  const scale = Math.min(anchor.width / size.width, anchor.height / size.height);
  if (!Number.isFinite(scale) || scale <= 0) {
    throw new SpriteError(`Anchor "${anchor.id}" has no usable size to fit this image.`);
  }
  return { width: size.width * scale, height: size.height * scale };
}

function assetsOf(profile: SpriteDocument): Assets {
  return {
    avatar: profile.avatar === undefined ? null : { model: characterModel(profile, profile.avatar.model), profile: profile.avatar },
    hammer: profile.hammer === undefined ? null : characterModel(profile, profile.hammer.model),
    pot: profile.pot === undefined ? null : characterModel(profile, profile.pot.model),
  };
}

function checkedModel(model: CharacterModel): CharacterModel {
  if (!Object.isFrozen(model)) throw new Error('A character model must be frozen.');
  validateCharacterModels([model]);
  checkEmbeddedModel(model);
  return model;
}

/**
 * The primary character's commands. Each validates what it changes against the whole profile, as the profile format
 * and this Workshop's anchors require, and builds the next root from the current one, so an ordinary edit reads no
 * embedded source and serialises nothing. Whole profiles are checked once per root.
 */
export function createCharacterCommands(options: CharacterCommandsOptions): PrimaryCommands {
  const anchors: ReadonlyMap<string, SpriteAnchorInput> = new Map(options.anchors.map((anchor) => [anchor.id, anchor]));
  const anchorIds = [...anchors.keys()];
  const { targetIds, avatarRigs } = options;
  // Roots known to hold as the primary character, embedded models checked; an edit of one makes another.
  const profiles = new WeakSet<SpriteDocument>([EMPTY_SPRITES]);
  // Roots known to hold in both character sections.
  const stored = new WeakSet<SpriteDocument>();
  const reports = new WeakMap<CharacterModel, CharacterModelReport>();
  const fitted = new WeakMap<CharacterModelReport, FittedAvatar>();
  const sizes = new WeakMap<SpriteImage, { readonly width: number; readonly height: number } | null>();

  // Checks `profile`, an edit of `before`, which holds, as far as the edit reaches: the rigging when the skeleton or a
  // layer's bone or mesh changed, and the anchors, IK targets and directional references when they or the layers they
  // name changed. Unchanged branches keep their checks, so a scrub costs only what it changes.
  function validate(profile: SpriteDocument, before: SpriteDocument): void {
    if (profile.images.length > SPRITE_LIMITS.images || profile.layers.length > SPRITE_LIMITS.layers) {
      throw new SpriteError(`Sprite documents allow at most ${SPRITE_LIMITS.images} images and ${SPRITE_LIMITS.layers} layers.`);
    }
    let rigging = profile.skeleton !== before.skeleton;
    let anchored = rigging || profile.presentation !== before.presentation ||
      profile.characterRiggingType !== before.characterRiggingType || profile.layers.length !== before.layers.length;
    if (profile.layers !== before.layers && !rigging) {
      const previous = new Map(before.layers.map((layer) => [layer.id, layer]));
      for (const layer of profile.layers) {
        const was = previous.get(layer.id);
        if (was === layer) continue;
        if (was === undefined || layer.bone !== was.bone || layer.skin !== was.skin) rigging = anchored = true;
        else if (layer.anchor !== was.anchor) anchored = true;
      }
    }
    if (rigging) validateSpriteRigging(profile.layers, profile.skeleton);
    if (anchored) validateSpriteAnchors(profile, anchorIds, targetIds);
    validateSpriteBudget(profile);
  }

  // A whole profile, checked as the format and this Workshop's anchors require, each model it embeds as releases check
  // it; models given by URL are checked as they load.
  function whole(value: unknown): SpriteDocument {
    const profile = validateSpriteDocument(value);
    validateSpriteAnchors(profile, anchorIds, targetIds);
    checkEmbeddedCharacterModels(profile, 'Character profile', avatarRigs);
    return profile;
  }

  function checked(value: unknown): SpriteDocument {
    if (typeof value === 'object' && value !== null && profiles.has(value as SpriteDocument)) return value as SpriteDocument;
    const profile = sprite(() => whole(value));
    profiles.add(profile);
    return profile;
  }

  // `value` itself, a root a section or a save held.
  function storedProfile(value: SpriteDocument): SpriteDocument {
    if (profiles.has(value)) return value;
    if (!Object.isFrozen(value)) throw new Error('A stored character profile must be frozen.');
    sprite(() => whole(value));
    profiles.add(value);
    return value;
  }

  function report(model: CharacterModel, usage: CharacterModelUsage): CharacterModelReport | null {
    const inspected = reports.get(model);
    return inspected !== undefined && inspected.usage === usage ? inspected : options.describeModel(model.source, usage);
  }

  function loadedReport(model: CharacterModel, usage: CharacterModelUsage): CharacterModelReport {
    const found = report(model, usage);
    if (found === null) throw new SpriteError(`The ${usage} model is still loading; try again once it appears.`);
    return found;
  }

  // Each kind checks its configuration against the model, as loading the avatar does. The model is fitted once per bone
  // map; later checks prepare only the motions whose configuration changed, keeping the others.
  function checkMotions(modelReport: CharacterModelReport, avatar: AvatarModelProfile, motion: readonly AvatarMotionEntry[]): void {
    const settings = { hair: avatar.hair, motion };
    const fit = fitted.get(modelReport);
    if (fit === undefined || fit.boneMap !== avatar.boneMap) {
      const prepared = avatarRigs.prepare(modelReport, { boneMap: avatar.boneMap, driver: avatar.driver, hair: avatar.hair, motion });
      fitted.set(modelReport, {
        boneMap: avatar.boneMap, resolved: prepared.resolved, binds: prepared.binds, running: { settings, motions: prepared.motions },
      });
      return;
    }
    const motions = avatarRigs.prepareMotions(modelReport, fit.resolved, fit.binds, settings, fit.running);
    fitted.set(modelReport, { ...fit, running: { settings, motions } });
  }

  function imageSize(image: SpriteImage): { readonly width: number; readonly height: number } | null {
    if (sizes.has(image)) return sizes.get(image)!;
    const png = embeddedPng(image.source);
    const size = png === null ? null : Object.freeze(inspectPng(png));
    sizes.set(image, size);
    return size;
  }

  // The decoded-pixel budget of the profile's embedded PNGs, each source counted once.
  function checkPixels(images: readonly SpriteImage[]): void {
    const counted = new Set<string>();
    let pixels = 0;
    for (const image of images) {
      if (counted.has(image.source)) continue;
      counted.add(image.source);
      const size = imageSize(image);
      if (size !== null) pixels += size.width * size.height;
    }
    if (pixels > SPRITE_LIMITS.decodedPixels) throw new SpriteError('The sprite document exceeds its image-memory budget.');
  }

  // The images `layer` shows exist, and a flipbook's embedded frames share one pixel size.
  function checkImages(images: readonly SpriteImage[], layer: SpriteLayer): void {
    let first: { readonly id: string; readonly width: number; readonly height: number } | null = null;
    for (const id of spriteLayerImages(layer)) {
      const image = images.find((candidate) => candidate.id === id);
      if (image === undefined) throw new SpriteError(`Sprite ${layer.id} references missing image "${id}".`);
      const size = layer.flipbook === undefined ? null : imageSize(image);
      if (size === null) continue;
      if (first === null) first = { id, ...size };
      else if (size.width !== first.width || size.height !== first.height) {
        throw new SpriteError(flipbookSizeMessage(layer.name, { id, ...size }, first));
      }
    }
  }

  // `incoming` PNGs among `images`: one the profile holds already is shared, others take free IDs.
  function addImages(images: readonly SpriteImage[], incoming: readonly CharacterImage[]): {
    readonly images: readonly SpriteImage[];
    readonly ids: readonly string[];
  } {
    const list = [...images];
    const taken = new Set(list.map((image) => image.id));
    const ids = incoming.map((value) => {
      const existing = list.find((image) => image.source === value.source);
      if (existing !== undefined) return existing.id;
      const image: SpriteImage = Object.freeze({
        id: nextId('image', taken), name: text(value.name, SPRITE_LIMITS.name, 'Sprite image name'), source: value.source,
      });
      sizes.set(image, Object.freeze({ width: value.width, height: value.height }));
      taken.add(image.id);
      list.push(image);
      return image.id;
    });
    return { images: list.length === images.length ? images : Object.freeze(list), ids };
  }

  function edited(current: SpriteDocument, changes: Partial<SpriteDocument>): SpriteDocument {
    const profile: SpriteDocument = Object.freeze({ ...current, ...changes });
    validate(profile, current);
    return profile;
  }

  function layerIndex(current: SpriteDocument, id: string): number {
    const index = current.layers.findIndex((layer) => layer.id === id);
    if (index < 0) throw new SpriteError(`The character profile has no layer "${id}".`);
    return index;
  }

  function withLayer(current: SpriteDocument, index: number, layer: SpriteLayer, images = current.images): SpriteDocument {
    if (layer === current.layers[index] && images === current.images) return current;
    const layers = Object.freeze(current.layers.map((candidate, at) => at === index ? layer : candidate));
    return edited(current, { images: usedImages(images, layers), layers });
  }

  function editLayer(current: SpriteDocument, id: string, edit: SpriteLayerEdit): SpriteDocument {
    const index = layerIndex(current, id);
    const layer = current.layers[index];
    const flipbook = edit.flipbook === undefined ? layer.flipbook : edit.flipbook ?? undefined;
    const bone = edit.bone === undefined ? layer.bone : edit.bone;
    const skin = edit.skin === undefined ? layer.skin : edit.skin;
    const tileLength = edit.tileLength === undefined ? layer.tileLength : edit.tileLength;
    // The rules a mesh shares with the bone, shaft and flipbook hold while none of them changes, so the layer's checked
    // mesh is kept as it is rather than checked again.
    const kept = skin === layer.skin && bone === layer.bone && tileLength === layer.tileLength && flipbook === layer.flipbook;
    const validated = validateSpriteLayer({
      id, image: flipbook?.images[0] ?? layer.image,
      name: edit.name ?? layer.name,
      anchor: edit.anchor ?? layer.anchor,
      width: edit.width ?? layer.width,
      height: edit.height ?? layer.height,
      offset: { x: edit.x ?? layer.offset.x, y: edit.y ?? layer.offset.y, z: edit.z ?? layer.offset.z },
      rotation: edit.rotation ?? layer.rotation,
      bone,
      directions: edit.directions === undefined ? layer.directions : edit.directions,
      skin: kept ? null : skin,
      tileLength,
      ...(flipbook === undefined ? {} : { flipbook }),
    });
    const next = keep(kept && skin !== null ? Object.freeze({ ...validated, skin }) : validated, layer);
    if (next === layer) return current;
    if (next.image !== layer.image || next.flipbook?.images !== layer.flipbook?.images) checkImages(current.images, next);
    return withLayer(current, index, next);
  }

  // The profile holding `next` as its models, listed in role order: avatar, hammer, pot.
  function withAssets(current: SpriteDocument, next: Assets): SpriteDocument {
    const listed = [next.avatar?.model ?? null, next.hammer, next.pot].filter((model): model is CharacterModel => model !== null);
    if (new Set(listed.map((model) => model.id)).size !== listed.length) {
      throw new SpriteError('The avatar, hammer and pot need separate character models.');
    }
    const previous = current.models;
    const models = listed.length === 0 ? undefined
      : previous !== undefined && listed.length === previous.length && listed.every((model, index) => model === previous[index])
        ? previous : Object.freeze(listed);
    const prop = (role: PropModelRole, model: CharacterModel | null) => model === null ? undefined
      : current[role]?.model === model.id ? current[role] : Object.freeze({ model: model.id });
    const profile: SpriteDocument = Object.freeze({
      ...spriteFields(current),
      ...characterAssets({ models, avatar: next.avatar?.profile, hammer: prop('hammer', next.hammer), pot: prop('pot', next.pot) }),
    });
    validate(profile, current);
    return profile;
  }

  // Entries `current` holds are checked already, so a scrub checks only the configuration it changed.
  function motionList(value: unknown, current: readonly AvatarMotionEntry[]): readonly AvatarMotionEntry[] {
    if (!Array.isArray(value)) return validateAvatarMotion(value);
    if (value.length > AVATAR_MOTION_LIMITS.motions) {
      throw new SpriteError(`The avatar's motion lists at most ${AVATAR_MOTION_LIMITS.motions} motions.`);
    }
    const held = new Set(current);
    const previous = new Map(current.map((entry) => [entry.id, entry]));
    const ids = new Set<string>();
    const entries = value.map((item: unknown): AvatarMotionEntry => {
      const entry = held.has(item as AvatarMotionEntry) ? item as AvatarMotionEntry : validateAvatarMotion([item])[0];
      if (ids.has(entry.id)) throw new SpriteError(`The avatar lists motion "${entry.id}" twice; each kind runs at most once.`);
      ids.add(entry.id);
      return keep(entry, previous.get(entry.id));
    });
    if (entries.length === current.length && entries.every((entry, index) => entry === current[index])) return current;
    return entries.length === 0 ? NO_AVATAR_MOTION : Object.freeze(entries);
  }

  function command(info: ProjectCommandInfo, build: (current: SpriteDocument) => SpriteDocument): Command {
    return Object.freeze({
      label: info.label, place: info.place, coalesce: info.coalesce,
      run(document: ProjectDocument): readonly SomeSectionChange[] {
        if (document !== options.document) throw new Error('Character commands belong to their document.');
        const before = document.get('characters/primary');
        const after = sprite(() => build(before));
        if (after === before) return NO_CHANGES;
        if (profiles.has(before)) profiles.add(after);
        return Object.freeze([PRIMARY.change(before, after)]);
      },
    });
  }

  const commands: PrimaryCommands = {
    checkProfile(value, current) {
      if (value === current) return current;
      const profile = keepProfile(checked(value), current);
      profiles.add(profile);
      return profile;
    },
    checkStoredProfile(value) {
      if (stored.has(value)) return;
      storedProfile(value);
      sprite(() => validateSpriteAnchors(value, VISUAL_PART_IDS, SPRITE_TARGET_IDS));
      stored.add(value);
    },
    profile(value, info, expected) {
      return command(info, (current) => {
        if (expected !== undefined && current !== expected) {
          throw new SpriteError('The character profile changed while this one loaded; load it again.');
        }
        return commands.checkProfile(value, current);
      });
    },
    stored(value, info) {
      return command(info, () => storedProfile(value));
    },
    riggingType(value, info) {
      return command(info, (current) => {
        const characterRiggingType = validateCharacterRiggingType(value, current.layers.length);
        return characterRiggingType === current.characterRiggingType ? current : edited(current, { characterRiggingType });
      });
    },
    armForwardDistance(value, info) {
      return command(info, (current) => {
        const armForwardDistance = validateArmForwardDistance(value);
        return armForwardDistance === current.armForwardDistance ? current : edited(current, { armForwardDistance });
      });
    },
    waistLean(value, info) {
      return command(info, (current) => {
        const waistLean = validateWaistLean(value);
        return waistLean === current.waistLean ? current : edited(current, { waistLean });
      });
    },
    grips(build, info) {
      return command(info, (current) => {
        const grips = keep(validateGrips(build(current.grips)), current.grips);
        return grips === current.grips ? current : edited(current, { grips });
      });
    },
    arms(build, info) {
      return command(info, (current) => {
        const arms = keep(validateArms(build(current.arms)), current.arms);
        return arms === current.arms ? current : edited(current, { arms });
      });
    },
    avatarMotion(build, info) {
      return command(info, (current) => {
        const avatar = current.avatar;
        if (avatar === undefined) throw new SpriteError('Import a skinned avatar GLB before configuring its motions.');
        const motion = motionList(build(avatar.motion), avatar.motion);
        if (motion === avatar.motion) return current;
        checkMotions(loadedReport(characterModel(current, avatar.model), 'avatar'), avatar, motion);
        return edited(current, { avatar: Object.freeze({ ...avatar, motion }) });
      });
    },
    layer(id, edit, info) {
      return command(info, (current) => editLayer(current, id, edit));
    },
    removeLayer(id, info) {
      return command(info, (current) => {
        layerIndex(current, id);
        const layers = Object.freeze(current.layers.filter((layer) => layer.id !== id));
        return edited(current, { images: usedImages(current.images, layers), layers });
      });
    },
    skeleton(build, info) {
      return command(info, (current) => {
        const value = build(current.skeleton);
        const skeleton = value === null ? null : keep(validateSkeleton(value), current.skeleton);
        return skeleton === current.skeleton ? current : edited(current, { skeleton });
      });
    },
    bindMesh(id, { columns, rows, bones }, info) {
      return command(info, (current) => {
        const layer = current.layers[layerIndex(current, id)];
        const skeleton = current.skeleton;
        if (skeleton === null) throw new SpriteError('Create a skeleton before binding a mesh.');
        if (![columns, rows].every((value) => Number.isInteger(value) && value >= 1 && value <= SKELETON_LIMITS.grid)) {
          throw new SpriteError(`Mesh columns and rows must be whole numbers from 1 to ${SKELETON_LIMITS.grid}.`);
        }
        // The mesh binds in skeleton-root space, where the layer shows now.
        let x = layer.offset.x, y = layer.offset.y, rotation = layer.rotation;
        if (layer.bone !== null) {
          const bone = restPose(skeleton).find((candidate) => candidate.id === layer.bone);
          if (bone === undefined) throw new SpriteError('The attached bone is missing.');
          x = bone.x + layer.offset.x * Math.cos(bone.angle) - layer.offset.y * Math.sin(bone.angle);
          y = bone.y + layer.offset.x * Math.sin(bone.angle) + layer.offset.y * Math.cos(bone.angle);
          rotation = ((rotation + bone.angle * 180 / Math.PI) % 360 + 540) % 360 - 180;
        }
        const angle = rotation * Math.PI / 180;
        const positions = [];
        for (let row = 0; row <= rows; row++) for (let column = 0; column <= columns; column++) {
          const across = (column / columns - 0.5) * layer.width;
          const up = (0.5 - row / rows) * layer.height;
          positions.push({
            x: x + across * Math.cos(angle) - up * Math.sin(angle),
            y: y + across * Math.sin(angle) + up * Math.cos(angle),
          });
        }
        const skin = { columns, rows, weights: autoWeights(skeleton, positions, bones) };
        return editLayer(current, id, { skin, bone: null, tileLength: null, x, y, rotation });
      });
    },
    presentation(build, info) {
      return command(info, (current) => {
        const value = build(current.presentation);
        const presentation = value === null ? null : keep(validateDirectionalPresentation(value), current.presentation);
        return presentation === current.presentation ? current : edited(current, { presentation });
      });
    },
    avatar(value, info) {
      return command(info, (current) => {
        const assets = assetsOf(current);
        if (value === null) return assets.avatar === null ? current : withAssets(current, { ...assets, avatar: null });
        const model = checkedModel(value.model);
        const settings = validateAvatarModelSettings(value.settings);
        const profile = keep(Object.freeze({ model: model.id, ...settings }), assets.avatar?.profile);
        if (assets.avatar !== null && assets.avatar.model === model && assets.avatar.profile === profile) return current;
        avatarRigs.prepare(loadedReport(model, 'avatar'), settings);
        return withAssets(current, { ...assets, avatar: { model, profile } });
      });
    },
    prop(role, value, info) {
      return command(info, (current) => {
        const assets = assetsOf(current);
        if (value === null) {
          if (assets[role] === null) return current;
          return withAssets(current, role === 'hammer' ? { ...assets, hammer: null } : { ...assets, pot: null });
        }
        const model = checkedModel(value);
        if (assets[role] === model) return current;
        loadedReport(model, role);
        return withAssets(current, role === 'hammer' ? { ...assets, hammer: model } : { ...assets, pot: model });
      });
    },
    imageLayer(id, image, anchorId, info) {
      return command(info, (current) => {
        const anchor = anchors.get(anchorId);
        if (anchor === undefined) throw new SpriteError(`Unknown sprite anchor "${anchorId}".`);
        if (current.layers.some((layer) => layer.id === id)) throw new SpriteError(`The character profile already has a layer "${id}".`);
        const added = addImages(current.images, [image]);
        const shown = added.images.find((candidate) => candidate.id === added.ids[0])!;
        const size = fitWithinAnchor(anchor, image);
        const layer = validateSpriteLayer({
          ...DEFAULT_SPRITE_RIGGING, id, name: shown.name, anchor: anchor.id, image: shown.id,
          width: size.width, height: size.height, offset: { ...anchor.offset }, rotation: 0,
        });
        const profile = edited(current, { images: added.images, layers: Object.freeze([...current.layers, layer]) });
        if (added.images !== current.images) checkPixels(profile.images);
        return profile;
      });
    },
    frames(id, frames, info) {
      return command(info, (current) => {
        if (frames.length < FLIPBOOK_LIMITS.minimumFrames || frames.length > FLIPBOOK_LIMITS.maximumFrames) {
          throw new SpriteError(`Choose ${FLIPBOOK_LIMITS.minimumFrames}-${FLIPBOOK_LIMITS.maximumFrames} PNG frames for a flipbook.`);
        }
        const index = layerIndex(current, id);
        const layer = current.layers[index];
        const added = addImages(current.images, frames);
        if (new Set(added.ids).size !== added.ids.length) {
          throw new SpriteError('Two chosen flipbook frames are identical PNGs. Choose a distinct image for every frame.');
        }
        const previous = layer.flipbook;
        const halfSpacing = FLIPBOOK_LIMITS.angle / added.ids.length / 2;
        const next = keep(validateSpriteLayer({
          ...layer, image: added.ids[0],
          directions: layer.directions.length === FACING_DIRECTIONS.length ? layer.directions : [...FACING_DIRECTIONS],
          flipbook: {
            images: added.ids,
            startAngle: previous?.startAngle ?? 0,
            hysteresis: previous !== undefined && previous.hysteresis < halfSpacing
              ? previous.hysteresis : Math.min(DEFAULT_FLIPBOOK_HYSTERESIS, halfSpacing / 2),
          },
        }), layer);
        // The frames it shows already, in the same order: nothing changes.
        if (next === layer) return current;
        checkImages(added.images, next);
        const profile = withLayer(current, index, next, added.images);
        checkPixels(profile.images);
        return profile;
      });
    },
    checked,
    inspected(model, inspectedReport) {
      reports.set(model, inspectedReport);
    },
    report,
  };
  return Object.freeze(commands);
}
