// Where a Workshop's server models are, relative to the repository root: `models/<part>/<name>.glb`, and an avatar's
// model settings beside it in `models/avatar/<name>.json`. No imports, so tools that publish server models share it.
export const SERVER_MODELS = 'models';
export const SERVER_MODEL_SETTINGS_EXTENSION = '.json';

// Where the server avatar `name`'s model settings file is.
export function serverAvatarSettingsFile(name: string): string {
  return `${SERVER_MODELS}/avatar/${name}${SERVER_MODEL_SETTINGS_EXTENSION}`;
}
