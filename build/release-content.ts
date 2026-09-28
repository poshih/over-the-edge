import { createHash } from 'node:crypto';
import { audioSources, hasAudio } from '../src/audio-settings';
import {
  CONTENT_FORMAT, CONTENT_LIMITS, CONTENT_SCHEMA_VERSION, contentFilePath, contentRef, GAME_GROUP, levelMediaSources,
  levelSoundSources, validateContentManifest,
} from '../src/content';
import type { ContentPins } from '../src/content';
import type { ContentExtension } from '../src/content-ref';
import { embeddedModel } from '../src/character-profile';
import { mediaExtension } from '../src/media';
import { embeddedPng } from '../src/sprite-data';
import type { SpriteDocument } from '../src/sprite-data';
import type { ReleaseInput } from './release-input';

// A game build's content output: every file by path, including the manifest, and what the shell pins.
export interface ReleaseContent {
  readonly files: ReadonlyMap<string, Uint8Array>;
  readonly pins: Omit<ContentPins, 'contentUrl'>;
  // Which runtime loaders the shell needs; a release that uses none of a kind omits its code.
  readonly uses: { readonly models: boolean; readonly art: boolean; readonly appearance: boolean; readonly audio: boolean };
}

const PACKAGED = 'A game build packages every asset';

/**
 * Packages a validated release: every image, model and media file becomes one content file named
 * by its SHA-256, and the manifest names them with content: sources. The output depends only on
 * the input, so two builds of the same game write identical content wherever it is served.
 */
export function packReleaseContent(input: ReleaseInput): ReleaseContent {
  const files = new Map<string, Uint8Array>();
  const add = (bytes: Uint8Array, extension: ContentExtension): string => {
    const path = contentFilePath(GAME_GROUP, createHash('sha256').update(bytes).digest('hex'), extension);
    files.set(path, bytes);
    return contentRef(path);
  };
  const character = (document: SpriteDocument, label: string): SpriteDocument => {
    const images = document.images.map(image => {
      const bytes = embeddedPng(image.source);
      if (bytes === null) throw new Error(`${label} image "${image.name}" is ${image.source.slice(0, 120)}. ${PACKAGED}, so embed the PNG in the profile.`);
      return { ...image, source: add(bytes, 'png') };
    });
    const models = document.models?.map(model => {
      const bytes = embeddedModel(model.source);
      if (bytes === null) throw new Error(`${label} model "${model.name}" must be an embedded GLB. ${PACKAGED}.`);
      return { ...model, source: add(bytes, 'glb') };
    });
    return { ...document, images, ...(models === undefined ? {} : { models }) };
  };
  const media: Record<string, string> = {};
  for (const entry of input.media) media[entry.path] = add(entry.bytes, mediaExtension(entry.path));
  for (const [owner, sources] of [['The level', levelMediaSources(input.level)], ['The audio', audioSources(input.audio)]] as const) {
    for (const source of sources) {
      if (!Object.hasOwn(media, source)) throw new Error(`${owner} plays ${source}. ${PACKAGED}, so play a /media/ file the game includes.`);
    }
  }
  const draft = {
    format: CONTENT_FORMAT, schemaVersion: CONTENT_SCHEMA_VERSION,
    level: input.level, settings: input.settings, theme: input.theme, hud: input.hud, enemies: input.enemies,
    armIk: input.armIk, audio: input.audio,
    characters: {
      primary: character(input.primary, 'The primary character'),
      alternate: input.alternate === null ? null : character(input.alternate, 'The alternate character'),
    },
    appearance: input.appearance.map(part => ({ part: part.part, name: part.name, alignment: part.alignment, source: add(part.bytes, 'glb') })),
    art: { mode: input.art.mode, assets: input.art.assets.map(asset => ({ id: asset.id, name: asset.name, source: add(asset.bytes, 'glb') })) },
    media,
    files: Object.fromEntries([...files].map(([path, bytes]) => [path, bytes.byteLength])),
  };
  // The manifest is written as the release will read it back.
  const manifest = new TextEncoder().encode(JSON.stringify(validateContentManifest(draft)));
  if (manifest.byteLength > CONTENT_LIMITS.manifestBytes) throw new Error('The release content manifest exceeds its size limit.');
  const manifestPath = contentFilePath(GAME_GROUP, createHash('sha256').update(manifest).digest('hex'), 'json');
  files.set(manifestPath, manifest);
  const { primary, alternate } = draft.characters;
  return {
    files,
    pins: { manifest: manifestPath, manifestBytes: manifest.byteLength, game: [...files.keys()].sort() },
    uses: {
      models: primary.models !== undefined || alternate?.models !== undefined,
      art: draft.art.assets.length > 0,
      appearance: draft.appearance.length > 0,
      audio: hasAudio(input.audio) || levelSoundSources(input.level).length > 0,
    },
  };
}
