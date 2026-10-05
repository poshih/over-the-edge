// Shared by build inputs and the extension-qualified, Node-safe content import chain.
export const PLUGIN_ID_LIMIT = 64;
const ID = /^[a-z][a-z0-9-]*$/;

export function isPluginId(value: unknown): value is string {
  return typeof value === 'string' && value.length <= PLUGIN_ID_LIMIT && ID.test(value);
}

export function isNamespacedId(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const slash = value.indexOf('/');
  return slash > 0 && isPluginId(value.slice(0, slash)) && isPluginId(value.slice(slash + 1));
}

export function namespaceOf(value: string): string | null {
  return isNamespacedId(value) ? value.slice(0, value.indexOf('/')) : null;
}
