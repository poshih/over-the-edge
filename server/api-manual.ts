import { AUDIO_CUE_DESCRIPTIONS, AUDIO_CUES, AUDIO_VOLUME } from '../src/audio-settings';
import { ALIGNMENT_FIELDS, ARM_IK_FIELDS, ARM_IK_LIMITS } from '../src/appearance-profile';
import { ART_LIMITS } from '../src/art-types';
import { CHARACTER_RIGGING_TYPES } from '../src/sprite-data';
import { VISUAL_PART_IDS } from '../src/character';
import { builtInEnemyArt, ENEMY_ART_LIMITS } from '../src/enemy-art-data';
import { ENEMY_FIELDS, ENEMY_LIMITS, ENEMY_SPECIES } from '../src/enemy-types';
import { CURSOR_FIELDS, TUNING_FIELDS } from '../src/game-settings';
import { HUD_FIELDS } from '../src/hud';
import { LEVEL_LIMITS, SHAPE_KINDS, TRIGGER_LIMITS, TRIGGER_MARKERS } from '../src/level';
import { MEDIA_LIMITS, MEDIA_TYPES } from '../src/media';
import { PROJECT_FILES, PROJECT_LIMITS } from '../src/project';
import { THEME_FIELDS } from '../src/theme';
import { LAUNCH_FIELDS, SOUND_VOLUME } from '../src/trigger-events';

const endpoint = (method: string, path: string, description: string, body?: string) => ({ method, path, description, ...(body ? { body } : {}) });

