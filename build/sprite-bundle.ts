import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';
import { embeddedPng, EMPTY_SPRITES, parseSpriteDocument, SPRITE_FILE_BYTES, validateSpriteAnchors } from '../src/sprite-data';
import type { SpriteDocument } from '../src/sprite-data';
import { characterModel, embeddedModel } from '../src/character-profile';
import { inspectCharacterModel, resolveAvatarJoints } from '../src/character-model-inspect';

const PRIMARY = 'virtual:game-sprites';
const ALTERNATE = 'virtual:game-alternate-sprites';
const MODELS = 'virtual:game-character-models';
const RESOLVED = { primary: `\0${PRIMARY}`, alternate: `\0${ALTERNATE}`, models: `\0${MODELS}` } as const;
const LOADER = fileURLToPath(new URL('../src/character-model-loader.ts', import.meta.url));

// Validates character GLBs against MODEL_LIMITS, their skins, bone maps and prop conventions, as the loader will.
function validateModels(document: SpriteDocument, variable: string): void {
  const profiles = [['avatar', document.avatar], ['hammer', document.hammer], ['pot', document.pot]] as const;
  for (const [usage, profile] of profiles) {
    if (profile === undefined) continue;
    const model = characterModel(document, profile.model);
    const bytes = embeddedModel(model.source);
    if (bytes === null) {
      throw new Error(`${variable}: character model "${model.name}" must be an embedded GLB so the build can validate it.`);
    }
    try {
      const report = inspectCharacterModel(bytes.buffer, usage);
      if (document.avatar !== undefined && usage === 'avatar') resolveAvatarJoints(report, document.avatar.boneMap);
    } catch (error) {
      throw new Error(`${variable}: ${usage} model "${model.name}": ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
  }
}

export function spriteBundle(options: {
  path: string | null;
  alternatePath: string | null;
  anchors: readonly string[];
  targets: readonly string[];
}): Plugin {
  let building = false;
  const emitted = new Map<string, string>();
  const documents = new Map<string, SpriteDocument>();
  const watched = new Set<string>([options.path, options.alternatePath].filter((path): path is string => path !== null));
  return {
    name: 'game-sprite-data',
    configResolved(config) { building = config.command === 'build'; },
    buildStart() {
      emitted.clear();
      documents.clear();
    },
    resolveId(id) {
      if (id === PRIMARY) return RESOLVED.primary;
      if (id === ALTERNATE) return RESOLVED.alternate;
      if (id === MODELS) return RESOLVED.models;
    },
    load(id) {
      if (id !== RESOLVED.primary && id !== RESOLVED.alternate && id !== RESOLVED.models) return;
      const profile = (path: string | null, variable: string): SpriteDocument | null => {
        if (path === null) return null;
        this.addWatchFile(path);
        let document = documents.get(path);
        if (document !== undefined) return document;
        if (statSync(path).size > SPRITE_FILE_BYTES) throw new Error(`${variable} exceeds the profile size limit.`);
        document = parseSpriteDocument(readFileSync(path, 'utf8'), { onMigration: message => this.warn(message) });
        validateSpriteAnchors(document, options.anchors, options.targets);
        validateModels(document, variable);
        documents.set(path, document);
        return document;
      };
      const primary = profile(options.path, 'GAME_SPRITES') ?? EMPTY_SPRITES;
      const alternate = profile(options.alternatePath, 'GAME_ALTERNATE_SPRITES');
      if (id === RESOLVED.models) {
        // Releases without imported models include no GLB loader at all.
        return primary.models === undefined && alternate?.models === undefined ? 'export default null;'
          : `import {createCharacterModelLoader} from ${JSON.stringify(LOADER)};\nexport default createCharacterModelLoader();`;
      }
      const document = id === RESOLVED.primary ? primary : alternate;
      if (document === null) return 'export default null;';
      if (!building) return `export default ${JSON.stringify(document)};`;
      const asset = (bytes: Uint8Array, name: string): string => {
        const hash = createHash('sha256').update(bytes).digest('hex');
        let reference = emitted.get(hash);
        if (reference === undefined) {
          reference = this.emitFile({ type: 'asset', name, source: bytes });
          emitted.set(hash, reference);
        }
        return `import.meta.ROLLUP_FILE_URL_${reference}`;
      };
      const images = document.images.map(image => {
        const bytes = embeddedPng(image.source);
        const source = bytes === null ? JSON.stringify(image.source) : asset(bytes, 'sprite.png');
        return `{id:${JSON.stringify(image.id)},name:${JSON.stringify(image.name)},source:${source}}`;
      });
      let code = `export default {schemaVersion:${document.schemaVersion},characterRiggingType:${JSON.stringify(document.characterRiggingType)},armForwardDistance:${document.armForwardDistance},images:[${images.join(',')}],layers:${JSON.stringify(document.layers)},skeleton:${JSON.stringify(document.skeleton)},presentation:${JSON.stringify(document.presentation)}`;
      if (document.models !== undefined) {
        // Each distinct GLB becomes one hashed asset rather than base64 inside executable JavaScript.
        const models = document.models.map(model => {
          const bytes = embeddedModel(model.source)!;
          return `{id:${JSON.stringify(model.id)},name:${JSON.stringify(model.name)},source:${asset(bytes, 'character.glb')}}`;
        });
        code += `,models:[${models.join(',')}]`;
      }
      for (const key of ['avatar', 'hammer', 'pot', 'shading'] as const) {
        if (document[key] !== undefined) code += `,${key}:${JSON.stringify(document[key])}`;
      }
      return `${code}};`;
    },
    handleHotUpdate(context) {
      if (!watched.has(context.file)) return;
      documents.delete(context.file);
      for (const id of Object.values(RESOLVED)) {
        const module = context.server.moduleGraph.getModuleById(id);
        if (module) context.server.moduleGraph.invalidateModule(module);
      }
      context.server.ws.send({ type: 'full-reload' });
      return [];
    },
  };
}
