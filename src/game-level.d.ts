declare module 'virtual:game-title' {
  const title: string;
  export default title;
}

// What the shell pins: the content URL, the manifest and every path of the game group.
declare module 'virtual:game-content' {
  const pins: import('./content').ContentPins;
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
  const Director: typeof import('./audio').AudioDirector | null;
  export default Director;
}

declare module 'virtual:game-decorations' {
  const create: typeof import('./decoration-library').createDecorationView | null;
  export default create;
}

// Phantoms, when the build has GAME_PHANTOMS_URL, or null.
declare module 'virtual:game-phantoms' {
  const phantoms: import('./phantoms').PhantomBuild | null;
  export default phantoms;
}

// The game's own module (GAME_MODULE), or null.
declare module 'virtual:game-module' {
  const start: import('./release-module').StartRelease | null;
  export default start;
}

// The trusted rig registry both the game shell and the Workshop build from AVATAR_RIG_MODULE (or the
// standard registry without one). The same registry reaches GameView before any character loads.
declare module 'virtual:avatar-rigs' {
  const registry: import('./avatar-rig').AvatarRigRegistry;
  export default registry;
}
