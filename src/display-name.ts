// A name people read, such as the game's title or a level's: plain text on one line, with no control characters or line
// breaks, and 1 to DISPLAY_NAME_LIMIT characters, counted as code points, once the spaces around it are trimmed.
export const DISPLAY_NAME_LIMIT = 80;

const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;

// `value` trimmed, or null when it is not such a name.
export function displayName(value: string): string | null {
  if (CONTROL.test(value)) return null;
  const name = value.trim();
  const length = Array.from(name).length;
  return length >= 1 && length <= DISPLAY_NAME_LIMIT ? name : null;
}