// A self-describing guide for tools and language models; generated from the validators' own limits.
export function apiManual(auth: 'token' | 'loopback') {
  return {
    name: 'Over the Edge project API',
    version: 1,
    purpose: 'Create and edit complete game projects (level, physics, characters, look, HUD, audio, enemies, media), then publish each as a standalone, editor-free release.',
    auth: auth === 'token'
      ? 'Send Authorization: Bearer <STUDIO_TOKEN> with every request.'
      : 'Requests from this computer through localhost need no token. Set STUDIO_TOKEN to allow other machines.',
    conventions: {
      changes: 'Every POST, PUT, PATCH and DELETE needs the header X-Studio-Request: 1. JSON bodies need Content-Type: application/json; uploads send the raw file bytes with the file\'s type or application/octet-stream.',
      validation: 'Every change is validated before anything is written. A rejected change leaves the project untouched and returns { "error": { "code", "message", "section" } }.',
      patch: 'PATCH applies a JSON merge patch (RFC 7386): objects merge, arrays and other values replace. Unlike RFC 7386, null sets a field to null, because sections have fixed keys.',
      concurrency: 'GET section responses carry ETag: "<section revision>". Send If-Match with that value on a change to fail with 412 if someone else changed the section first. GET /api/projects/{id}/revision is a cheap poll.',
      references: 'Levels and audio may only use /media/ paths that exist in the project media library, and terrain artwork that exists in the course artwork, so every project always builds. Upload files before referencing them.',
      ids: 'Project IDs use lowercase letters, digits and inner hyphens.',
    },
    endpoints: [
      endpoint('GET', '/api', 'This guide.'),
      endpoint('GET', '/api/health', 'Server status; works without a token and reports whether you are authenticated.'),
      endpoint('GET', '/api/projects', 'List projects.'),
      endpoint('POST', '/api/projects', 'Create a project from the built-in course and defaults.', '{ "title": "My Game", "id"?: "my-game" }'),
      endpoint('GET', '/api/projects/{id}', 'Manifest, revisions and file sizes.'),
      endpoint('DELETE', '/api/projects/{id}', 'Delete a project.'),
      endpoint('GET', '/api/projects/{id}/revision', 'Current revision and per-section revisions.'),
      endpoint('GET', '/api/projects/{id}/bundle', 'The whole project as one JSON bundle (add ?download=1 for a file download).'),
      endpoint('PUT', '/api/projects/{id}/bundle', 'Create or replace a project from a bundle.', 'project bundle JSON'),
      endpoint('POST', '/api/projects/{id}/validate', 'Deep check of every file, model and reference.'),
      endpoint('POST', '/api/projects/{id}/publish', 'Build the standalone release into releases/{id}/ and serve it at /play/{id}/.'),
      endpoint('GET', '/api/projects/{id}/publish', 'The latest publish record, or null.'),
      endpoint('GET|PUT|PATCH', '/api/projects/{id}/{section}', 'Read or change one section; see "sections".', 'the section value'),
      endpoint('DELETE', '/api/projects/{id}/characters/{primary|alternate}', 'Remove a character profile (the primary needs the alternate removed first).'),
      endpoint('GET|POST', '/api/projects/{id}/level/objects', 'List objects (?kind=terrain|trigger|enemy|start) or add one object, an array, or { "objects": [...] }.'),
      endpoint('GET|PUT|PATCH|DELETE', '/api/projects/{id}/level/objects/{objectId}', 'Read, replace, merge-patch or delete one level object.'),
      endpoint('GET|PUT', '/api/projects/{id}/level/labels', 'Course labels: [{ "text", "x", "y" }].'),
      endpoint('POST', '/api/projects/{id}/art/assets?name=Stone', 'Upload a static course GLB; returns its content ID for terrain "art": { "assetId", "mirror" }.', 'GLB bytes'),
      endpoint('GET|DELETE', '/api/projects/{id}/art/assets/{assetId}', 'Download or remove course artwork (unused only).'),
      endpoint('GET|PUT|DELETE', '/api/projects/{id}/appearance/{part}/model?name=Torso.glb', 'Per-part GLB replacement for the Mesh parts character.', 'GLB bytes'),
      endpoint('GET|PATCH|DELETE', '/api/projects/{id}/appearance/{part}', 'A part\'s name and alignment.', '{ "alignment"?: {...}, "name"?: "..." }'),
      endpoint('GET|PUT|DELETE', '/api/projects/{id}/media/{file}', 'Media library files, referenced as /media/{file}.', 'file bytes'),
      endpoint('GET', '/play/{id}/', 'The latest published release of a project.'),
    ],
    project: {
      files: PROJECT_FILES,
      layout: 'project.json (manifest), level.json, characters/primary.json and characters/alternate.json (character profiles), art/<assetId>.glb, appearance/<part>.glb, media/<file>.',
      limits: PROJECT_LIMITS,
    },
    sections: {
      title: { value: 'string, 1-80 characters', description: 'Game title: browser tab and release name.' },
      level: {
        value: 'level JSON, schemaVersion 2: { schemaVersion, labels, objects }',
        description: 'The course. Prefer the level/objects endpoints for small edits.',
        limits: { ...LEVEL_LIMITS, triggers: TRIGGER_LIMITS.objects, eventsPerTrigger: TRIGGER_LIMITS.events, enemies: ENEMY_LIMITS.objects },
        objects: {
          terrain: { kind: 'terrain', id: 'ledge-1', shape: { type: `one of ${SHAPE_KINDS.join(', ')}; or { "type": "polygon", "vertices": [{ "x", "y" }] }` }, x: 4, y: 2, width: 3, height: 1, angle: 0, depth: 2, color: 7438714, illusion: false },
          start: { kind: 'start', id: 'start', x: 0, y: 0.53, angle: 0.4, extension: 0.8 },
          trigger: {
            kind: 'trigger', id: 'summit', name: 'Summit', x: 0, y: 40, region: { type: 'circle', radius: 2 },
            activation: 'once | on-enter', marker: TRIGGER_MARKERS.join(' | '),
            events: [{ type: 'stop-timer' }, { type: 'popup', title: 'Summit reached', message: '...' }],
          },
          enemy: { kind: 'enemy', id: 'bird-1', species: ENEMY_SPECIES.join(' | '), x: 3, y: 5, facing: 'left | right', patrolDistance: 3, speed: 1.4 },
        },
        enemyFields: ENEMY_FIELDS,
        triggerEvents: {
          popup: { type: 'popup', title: `<= ${TRIGGER_LIMITS.title} characters`, message: `<= ${TRIGGER_LIMITS.message} characters` },
          'play-video': { type: 'play-video', source: '/media/intro.webm or https URL' },
          'play-sound': { type: 'play-sound', source: '/media/bell.wav or https URL', volume: `${SOUND_VOLUME.min}-${SOUND_VOLUME.max}` },
          'stop-timer': { type: 'stop-timer' },
          'launch-player': { type: 'launch-player', height: `${LAUNCH_FIELDS.height.min}-${LAUNCH_FIELDS.height.max} m`, strength: `${LAUNCH_FIELDS.strength.min}-${LAUNCH_FIELDS.strength.max}` },
        },
        notes: 'Coordinates are metres, y up; angle is radians; terrain color is a 0xRRGGBB integer. A level has exactly one start.',
      },
      settings: { value: '{ schemaVersion: 2, physics: {...}, cursor: { maxRadius } }', patch: true, fields: { physics: TUNING_FIELDS, cursor: CURSOR_FIELDS } },
      'characters/primary': {
        value: 'character profile JSON or null (the procedural Mesh parts character)',
        patch: true,
        description: `Export one from Workshop / Character. characterRiggingType is one of ${CHARACTER_RIGGING_TYPES.join(', ')}. PATCH recomputes schemaVersion. See docs/characters.md and docs/sprites.md.`,
      },
      'characters/alternate': { value: 'character profile JSON or null', patch: true, description: 'A second character players can switch to; needs a primary.' },
      'arm-ik': { value: 'body-relative elbow hints', patch: true, fields: ARM_IK_FIELDS.map((field) => ({ ...field, ...ARM_IK_LIMITS })) },
      appearance: {
        value: '[{ "part", "name", "alignment" }]',
        description: `Per-part GLB replacements. Parts: ${VISUAL_PART_IDS.join(', ')}. Upload a model first; PUT can rename, realign or remove parts.`,
        alignmentFields: ALIGNMENT_FIELDS,
      },
      theme: { value: 'scene look', patch: true, fields: THEME_FIELDS },
      hud: { value: 'release readout', patch: true, fields: HUD_FIELDS },
      audio: {
        value: '{ volume, music: { source, volume } | null, cues: { <cue>: { source, volume } | null } }',
        patch: true, volume: AUDIO_VOLUME,
        cues: Object.fromEntries(AUDIO_CUES.map((cue) => [cue, AUDIO_CUE_DESCRIPTIONS[cue]])),
      },
      enemies: {
        value: '{ <species>: { frames: [[rows], [rows]], palette: { "<char>": "#rrggbb" } } | null }',
        patch: true, species: ENEMY_SPECIES, limits: ENEMY_ART_LIMITS,
        description: 'Replacement pixel art (cosmetic only). Two frames of equal size, rows top to bottom, facing right; "." is transparent.',
        builtIn: Object.fromEntries(ENEMY_SPECIES.map((species) => [species, builtInEnemyArt(species)])),
      },
      art: { value: '{ mode: "shapes" | "meshes", assets: [{ id, name }] }', patch: true, limits: ART_LIMITS, description: 'Course artwork. Upload GLBs with POST art/assets; PUT can rename or drop unused assets and change the mode.' },
      media: { value: '[{ "path": "/media/file.ext" }]', types: MEDIA_TYPES, limits: MEDIA_LIMITS, description: 'Upload with PUT media/{file}; PUT this list to drop unused files.' },
    },
  };
}
