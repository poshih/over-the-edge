declare module 'virtual:workshop-levels' {
  // The levels folder's levels this Workshop serves, by file name, with each level's own name.
  const levels: readonly import('./server-levels').ServerLevel[];
  export default levels;
}
