declare module 'virtual:game-title' {
  const title: string;
  export default title;
}

declare module 'virtual:game-level' {
  const level: import('./level').LevelDefinition;
  export default level;
}

declare module 'virtual:game-art' {
  const loadArtwork: (game: import('./game').Game) => Promise<void>;
  export default loadArtwork;
}

declare module 'virtual:game-settings' {
  const settings: import('./game-settings').GameSettings;
  export default settings;
}

declare module 'virtual:game-sprites' {
  const sprites: import('./sprite-data').SpriteDocument;
  export default sprites;
}

declare module 'virtual:game-alternate-sprites' {
  const sprites: import('./sprite-data').SpriteDocument | null;
  export default sprites;
}

declare module 'virtual:game-character-models' {
  const loader: import('./character-model-types').CharacterModelLoader | null;
  export default loader;
}
