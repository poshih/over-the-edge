declare module 'virtual:game-title' {
  const title: string;
  export default title;
}

// What the shell pins: the content URL, the manifest and every path of the game group. Beside them, the course the
// content's level and physics make: the SHA-256 that phantom recordings and saved runs belong to.
declare module 'virtual:game-content' {
  const pins: import('./content').ContentPins;
  export const course: string;
  export default pins;
}

// Each loader is null when the release's content does not need it, so the shell omits its code.
declare module 'virtual:game-character-models' {
  const create: typeof import('./character-model-loader').createCharacterModelLoader | null;
  export default create;
}

declare module 'virtual:game-art' {
  const load: typeof import('./release-art').loadCourseArt | null;
  export default load;
}

declare module 'virtual:game-appearance' {
  const load: typeof import('./appearance-loader').loadAppearance | null;
  export default load;
}

declare module 'virtual:game-audio' {
  const create: import('./game-audio').GameAudioFactory | null;
  export default create;
}

declare module 'virtual:game-decorations' {
  const create: typeof import('./decoration-library').createDecorationView | null;
  export default create;
}

// Phantoms, when the build has GAME_PHANTOMS_URL or bundles recordings, or null.
declare module 'virtual:game-phantoms' {
  const phantoms: import('./phantoms').PhantomBuild | null;
  export default phantoms;
}

declare module 'virtual:game-plugins/kinds' {
  const kinds: import('./plugins/kinds').Kinds;
  export const plugins: readonly { readonly id: string; readonly facets: readonly import('./plugins/kernel').PluginEnvironment[] }[];
  export default kinds;
}

declare module 'virtual:game-plugins/runtime' {
  const entries: readonly import('./plugins/kernel').PluginEntry<import('./plugins/runtime').RuntimeFacet>[];
  export default entries;
}

declare module 'virtual:game-plugins/release' {
  const entries: readonly import('./plugins/kernel').PluginEntry<import('./plugins/release').ReleaseFacet>[];
  export default entries;
}
