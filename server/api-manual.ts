import { AUDIO_CUE_DESCRIPTIONS, AUDIO_CUES, AUDIO_VOLUME } from '../src/audio-settings';
import { ALIGNMENT_FIELDS, ARM_IK_FIELDS, ARM_IK_LIMITS } from '../src/appearance-profile';
import { ART_LIMITS } from '../src/art-types';
import { CHARACTER_RIGGING_TYPES, SPRITE_SCHEMA_VERSION } from '../src/sprite-data';
import { ARM_LENGTH_LIMITS } from '../src/character-arms';
import { GRIP_LIMITS, GRIP_PLACEMENTS, GRIP_RANGE_LIMITS, GRIP_ROTATION_LIMITS, SLIDE_AT_LIMITS } from '../src/grips';
import { WAIST_LEAN_LIMITS } from '../src/waist-lean';
import { VISUAL_PART_IDS } from '../src/character';
import { builtInEnemyArt, ENEMY_ART_LIMITS } from '../src/enemy-art-data';
import { ENEMY_FIELDS, ENEMY_LIMITS, ENEMY_SPECIES } from '../src/enemy-types';
import { CURSOR_FIELDS, RIG_FIELDS, TUNING_FIELDS } from '../src/game-settings';
import { HUD_FIELDS } from '../src/hud';
import { LEVEL_LIMITS, LEVEL_SCHEMA_VERSION, SHAPE_KINDS, TRIGGER_LIMITS, TRIGGER_MARKERS } from '../src/level';
import { BOARD_CELL } from '../src/level-board';
import { MEDIA_LIMITS, MEDIA_TYPES } from '../src/media';
import { MODEL_LIBRARY_LIMITS } from '../src/model-library';
import { PROJECT_FILES, PROJECT_LIMITS } from '../src/project';
import { SHARED_FORMATS, SHARED_KINDS, SHARED_NAME_LIMIT } from '../src/shared-copies';
import type { SharedKind } from '../src/shared-copies';
import { THEME_FIELDS } from '../src/theme';
import { LAUNCH_FIELDS, SOUND_VOLUME } from '../src/trigger-events';

const endpoint = (method: string, path: string, description: string, body?: string) => ({ method, path, description, ...(body ? { body } : {}) });

// What a shared copy of each kind holds: the value of the project section it matches.
const SHARED_VALUES: Readonly<Record<SharedKind, string>> = {
  levels: 'level JSON, as the level section',
  characters: 'character profile JSON, as the characters/primary section',
  'game-settings': 'game settings JSON, as the settings section',
  'arm-ik': 'body-relative elbow hints, as the arm-ik section',
};

