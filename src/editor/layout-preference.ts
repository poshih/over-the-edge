/** Layout preferences are disposable; only unavailable storage, invalid JSON and wrong shapes are forgotten. */
export function readLayoutPreference<T>(key: string, decode: (value: unknown) => T | null): T | null {
  let text: string | null;
  try {
    text = localStorage.getItem(key);
  } catch (error) {
    if (error instanceof DOMException) return null;
    throw error;
  }
  if (text === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
  return decode(value);
}

/** Failed disposable writes leave the caller's session state intact. */
export function writeLayoutPreference(key: string, value: object): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (error) {
    if (!(error instanceof DOMException)) throw error;
  }
}
