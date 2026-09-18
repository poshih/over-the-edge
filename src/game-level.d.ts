declare module 'virtual:game-level' {
  const level: import('./level').LevelDefinition;
  export default level;
}

declare module 'virtual:game-settings' {
  const settings: import('./game-settings').GameSettings;
  export default settings;
}

declare module 'virtual:game-sprites' {
  const sprites: import('./sprite-data').SpriteDocument;
  export default sprites;
}
