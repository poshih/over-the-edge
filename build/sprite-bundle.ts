import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import type { Plugin } from 'vite';
import { embeddedPng, EMPTY_SPRITES, parseSpriteDocument, SPRITE_LIMITS, validateSpriteAnchors } from '../src/sprite-data';

const MODULE = 'virtual:game-sprites';
const RESOLVED = `\0${MODULE}`;

export function spriteBundle(options: { path: string | null; anchors: readonly string[]; targets: readonly string[] }): Plugin {
  let building = false;
  const emitted = new Map<string, string>();
  return {
    name: 'game-sprite-data',
    configResolved(config) { building = config.command === 'build'; },
    buildStart() { emitted.clear(); },
    resolveId(id) { if (id === MODULE) return RESOLVED; },
    load(id) {
      if (id !== RESOLVED) return;
      let document = EMPTY_SPRITES;
      if (options.path !== null) {
        if (statSync(options.path).size > SPRITE_LIMITS.documentBytes) throw new Error('GAME_SPRITES exceeds the sprite document size limit.');
        this.addWatchFile(options.path);
        document = parseSpriteDocument(readFileSync(options.path, 'utf8'), { onMigration: message => this.warn(message) });
        validateSpriteAnchors(document, options.anchors, options.targets);
      }
      if (!building) return `export default ${JSON.stringify(document)};`;
      const images = document.images.map(image => {
        const bytes = embeddedPng(image.source);
        let source = JSON.stringify(image.source);
        if (bytes !== null) {
          const hash = createHash('sha256').update(bytes).digest('hex');
          let reference = emitted.get(hash);
          if (reference === undefined) {
            reference = this.emitFile({ type: 'asset', name: 'sprite.png', source: bytes });
            emitted.set(hash, reference);
          }
          source = `import.meta.ROLLUP_FILE_URL_${reference}`;
        }
        return `{id:${JSON.stringify(image.id)},name:${JSON.stringify(image.name)},source:${source}}`;
      });
      return `export default {schemaVersion:${document.schemaVersion},characterRiggingType:${JSON.stringify(document.characterRiggingType)},armForwardDistance:${document.armForwardDistance},images:[${images.join(',')}],layers:${JSON.stringify(document.layers)},skeleton:${JSON.stringify(document.skeleton)},presentation:${JSON.stringify(document.presentation)}};`;
    },
    handleHotUpdate(context) {
      if (context.file !== options.path) return;
      const module = context.server.moduleGraph.getModuleById(RESOLVED);
      if (module) context.server.moduleGraph.invalidateModule(module);
      context.server.ws.send({ type: 'full-reload' });
      return [];
    },
  };
}
