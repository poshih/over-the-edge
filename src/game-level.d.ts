declare module 'virtual:game-level' {
  const level: import('./level').LevelDefinition;
  export default level;
}

declare module 'virtual:game-sprites' {
  const sprites: import('./sprite-data').SpriteDocument;
  export default sprites;
}
