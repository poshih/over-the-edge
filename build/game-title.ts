import { loadEnv } from 'vite';
import type { Plugin } from 'vite';
import { DISPLAY_NAME_LIMIT, displayName } from '../src/display-name';

const DEFAULT_TITLE = 'Over the Edge';
const TITLE_PLACEHOLDER = '__GAME_TITLE__';
const TITLE_MODULE = 'virtual:game-title';
const RESOLVED_TITLE_MODULE = `\0${TITLE_MODULE}`;

// `projectTitle` is the title of a GAME_PROJECT release, which must not also receive GAME_TITLE.
export function gameTitle(options: { mode: string; envDir: string; projectTitle?: string }): Plugin {
  if (options.projectTitle !== undefined && process.env.GAME_TITLE !== undefined) {
    throw new Error('GAME_TITLE cannot be combined with GAME_PROJECT; set the title in the project.');
  }
  // .env files may brand the Workshop; a project release always uses the project's title.
  const requested = options.projectTitle === undefined ? loadEnv(options.mode, options.envDir, 'GAME_TITLE').GAME_TITLE : undefined;
  const value = options.projectTitle ?? (requested === undefined ? DEFAULT_TITLE : requested);
  const title = displayName(value);
  if (title === null) throw new Error(`GAME_TITLE must be 1-${DISPLAY_NAME_LIMIT} characters on one line, without control characters.`);
  const escapedTitle = title
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');

  return {
    name: 'game-title',
    resolveId(id) {
      if (id === TITLE_MODULE) return RESOLVED_TITLE_MODULE;
    },
    load(id) {
      if (id === RESOLVED_TITLE_MODULE) return `export default ${JSON.stringify(title)};`;
    },
    transformIndexHtml: {
      order: 'post',
      handler: (html) => html.replaceAll(TITLE_PLACEHOLDER, () => escapedTitle),
    },
  };
}
