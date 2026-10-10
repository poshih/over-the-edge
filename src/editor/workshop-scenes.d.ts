declare module 'virtual:workshop-scenes' {
  // The scenes folder's example scenes this Workshop serves, by folder name, each with its title and files.
  const scenes: readonly import('./published-project').WorkshopScene[];
  export default scenes;
}
