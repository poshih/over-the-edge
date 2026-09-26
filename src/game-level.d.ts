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

declare module 'virtual:game-presentation' {
  const presentation: {
    readonly theme: import('./theme').GameTheme;
    readonly hud: import('./hud').HudSettings;
    readonly enemies: import('./enemy-art-data').EnemyArtSettings;
    readonly armIk: Readonly<import('./character').ArmIkSettings>;
  };
  export default presentation;
}

declare module 'virtual:game-appearance' {
  type Visuals = ReadonlyMap<import('./character').VisualPartId, import('./character').VisualBinding>;
  const loadAppearance: ((visuals: Visuals, signal?: AbortSignal) => Promise<unknown>) | null;
  export default loadAppearance;
}

declare module 'virtual:game-audio' {
  const createAudio: ((options: {
    resolve: (source: string) => string;
    onError: (message: string) => void;
  }) => import('./audio').AudioDirector) | null;
  export default createAudio;
}

declare module 'virtual:game-media' {
  // Bundled media files by authored /media/ path.
  const media: Readonly<Record<string, string>>;
  export default media;
}
