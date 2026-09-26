import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';
import { ART_LIMITS } from '../src/art-types';
import { embeddedGlb, isCoursePackage, validateCoursePackage } from '../src/course-package';
import { DEFAULT_LEVEL } from '../src/default-level';
import { LEVEL_LIMITS, validateLevel } from '../src/level';
import { validateCourseModel } from '../src/course-art-model';

const LEVEL = '\0virtual:game-level';
const ART = '\0virtual:game-art';

// `source` is a level or course package JSON path, an already-validated project course, or null
// for the built-in course.
export function courseBundle(source: string | null | { readonly value: unknown }, selectedMode: string | undefined): Plugin {
  const path = typeof source === 'string' ? source : null;
  if (selectedMode !== undefined && selectedMode !== 'shapes' && selectedMode !== 'meshes') {
    throw new Error('GAME_ART_MODE must be shapes or meshes.');
  }
  let building = false;
  return {
    name: 'game-course-data',
    configResolved(config) { building = config.command === 'build'; },
    resolveId(id) {
      if (id === 'virtual:game-level') return LEVEL;
      if (id === 'virtual:game-art') return ART;
    },
    load(id) {
      if (id !== LEVEL && id !== ART) return;
      let raw: unknown = source !== null && typeof source === 'object' ? source.value : DEFAULT_LEVEL;
      let bytes = 0;
      if (path !== null) {
        bytes = statSync(path).size;
        if (bytes > ART_LIMITS.packageBytes) throw new Error('GAME_LEVEL exceeds the course package size limit.');
        this.addWatchFile(path);
        raw = JSON.parse(readFileSync(path, 'utf8'));
      }
      const pack = isCoursePackage(raw) ? validateCoursePackage(raw) : null;
      if (pack === null && bytes > LEVEL_LIMITS.fileBytes) throw new Error('GAME_LEVEL exceeds the level JSON size limit.');
      const level = pack?.level ?? validateLevel(raw);
      if (id === LEVEL) return `export default ${JSON.stringify(level)};`;
      const mode = selectedMode ?? pack?.mode ?? 'shapes';
      if (mode === 'shapes') return 'export default async function loadArtwork() {}';
      const ids = new Set(level.objects.flatMap((object) => object.kind === 'terrain' && object.art ? [object.art.assetId] : []));
      if (ids.size > 0 && pack === null) throw new Error('Mesh artwork needs a self-contained course package, not level JSON containing only asset IDs.');
      let pixels = 0;
      const resources = (pack?.assets ?? []).filter((asset) => ids.has(asset.id)).map((asset) => {
        const bytes = embeddedGlb(asset.source);
        pixels += validateCourseModel(bytes.buffer).pixels;
        if (pixels > ART_LIMITS.texturePixels) throw new Error('Course artwork exceeds 32 million decoded texture pixels.');
        const hash = createHash('sha256').update(bytes).digest('hex');
        if (asset.id !== `asset-${hash}`) throw new Error(`Packaged asset "${asset.name}" does not match its content hash.`);
        const reference = building ? this.emitFile({ type: 'asset', name: `${asset.id}.glb`, source: bytes }) : null;
        return `{id:${JSON.stringify(asset.id)},name:${JSON.stringify(asset.name)},source:${
          reference === null ? JSON.stringify(asset.source) : `import.meta.ROLLUP_FILE_URL_${reference}`}}`;
      });
      const module = fileURLToPath(new URL('../src/course-art-view.ts', import.meta.url));
      return `import {CourseArtView} from ${JSON.stringify(module)};
        export default async function loadArtwork(game) {
          const art = new CourseArtView({
            terrain:game.view.terrain,subscribe:listener=>game.simulation.subscribeTerrain(listener),
            onMissing:message=>{throw new Error(message)}
          });
          game.view.addLayer(art);
          await art.load([${resources.join(',')}]);
          art.setMode('meshes');
        }`;
    },
    handleHotUpdate(context) {
      if (path === null || context.file !== path) return;
      for (const id of [LEVEL, ART]) {
        const module = context.server.moduleGraph.getModuleById(id);
        if (module) context.server.moduleGraph.invalidateModule(module);
      }
      context.server.ws.send({ type: 'full-reload' });
      return [];
    },
  };
}