// A self-describing guide for tools and language models; generated from the validators' own limits.
export function apiManual(auth: 'token' | 'loopback') {
  return {
    name: 'Over the Edge project API',
    version: 1,
    purpose: 'Create and edit complete game projects (level, physics, characters, look, HUD, audio, enemies, media), then publish each as a standalone, editor-free release. Share named levels, character profiles, game settings and arm IK profiles with every Workshop page.',
    auth: auth === 'token'
      ? 'Send Authorization: Bearer <STUDIO_TOKEN> with every request.'
      : 'Requests from this computer through localhost need no token. Set STUDIO_TOKEN to allow other machines.',
    conventions: {
      changes: 'Every POST, PUT, PATCH and DELETE needs the header X-Studio-Request: 1. JSON bodies need Content-Type: application/json; uploads send the raw file bytes with the file\'s type or application/octet-stream.',
      validation: 'Every change is validated before anything is written. A rejected change leaves the project untouched and returns { "error": { "code", "message", "section" } }.',
      patch: 'PATCH applies a JSON merge patch (RFC 7386): objects merge, arrays and other values replace. Unlike RFC 7386, null sets a field to null, because sections have fixed keys.',
      concurrency: 'GET section responses carry ETag: "<section revision>". Send If-Match with that value on a change to fail with 412 if someone else changed the section first. Editing the project\'s files directly also counts: reads bump the revision of every section whose files changed. GET /api/projects/{id}/revision is a cheap poll.',
      references: 'Levels and audio may only use /media/ paths that exist in the project media library, and terrain artwork that exists in the course artwork, so every project always builds. Every decoration model must be built in or drawn by course artwork. Upload files before referencing them.',
      ids: 'Project IDs and shared copy names use lowercase letters, digits and inner hyphens.',
    },
    endpoints: [
      endpoint('GET', '/api', 'This guide.'),
      endpoint('GET', '/api/health', 'Server status; works without a token and reports whether you are authenticated, and, once you are, the project the Workshop was started with (project, or null).'),
      endpoint('GET', '/api/projects', 'List projects.'),
      endpoint('POST', '/api/projects', 'Create a project from the built-in course and defaults.', '{ "title": "My Game", "id"?: "my-game" }'),
      endpoint('GET', '/api/projects/{id}', 'Manifest, revisions and file sizes.'),
      endpoint('DELETE', '/api/projects/{id}', 'Delete a project.'),
      endpoint('GET', '/api/projects/{id}/revision', 'Current revision and per-section revisions.'),
      endpoint('GET', '/api/projects/{id}/bundle', 'The whole project as one JSON bundle (add ?download=1 for a file download).'),
      endpoint('PUT', '/api/projects/{id}/bundle', 'Create or replace a project from a bundle.', 'project bundle JSON'),
      endpoint('POST', '/api/projects/{id}/validate', 'Deep check of every file, model and reference.'),
      endpoint('POST', '/api/projects/{id}/publish', 'Build the standalone release: its shell into releases/{id}/ and its content into releases/{id}.content/, both served at /play/{id}/.'),
      endpoint('GET', '/api/projects/{id}/publish', 'The latest publish record, or null.'),
      endpoint('GET|PUT|PATCH', '/api/projects/{id}/{section}', 'Read or change one section; see "sections".', 'the section value'),
      endpoint('DELETE', '/api/projects/{id}/characters/{primary|alternate}', 'Remove a character profile (the primary needs the alternate removed first).'),
      endpoint('GET|POST', '/api/projects/{id}/level/objects', 'List objects (?kind=terrain|trigger|enemy|start) or add one object, an array, or { "objects": [...] }.'),
      endpoint('GET|PUT|PATCH|DELETE', '/api/projects/{id}/level/objects/{objectId}', 'Read, replace, merge-patch or delete one level object.'),
      endpoint('GET|PUT', '/api/projects/{id}/level/labels', 'Course labels: [{ "text", "x", "y" }].'),
      endpoint('POST', '/api/projects/{id}/art/assets?name=Stone', 'Upload a static course GLB; returns its content ID for terrain "art": { "assetId", "mirror" } or a decoration model in art.decorations.', 'GLB bytes'),
      endpoint('GET|DELETE', '/api/projects/{id}/art/assets/{assetId}', 'Download or remove course artwork (unused only).'),
      endpoint('GET|PUT|DELETE', '/api/projects/{id}/appearance/{part}/model?name=Torso.glb', 'Per-part GLB replacement for the Mesh parts character.', 'GLB bytes'),
      endpoint('GET|PATCH|DELETE', '/api/projects/{id}/appearance/{part}', 'A part\'s name and alignment.', '{ "alignment"?: {...}, "name"?: "..." }'),
      endpoint('GET|PUT|DELETE', '/api/projects/{id}/models/{role}/{model}/model?name=Hooded%20hero', 'A library GLB for the avatar, hammer or pot. A new avatar maps its joints, or takes ?settings={ boneMap, driver, hair, armForwardDistance, grips, arms }.', 'GLB bytes'),
      endpoint('GET|PATCH|DELETE', '/api/projects/{id}/models/{role}/{model}', 'A library entry: its name, and an avatar\'s bone map and settings.', '{ "name"?: "...", "boneMap"?: {...}, ... }'),
      endpoint('GET|PUT|DELETE', '/api/projects/{id}/media/{file}', 'Media library files, referenced as /media/{file}.', 'file bytes'),
      endpoint('GET', '/play/{id}/', 'The latest published release of a project; its content is under /play/{id}/content/.'),
      endpoint('GET', '/api/shared/{kind}', `The copies of one kind this server shares with every Workshop page, by name: { "copies": [{ "name", "bytes", "updatedAt" }] }. Kinds: ${SHARED_KINDS.join(', ')}.`),
      endpoint('GET|PUT|DELETE', '/api/shared/{kind}/{name}', 'Read, store or delete one shared copy. PUT validates it as the project section of its kind and replaces any copy with that name.', 'the copy: a level, character profile, game settings or arm IK profile'),
    ],
    shared: {
      description: 'Named copies every Workshop page can load and save: levels, character profiles, game settings and arm IK profiles. '
        + 'Each kind is a folder of the repository named like it, one JSON file per copy, e.g. levels/quiet-ascent.json; a Workshop build also serves its levels folder.',
      names: `1-${SHARED_NAME_LIMIT} lowercase letters, digits and inner hyphens`,
      kinds: Object.fromEntries(SHARED_KINDS.map((kind) => [kind, { maxBytes: SHARED_FORMATS[kind].maxBytes, value: SHARED_VALUES[kind] }])),
    },
    project: {
      files: PROJECT_FILES,
      layout: 'project.json (manifest), level.json, characters/primary.json and characters/alternate.json (character profiles), art/<assetId>.glb, appearance/<part>.glb, media/<file>.',
      limits: PROJECT_LIMITS,
    },
    sections: {
      title: { value: 'string, 1-80 characters', description: 'Game title: browser tab and release name.' },
      level: {
        value: `level JSON, schemaVersion ${LEVEL_SCHEMA_VERSION}: { schemaVersion, labels, objects }`,
        description: 'The course. Prefer the level/objects endpoints for small edits.',
        limits: { ...LEVEL_LIMITS, triggers: TRIGGER_LIMITS.objects, eventsPerTrigger: TRIGGER_LIMITS.events, enemies: ENEMY_LIMITS.objects },
        objects: {
          terrain: { kind: 'terrain', id: 'ledge-1', shape: { type: `one of ${SHAPE_KINDS.join(', ')}; or { "type": "polygon", "vertices": [{ "x", "y" }] }` }, x: 4, y: 2, width: 3, height: 1, angle: 0, depth: 2, color: 7438714, illusion: false },
          start: { kind: 'start', id: 'start', x: 0, y: 0.53, angle: 0.4, reach: 2.3 },
          trigger: {
            kind: 'trigger', id: 'summit', name: 'Summit', x: 0, y: 40, region: { type: 'circle', radius: 2 },
            activation: 'once | on-enter', marker: TRIGGER_MARKERS.join(' | '),
            events: [{ type: 'stop-timer' }, { type: 'message', title: 'Summit reached', message: '...' }],
          },
          enemy: { kind: 'enemy', id: 'bird-1', species: ENEMY_SPECIES.join(' | '), x: 3, y: 5, facing: 'left | right', patrolDistance: 3, speed: 1.4 },
        },
        enemyFields: ENEMY_FIELDS,
        triggerEvents: {
          message: { type: 'message', title: `<= ${TRIGGER_LIMITS.title} characters`, message: `<= ${TRIGGER_LIMITS.message} characters` },
          'play-video': { type: 'play-video', source: '/media/intro.webm or https URL' },
          'play-sound': { type: 'play-sound', source: '/media/bell.wav or https URL', volume: `${SOUND_VOLUME.min}-${SOUND_VOLUME.max}` },
          'stop-timer': { type: 'stop-timer' },
          'launch-player': { type: 'launch-player', height: `${LAUNCH_FIELDS.height.min}-${LAUNCH_FIELDS.height.max} m`, strength: `${LAUNCH_FIELDS.strength.min}-${LAUNCH_FIELDS.strength.max}` },
        },
        board: `Designers name areas by the Workshop's level board, like a chessboard: ${BOARD_CELL} m squares such as D7. Rows count up from y = 0 (row n spans y ${BOARD_CELL}(n-1) to ${BOARD_CELL}n m; row 0 lies just below 0). Columns are lettered A, B, ... Z, AA, ... rightward from column A, the ${BOARD_CELL} m band, on multiples of ${BOARD_CELL} m, that holds the leftmost terrain point.`,
        notes: 'Coordinates are metres, y up; angle is radians; terrain color is a 0xRRGGBB integer. A level has exactly one start; its reach is the hammer head\'s distance from the shoulder hinge, capped at the rig\'s reach. Message events appear as the project HUD\'s messages.style says: a toast that fades in and away while play goes on, or a popup that pauses the game until Continue.',
      },
      settings: {
        value: '{ schemaVersion: 4, physics: {...}, rig: { handleLength, maxExtension }, cursor: { maxTargetRadius, deadZone } }', patch: true,
        fields: { physics: TUNING_FIELDS, rig: RIG_FIELDS, cursor: CURSOR_FIELDS },
        notes: 'The reach is rig.handleLength + rig.maxExtension; cursor.maxTargetRadius may not exceed it, and the cursor reaches cursor.deadZone beyond it. The Downswing physics boosts multiply the strength of a motor while input lowers the target and that motor speeds the hammer head up downward. A rig change rebuilds the player and restarts the run.',
      },
      'characters/primary': {
        value: 'character profile JSON or null (the procedural Mesh parts character)',
        patch: true,
        description: `Export one from Workshop / Character. schemaVersion is ${SPRITE_SCHEMA_VERSION}; characterRiggingType is one of ${CHARACTER_RIGGING_TYPES.join(', ')}; an imported avatar's driver is { "id", "config" }, naming the trusted rig strategy that interprets its bone map; grips is { placement: ${GRIP_PLACEMENTS.join(' | ')}, left, right, slideAt, slideRange: { from, to }, rotation: { left: { x, y, z }, right: { x, y, z } } }: each hand's distance from the butt (${GRIP_LIMITS.min}-${GRIP_LIMITS.max} m), for sliding, the share of each arm's length a hand may ride from its shoulder in the course plane, either way along the handle, before the handle slides through it (${SLIDE_AT_LIMITS.min}-${SLIDE_AT_LIMITS.max}), the stretch of the handle sliding hands keep to, from and to as shares of the part a hand can hold (${GRIP_RANGE_LIMITS.min} the butt, ${GRIP_RANGE_LIMITS.max} the nearest a hand may come to the head; from no greater than to), and each 3D hand's turn on its grip in degrees (${GRIP_ROTATION_LIMITS.min} to ${GRIP_ROTATION_LIMITS.max}) about the handle (x), across it in the course plane (y) and toward the camera (z), applied in that order; waistLean is the most a 3D character's upper body leans toward the hammer, in degrees (${WAIST_LEAN_LIMITS.min}-${WAIST_LEAN_LIMITS.max}; 0 keeps it upright); arms is null for each type's own arm lengths, or { left: { upper, forearm }, right: { upper, forearm } } (${ARM_LENGTH_LIMITS.min}-${ARM_LENGTH_LIMITS.max} m). See docs/characters.md and docs/sprites.md.`,
      },
      'characters/alternate': { value: 'character profile JSON or null', patch: true, description: 'A second character players can switch to; needs a primary.' },
      'arm-ik': { value: 'body-relative elbow hints', patch: true, fields: ARM_IK_FIELDS.map((field) => ({ ...field, ...ARM_IK_LIMITS })) },
      appearance: {
        value: '[{ "part", "name", "alignment" }]',
        description: `Per-part GLB replacements. Parts: ${VISUAL_PART_IDS.join(', ')}. Upload a model first; PUT can rename, realign or remove parts.`,
        alignmentFields: ALIGNMENT_FIELDS,
      },
      models: {
        value: '{ "avatar": [{ "id", "name", "boneMap", "driver", "armForwardDistance", "grips", "arms" }], "hammer": [{ "id", "name" }], "pot": [{ "id", "name" }] }',
        description: 'The model library: extra avatar, hammer and pot models a release can swap to, one part at a time, as the game\'s backend selects. '
          + 'Upload each GLB with PUT models/{role}/{id}/model first; PUT this section to rename entries, change avatar settings or drop entries.',
        limits: MODEL_LIBRARY_LIMITS,
        notes: 'IDs use lowercase letters, digits and inner hyphens. An avatar\'s boneMap maps the eight avatar joints to GLB joints; driver is { "id", "config" } naming the trusted rig strategy that interprets them ("standard" is the default); grips, arms and armForwardDistance follow the character profile format.',
      },
      theme: { value: 'scene look', patch: true, fields: THEME_FIELDS },
      hud: { value: 'game readout and trigger-message style', patch: true, fields: HUD_FIELDS },
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
      art: {
        value: '{ mode: "shapes" | "meshes", assets: [{ id, name }], decorations: { [modelId]: assetId } }', patch: true, limits: ART_LIMITS,
        description: 'Course artwork. Upload GLBs with POST art/assets; PUT can rename or drop unused assets, change the mode, and map decoration models to assets: in mesh releases the asset replaces every decoration of that model, built-in placeholder or not.',
      },
      media: { value: '[{ "path": "/media/file.ext" }]', types: MEDIA_TYPES, limits: MEDIA_LIMITS, description: 'Upload with PUT media/{file}; PUT this list to drop unused files.' },
    },
  };
}
