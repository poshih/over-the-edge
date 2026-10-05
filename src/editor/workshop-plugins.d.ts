// Only the Workshop serves these entries; shape and contributions validate in the browser, including on HMR.
declare module 'virtual:game-plugins/workshop' {
  const entries: readonly import('../plugins/kernel').PluginEntry<import('./workshop-sdk').WorkshopFacet>[];
  export default entries;
}
