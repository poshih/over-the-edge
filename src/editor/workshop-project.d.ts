declare module 'virtual:workshop-project' {
  // The game this Workshop was built with (GAME_PROJECT), or null.
  const project: import('./published-project').PublishedProject | null;
  export default project;
}
