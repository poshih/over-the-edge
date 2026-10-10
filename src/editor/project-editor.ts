import { AUDIO_CUE_DESCRIPTIONS, AUDIO_CUE_LABELS, AUDIO_CUES, AUDIO_VOLUME } from '../audio-settings';
import type { AudioClip, AudioCue, AudioSettings } from '../audio-settings';
import { element } from '../dom';
import { builtInEnemyArt } from '../enemy-art-data';
import type { EnemyArtSettings } from '../enemy-art-data';
import { clipTravel, SPECIES_CLIP_ROLES } from '../enemy-motion-data';
import { ENEMY_SPECIES, ENEMY_SPECS } from '../enemy-types';
import type { EnemySpecies } from '../enemy-types';
import { DEFAULT_HUD, HUD_FIELDS } from '../hud';
import { MEDIA_LIMITS, MEDIA_TYPES } from '../media';
import { projectIdForTitle } from '../project';
import { readField, writeField } from '../project-fields';
import type { FieldSpec } from '../project-fields';
import { DEFAULT_THEME, THEME_FIELDS } from '../theme';
import { createJsonDownload } from './json-download';
import { createLibraryEditor } from './library-editor';
import type { PartModelHost } from './library-preview';
import type { ProjectSession, ProjectSnapshot } from './project-session';
import { createRangeControl } from './range-control';
import type { RangeControl } from './range-control';
import type { ServerModels } from './server-models';
import { sectionMarkup } from './workshop-section';
import './project-editor.css';

const MEDIA_ACCEPT = Object.entries(MEDIA_TYPES).flatMap(([extension, type]) => [`.${extension}`, type]).join(',');

function formatSize(bytes: number): string {
  if (bytes <= 0) return 'on the server';
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MiB` : `${Math.max(1, Math.round(bytes / 1024))} KiB`;
}

interface FieldControl {
  readonly path: string;
  set: (value: unknown) => void;
}

export interface ProjectEditorOptions {
  mount: HTMLElement;
  session: ProjectSession;
  onNotice: (message: string, kind: 'info' | 'error') => void;
  // Plays a cue once, so authors can hear their choice.
  onTestCue: (cue: AudioCue) => void;
  // The game that previews library models.
  parts: PartModelHost;
  // The avatars, hammers and pots this Workshop's server shares, for the model library.
  serverModels: ServerModels;
}

/** Workshop / Project: the whole game's identity, look, HUD, audio, enemies, media and files. */
export function createProjectEditor(options: ProjectEditorOptions) {
  const { session } = options;
  const events = new AbortController();
  const listen = { signal: events.signal };
  const root = document.createElement('div');
  root.className = 'project-editor';
  const downloadJson = createJsonDownload({ mount: root, signal: events.signal });
  root.innerHTML = `
    <div class="workshop-scroll project-scroll">
      <section class="project-summary" aria-label="Project">
        <label class="appearance-label" for="project-title">Game title</label>
        <input id="project-title" type="text" maxlength="80" autocomplete="off" spellcheck="false" />
        <p class="project-status" role="status" aria-live="polite"></p>
        <div class="project-conflict" hidden>
          <p class="appearance-format project-conflict-status"></p>
          <div class="sprite-action-row">
            <button type="button" class="button project-keep-mine" title="Save this page's version over the project's">Keep my version</button>
            <button type="button" class="button project-use-project" title="Replace this page's version with the project's">Use the project's</button>
          </div>
        </div>
        <div class="project-kept" hidden>
          <p class="appearance-format project-kept-status"></p>
          <div class="sprite-action-row">
            <button type="button" class="button project-restore" title="Load these changes into the project, which then saves them">Restore into the project</button>
            <button type="button" class="button project-discard" title="Remove these changes from this browser">Discard them</button>
          </div>
        </div>
        <div class="sprite-action-row">
          <button type="button" class="button project-new" title="Start a new game from the built-in course and defaults">New project</button>
        </div>
        <button type="button" class="button project-reopen" hidden
          title="Discard this browser's copy and open the project this Workshop was published with">Reopen published project</button>
      </section>

      ${sectionMarkup({ id: 'project-server', title: 'Project server', hint: 'Open, save as and publish', open: true }, `
        <p class="appearance-format project-server-status"></p>
        <div class="project-signin" hidden>
          <label class="appearance-label" for="project-token">Server token</label>
          <input id="project-token" type="password" autocomplete="current-password" />
          <button type="button" class="button project-signin-button">Sign in</button>
        </div>
        <div class="project-server-tools">
          <label class="appearance-label" for="project-list">Server projects</label>
          <select id="project-list"></select>
          <div class="sprite-action-row">
            <button type="button" class="button project-open">Open project</button>
            <button type="button" class="button project-refresh">Refresh list</button>
          </div>
          <label class="appearance-label" for="project-id">Project ID</label>
          <input id="project-id" type="text" maxlength="64" autocomplete="off" spellcheck="false" placeholder="my-game" />
          <button type="button" class="button project-save-as">Save as project ID</button>
          <p class="appearance-format">Saving under an existing ID replaces that project. Projects live in the server's
            projects folder, one folder per game.</p>
          <button type="button" class="button project-publish">Publish standalone game</button>
          <p class="appearance-format project-publish-status"></p>
        </div>
      `)}

      ${sectionMarkup({ id: 'project-file', title: 'Project file', hint: 'The whole game in one JSON file' }, `
        <div class="sprite-action-row">
          <button type="button" class="button project-export">Export project file</button>
          <button type="button" class="button project-import">Import project file</button>
        </div>
        <input class="project-file-input" type="file" accept=".json,application/json" aria-label="Import project file" hidden />
        <p class="appearance-format">A project file holds the level, physics, characters, appearance models, theme, HUD,
          audio, enemy art, media and course artwork. Build it with GAME_PROJECT=path npm run build:game.</p>
      `)}

      ${sectionMarkup({ id: 'project-theme', title: 'Theme', hint: 'Sky, fog, camera, lights and colours' }, `
        <div class="project-fields project-theme-fields"></div>
        <button type="button" class="button project-theme-reset">Reset theme</button>
      `)}

      ${sectionMarkup({ id: 'project-hud', title: 'HUD', hint: 'Readout and trigger messages' }, `
        <div class="project-fields project-hud-fields"></div>
        <button type="button" class="button project-hud-reset">Reset HUD</button>
      `)}

      ${sectionMarkup({ id: 'project-audio', title: 'Audio', hint: 'Music and sound cues' }, `
        <p class="appearance-format">Choose sounds from the media library. Play sound events in Level can use the same files.</p>
        <div class="project-audio-fields"></div>
      `)}

      ${sectionMarkup({ id: 'project-enemies', title: 'Enemy art', hint: 'Pixel art or 3D models for enemies' }, `
        <p class="appearance-format">Pixel art: two frames of equal size, rows top to bottom, facing right. "." is
          transparent; every other character is a palette key. Pixel art is cosmetic: colliders, health and behaviour stay
          the same.</p>
        <p class="appearance-format">A 3D model is a skinned GLB, +Y up and facing +Z, with named animation clips. It joins
          the course artwork, is fitted to the enemy's height, and plays a clip for each role. A ground enemy's moves then
          travel as its clips do, so choosing a clip changes how it plays; a bird still flies where it steers.</p>
        <div class="project-enemy-fields"></div>
      `)}

      ${sectionMarkup({ id: 'project-media', title: 'Media library', hint: 'Videos and sounds shipped with the game' }, `
        <ul class="project-media-list" aria-label="Media files"></ul>
        <label class="appearance-label" for="project-media-file">Add media file</label>
        <input id="project-media-file" type="file" accept="${MEDIA_ACCEPT}" />
        <p class="appearance-format">WebM, MP4, MP3, Ogg, WAV or M4A, up to ${MEDIA_LIMITS.bytes / 1024 ** 2} MiB each and
          ${MEDIA_LIMITS.totalBytes / 1024 ** 2} MiB in total. Use a file as /media/its-name in video, sound and audio settings.</p>
      `)}

      ${sectionMarkup({ id: 'project-characters', title: 'Alternate character', hint: 'A second character players can pick' }, `
        <p class="appearance-format project-alternate-status"></p>
        <div class="sprite-action-row">
          <button type="button" class="button project-alternate-current">Use current character as alternate</button>
          <button type="button" class="button project-alternate-swap">Swap with current character</button>
        </div>
        <div class="sprite-action-row">
          <button type="button" class="button project-alternate-import">Import alternate profile JSON</button>
          <button type="button" class="button project-alternate-remove">Remove alternate</button>
        </div>
        <input class="project-alternate-file" type="file" accept=".json,application/json" aria-label="Import alternate profile JSON" hidden />
      `)}

      ${sectionMarkup({ id: 'project-models', title: 'Model library', hint: 'Avatars, hammers and pots to swap to' }, `
        <div class="project-library-mount"></div>
      `)}

      ${sectionMarkup({ id: 'project-art', title: 'Course artwork', hint: 'The meshes the course is built from' }, `
        <p class="appearance-format">The Workshop and releases draw the course alike: each terrain mesh as its GLB, and each
          decoration model the artwork maps as that GLB instead of its built-in model.</p>
        <ul class="project-media-list project-art-list" aria-label="Course meshes"></ul>
        <p class="appearance-format project-art-status"></p>
        <label class="appearance-label" for="project-course-file">Import course package</label>
        <input id="project-course-file" type="file" accept=".json,application/json" />
        <p class="appearance-format">Level / Meshes imports GLBs one at a time. A course package from npm run pack:course
          replaces the level and brings its GLBs, including those drawing decoration models.</p>
      `)}
    </div>
  `;

  const title = element<HTMLInputElement>(root, '#project-title');
  const status = element<HTMLParagraphElement>(root, '.project-status');
  const conflict = element<HTMLDivElement>(root, '.project-conflict');
  const conflictStatus = element<HTMLParagraphElement>(root, '.project-conflict-status');
  const keptChanges = element<HTMLDivElement>(root, '.project-kept');
  const keptStatus = element<HTMLParagraphElement>(root, '.project-kept-status');
  const reopenButton = element<HTMLButtonElement>(root, '.project-reopen');
  const serverStatus = element<HTMLParagraphElement>(root, '.project-server-status');
  const signin = element<HTMLDivElement>(root, '.project-signin');
  const token = element<HTMLInputElement>(root, '#project-token');
  const tools = element<HTMLDivElement>(root, '.project-server-tools');
  const list = element<HTMLSelectElement>(root, '#project-list');
  const idInput = element<HTMLInputElement>(root, '#project-id');
  const publishStatus = element<HTMLParagraphElement>(root, '.project-publish-status');
  const fileInput = element<HTMLInputElement>(root, '.project-file-input');
  const mediaList = element<HTMLUListElement>(root, '.project-media-list');
  const mediaFile = element<HTMLInputElement>(root, '#project-media-file');
  const alternateStatus = element<HTMLParagraphElement>(root, '.project-alternate-status');
  const alternateFile = element<HTMLInputElement>(root, '.project-alternate-file');
  const artStatus = element<HTMLParagraphElement>(root, '.project-art-status');
  const artList = element<HTMLUListElement>(root, '.project-art-list');
  const courseFile = element<HTMLInputElement>(root, '#project-course-file');
  const buttons = [...root.querySelectorAll<HTMLButtonElement>('button')];

  // Generic controls for theme and HUD fields -------------------------------------------------
  const renderFieldGroup = (mount: HTMLElement, prefix: string, fields: readonly FieldSpec[],
    current: () => object, commit: (value: object) => void): FieldControl[] => {
    return fields.map((field) => {
      const id = `${prefix}-${field.path.replace(/\./g, '-')}`;
      const update = (value: unknown): void => commit(writeField(current(), field.path, value));
      if (field.kind === 'number') {
        const control: RangeControl = createRangeControl({ ...field, description: field.description }, {
          id, name: id, signal: events.signal, onInput: (value) => update(field.integer ? Math.round(value) : value),
        });
        mount.append(control.row);
        return { path: field.path, set: (value) => control.setValue(value as number) };
      }
      const row = document.createElement('div');
      row.className = `project-field project-field-${field.kind}`;
      const label = document.createElement('label');
      label.htmlFor = id;
      label.textContent = field.label;
      if (field.description !== undefined) label.title = field.description;
      if (field.kind === 'choice') {
        const select = document.createElement('select');
        select.id = id;
        select.name = id;
        select.replaceChildren(...field.options.map((option) => new Option(option.label, option.value)));
        row.append(label, select);
        select.addEventListener('change', () => update(select.value), listen);
        mount.append(row);
        return { path: field.path, set: (value) => { select.value = String(value); } };
      }
      const input = document.createElement('input');
      input.id = id;
      input.name = id;
      if (field.kind === 'boolean') {
        input.type = 'checkbox';
        row.append(input, label);
        input.addEventListener('change', () => update(input.checked), listen);
        mount.append(row);
        return { path: field.path, set: (value) => { input.checked = value === true; } };
      }
      input.type = field.kind === 'color' ? 'color' : 'text';
      if (field.kind === 'text') input.maxLength = field.maxLength;
      row.append(label, input);
      input.addEventListener(field.kind === 'color' ? 'input' : 'change', () => update(input.value), listen);
      mount.append(row);
      return {
        path: field.path,
        set: (value) => { if (document.activeElement !== input || field.kind === 'color') input.value = String(value); },
      };
    });
  };
  const themeControls = renderFieldGroup(element(root, '.project-theme-fields'), 'project-theme', THEME_FIELDS,
    () => session.snapshot().theme, (value) => session.setTheme(value));
  const hudControls = renderFieldGroup(element(root, '.project-hud-fields'), 'project-hud', HUD_FIELDS,
    () => session.snapshot().hud, (value) => session.setHud(value));

  // Audio ------------------------------------------------------------------------------------
  const audioMount = element<HTMLDivElement>(root, '.project-audio-fields');
  const clipSelects: { select: HTMLSelectElement; read: (audio: AudioSettings) => AudioClip | null; key: 'music' | AudioCue }[] = [];
  const commitAudio = (mutate: (audio: AudioSettings) => AudioSettings): void => { session.setAudio(mutate(session.snapshot().audio)); };
  const master = createRangeControl({ ...AUDIO_VOLUME, label: 'Master volume' }, {
    id: 'project-audio-volume', name: 'project-audio-volume', signal: events.signal,
    onInput: (value) => commitAudio((audio) => ({ ...audio, volume: value })),
  });
  audioMount.append(master.row);
  const clipVolumes = new Map<'music' | AudioCue, RangeControl>();
  for (const key of ['music', ...AUDIO_CUES] as const) {
    const label = key === 'music' ? 'Music' : AUDIO_CUE_LABELS[key];
    const row = document.createElement('div');
    row.className = 'project-clip';
    const heading = document.createElement('label');
    heading.htmlFor = `project-audio-${key}`;
    heading.className = 'appearance-label';
    heading.textContent = label;
    heading.title = key === 'music' ? 'Loops while the game runs; pauses with it.' : AUDIO_CUE_DESCRIPTIONS[key];
    const select = document.createElement('select');
    select.id = `project-audio-${key}`;
    const read = (audio: AudioSettings): AudioClip | null => key === 'music' ? audio.music : audio.cues[key];
    const write = (audio: AudioSettings, clip: AudioClip | null): AudioSettings =>
      key === 'music' ? { ...audio, music: clip } : { ...audio, cues: { ...audio.cues, [key]: clip } };
    select.addEventListener('change', () => commitAudio((audio) =>
      write(audio, select.value === '' ? null : { source: select.value, volume: read(audio)?.volume ?? 1 })), listen);
    row.append(heading, select);
    if (key !== 'music') {
      const test = document.createElement('button');
      test.type = 'button';
      test.className = 'button project-clip-test';
      test.textContent = 'Test';
      test.setAttribute('aria-label', `Test ${label}`);
      test.addEventListener('click', () => options.onTestCue(key), listen);
      row.append(test);
    }
    const volume = createRangeControl({ ...AUDIO_VOLUME, label: `${label} volume` }, {
      id: `project-audio-${key}-volume`, name: `project-audio-${key}-volume`, signal: events.signal,
      onInput: (value) => commitAudio((audio) => {
        const clip = read(audio);
        return clip === null ? audio : write(audio, { ...clip, volume: value });
      }),
    });
    row.append(volume.row);
    audioMount.append(row);
    clipSelects.push({ select, read, key });
    clipVolumes.set(key, volume);
  }

  // Enemy art ---------------------------------------------------------------------------------
  const enemyMount = element<HTMLDivElement>(root, '.project-enemy-fields');
  const enemyAreas = new Map<EnemySpecies, HTMLTextAreaElement>();
  // Each species' 3D model: what it is, and the clip each role plays.
  const enemyModels = new Map<EnemySpecies, { readonly status: HTMLParagraphElement; readonly clips: HTMLDivElement }>();
  // Clip lists arrive later than the snapshot they were asked for; only the latest is shown.
  const enemyReads = new Map<EnemySpecies, number>();
  for (const species of ENEMY_SPECIES) {
    const row = document.createElement('div');
    row.className = 'project-enemy';
    const label = document.createElement('label');
    label.className = 'appearance-label';
    label.htmlFor = `project-enemy-${species}`;
    label.textContent = `${ENEMY_SPECS[species].label} pixel art (JSON)`;
    const area = document.createElement('textarea');
    area.id = `project-enemy-${species}`;
    area.rows = 6;
    area.spellcheck = false;
    area.placeholder = 'Built-in art. Choose "Edit built-in art" to start from it.';
    const modelFile = document.createElement('input');
    modelFile.type = 'file';
    modelFile.accept = '.glb,model/gltf-binary';
    modelFile.hidden = true;
    modelFile.setAttribute('aria-label', `3D model GLB: ${ENEMY_SPECS[species].label}`);
    modelFile.addEventListener('change', () => {
      const file = modelFile.files?.[0];
      modelFile.value = '';
      if (file !== undefined) void session.addEnemyModel(species, file);
    }, listen);
    const status = document.createElement('p');
    status.className = 'appearance-format';
    const clips = document.createElement('div');
    clips.className = 'project-enemy-clips';
    const actions = document.createElement('div');
    actions.className = 'sprite-action-row';
    const action = (text: string, run: () => void): void => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'button';
      button.textContent = text;
      button.setAttribute('aria-label', `${text}: ${ENEMY_SPECS[species].label}`);
      button.addEventListener('click', run, listen);
      actions.append(button);
    };
    const apply = (art: EnemyArtSettings[EnemySpecies]): void => {
      session.setEnemies({ ...session.snapshot().enemies, [species]: art });
    };
    action('Apply art', () => {
      if (area.value.trim() === '') apply(null);
      else {
        try {
          apply(JSON.parse(area.value));
        } catch (error) {
          if (!(error instanceof SyntaxError)) throw error;
          options.onNotice(`${ENEMY_SPECS[species].label} art is not valid JSON: ${error.message}`, 'error');
        }
      }
    });
    action('Edit built-in art', () => { area.value = JSON.stringify({ type: 'sprite', ...builtInEnemyArt(species) }, null, 1); });
    action('Use built-in art', () => { area.value = ''; apply(null); });
    action('Import 3D model', () => modelFile.click());
    row.append(label, area, actions, modelFile, status, clips);
    enemyMount.append(row);
    enemyAreas.set(species, area);
    enemyModels.set(species, { status, clips });
  }

  // Shows the species' model: its GLB, and for each role a choice of its clips with how fast the clip travels.
  function renderEnemyModel(species: EnemySpecies, snapshot: ProjectSnapshot): void {
    const view = enemyModels.get(species)!;
    const entry = snapshot.enemies[species];
    const read = (enemyReads.get(species) ?? 0) + 1;
    enemyReads.set(species, read);
    if (entry?.type !== 'model') {
      view.status.textContent = 'Pixel art. Import a skinned GLB with named animation clips to draw it as a 3D model.';
      view.clips.replaceChildren();
      return;
    }
    const name = snapshot.art.assets.find((asset) => asset.id === entry.asset)?.name ?? entry.asset;
    view.status.textContent = `3D model "${name}". Each role plays a clip, and the enemy moves as far as the clip travels. ` +
      'Use built-in art, or apply pixel art, to stop drawing it as a model; its GLB then leaves the course artwork unless another enemy uses it.';
    void session.enemyClips(entry.asset).then((bake) => {
      if (enemyReads.get(species) !== read || bake instanceof Error) return;
      view.clips.replaceChildren(...SPECIES_CLIP_ROLES[species].map((role) => {
        const field = document.createElement('label');
        field.className = 'appearance-label';
        const motion = entry.motion[role];
        const speed = motion === undefined ? 0 : Math.abs(clipTravel(motion, motion.duration, false)) * ENEMY_SPECS[species].height / motion.duration;
        field.textContent = `${role} (${speed.toFixed(2)} m/s)`;
        const select = document.createElement('select');
        select.append(...bake.clips.map((clip) => {
          const option = document.createElement('option');
          option.value = clip.name;
          option.textContent = `${clip.name} (${clip.duration.toFixed(2)} s)`;
          return option;
        }));
        select.value = entry.clips[role] ?? '';
        select.addEventListener('change', () => { void session.setEnemyClips(species, { [role]: select.value }); });
        field.append(select);
        return field;
      }));
    });
  }

  // Rendering ---------------------------------------------------------------------------------
  let previousContent: ProjectSnapshot | null = null;
  function renderContent(snapshot: ProjectSnapshot): void {
    if (document.activeElement !== title) title.value = snapshot.title;
    idInput.placeholder = snapshot.binding?.id ?? projectIdForTitle(snapshot.title);
    for (const control of themeControls) control.set(readField(snapshot.theme, control.path));
    for (const control of hudControls) control.set(readField(snapshot.hud, control.path));
    master.setValue(snapshot.audio.volume);
    const audioPaths = snapshot.media.filter((item) => item.kind === 'audio').map((item) => item.path);
    for (const { select, read, key } of clipSelects) {
      const clip = read(snapshot.audio);
      const choices = ['', ...audioPaths, ...(clip !== null && !audioPaths.includes(clip.source) ? [clip.source] : [])];
      if (select.options.length !== choices.length || [...select.options].some((option, index) => option.value !== choices[index])) {
        select.replaceChildren(...choices.map((value) => {
          const option = document.createElement('option');
          option.value = value;
          option.textContent = value === '' ? 'None' : value;
          return option;
        }));
      }
      select.value = clip?.source ?? '';
      clipVolumes.get(key)!.setValue(clip?.volume ?? 1, { disabled: clip === null });
    }
    if (previousContent === null || previousContent.enemies !== snapshot.enemies) {
      for (const [species, area] of enemyAreas) {
        const art = snapshot.enemies[species];
        if (document.activeElement !== area) area.value = art?.type === 'sprite' ? JSON.stringify(art, null, 1) : '';
        renderEnemyModel(species, snapshot);
      }
    }
    mediaList.replaceChildren(...snapshot.media.map((item) => {
      const entry = document.createElement('li');
      const name = document.createElement('span');
      name.className = 'project-media-path';
      name.textContent = item.path;
      const detail = document.createElement('span');
      detail.className = 'project-media-detail';
      detail.textContent = `${item.kind} · ${formatSize(item.bytes)}`;
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'button';
      remove.textContent = 'Remove';
      remove.setAttribute('aria-label', `Remove ${item.path}`);
      remove.addEventListener('click', () => { session.removeMedia(item.path); }, listen);
      entry.append(name, detail, remove);
      return entry;
    }));
    if (snapshot.media.length === 0) {
      const empty = document.createElement('li');
      empty.className = 'project-media-empty';
      empty.textContent = 'No media files yet.';
      mediaList.append(empty);
    }
    alternateStatus.textContent = snapshot.alternate === null
      ? 'No alternate character. The standalone game shows no character choice.'
      : `Alternate character: ${snapshot.alternate.characterRiggingType}. Players can switch in the standalone game's corner control.`;
    const models = Object.keys(snapshot.art.decorations);
    artList.replaceChildren(...snapshot.art.assets.map((asset) => {
      const entry = document.createElement('li');
      const name = document.createElement('span');
      name.className = 'project-media-path';
      name.textContent = asset.name;
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'button';
      remove.textContent = 'Remove';
      remove.setAttribute('aria-label', `Remove ${asset.name}`);
      remove.addEventListener('click', () => { session.removeCourseMesh(asset.id); }, listen);
      entry.append(name, remove);
      return entry;
    }));
    artStatus.textContent = snapshot.art.assets.length === 0
      ? 'No meshes yet: terrain draws as its collision extruded, and decorations as their built-in models.'
      : models.length === 0 ? 'Decorations draw their built-in models.'
        : `The meshes draw the decoration model${models.length === 1 ? '' : 's'} ${models.join(', ')}.`;
    previousContent = snapshot;
  }

  function renderStatus(snapshot: ProjectSnapshot): void {
    const dirty = snapshot.dirty;
    const published = snapshot.published;
    const where = snapshot.binding !== null ? `Server project "${snapshot.binding.id}", revision ${snapshot.binding.revision}`
      : published === null ? 'Local project, not on the project server'
        : published.origin === 'current' ? 'The published project'
          : published.origin === 'outdated' ? 'An older version of the published project; a newer one is published'
            : 'A local project, not the published one';
    const kept = snapshot.browserCopy?.stored === true ? ' · kept in this browser' : '';
    // A server project saves itself; the status says how far that got.
    const saving = snapshot.autosave;
    const progress = snapshot.busy !== null ? `${snapshot.busy}…`
      : saving === null ? dirty.length === 0 ? 'no unsaved changes' : `unsaved: ${dirty.join(', ')}`
        : snapshot.conflicts.length > 0 ? `also changed in the project: ${snapshot.conflicts.join(', ')}`
          : saving.problem !== null ? `not saved yet: ${saving.problem}`
            : saving.saving ? 'saving…' : dirty.length > 0 ? 'saving shortly' : 'every change saved';
    status.textContent = `${where}${kept} · ${progress}`;
    status.dataset.dirty = String(dirty.length > 0);
    conflict.hidden = snapshot.conflicts.length === 0;
    conflictStatus.textContent = `${snapshot.conflicts.join(', ')} changed in the project while you edited it here. Keep your version to ` +
      'save it over the project\'s, or use the project\'s instead of yours.';
    keptChanges.hidden = snapshot.kept === null;
    keptStatus.textContent = snapshot.kept === null ? '' : `This browser kept unsaved changes to ${snapshot.kept.join(', ')} from an ` +
      'earlier session. Restoring them replaces those sections of the project.';
    reopenButton.hidden = published === null;
    idInput.placeholder = snapshot.binding?.id ?? projectIdForTitle(snapshot.title);
    const server = snapshot.server;
    const available = server !== null && server.available;
    serverStatus.textContent = server === null ? 'Looking for the project server…'
      : !server.available ? 'No project server: this Workshop is a static site. Run npm run dev or npm run studio to save projects on a server; project files still work.'
        : !server.authenticated ? 'This project server needs its access token (STUDIO_TOKEN).'
          : `Connected to the project server · ${snapshot.projects.length} project${snapshot.projects.length === 1 ? '' : 's'}.`;
    signin.hidden = !(available && !server.authenticated);
    tools.hidden = !(available && server.authenticated);
    const choices = snapshot.projects.map((project) => project.id);
    if (list.options.length !== choices.length || [...list.options].some((option, index) => option.value !== choices[index])) {
      const selected = list.value;
      list.replaceChildren(...snapshot.projects.map((project) => {
        const option = document.createElement('option');
        option.value = project.id;
        option.textContent = project.error === null ? `${project.title} (${project.id})` : `${project.id}: unreadable`;
        return option;
      }));
      list.value = choices.includes(selected) ? selected : snapshot.binding?.id ?? choices[0] ?? '';
    }
    const busy = snapshot.busy !== null;
    for (const button of buttons) button.disabled = busy;
    element<HTMLButtonElement>(root, '.project-publish').disabled = busy || snapshot.binding === null;
    element<HTMLButtonElement>(root, '.project-open').disabled = busy || choices.length === 0;
    element<HTMLButtonElement>(root, '.project-alternate-swap').disabled = busy || snapshot.alternate === null;
    element<HTMLButtonElement>(root, '.project-alternate-remove').disabled = busy || snapshot.alternate === null;
    publishStatus.replaceChildren();
    const record = snapshot.publish;
    if (record !== null && snapshot.binding !== null && record.id === snapshot.binding.id) {
      publishStatus.append(`Last published ${new Date(record.publishedAt).toLocaleString()} (revision ${record.revision}): `);
      const link = document.createElement('a');
      link.href = record.url;
      link.target = '_blank';
      link.rel = 'noopener';
      link.textContent = `play ${record.url}`;
      publishStatus.append(link, `. Deploy ${record.directory} to any static host.`);
    } else {
      publishStatus.textContent = 'Builds the editor-free game from the saved project into the releases folder.';
    }
  }

  const unsubscribe = session.subscribe((event) => {
    const snapshot = session.snapshot();
    if (event.kind === 'content') renderContent(snapshot);
    renderStatus(snapshot);
  });

  // Actions -----------------------------------------------------------------------------------
  const confirmReplace = (action: string): boolean => session.dirtySections().length === 0 ||
    window.confirm(`${action} replaces the current game in the Workshop. Unsaved changes (${session.dirtySections().join(', ')}) will be lost. Continue?`);
  title.addEventListener('change', () => { if (session.setTitle(title.value) !== null) title.value = session.snapshot().title; }, listen);
  element(root, '.project-keep-mine').addEventListener('click', () => { void session.keepMyVersions(); }, listen);
  element(root, '.project-use-project').addEventListener('click', () => { void session.useProjectVersions(); }, listen);
  element(root, '.project-restore').addEventListener('click', () => {
    const sections = session.snapshot().kept ?? [];
    if (window.confirm(`Restore this browser's changes to ${sections.join(', ')}? They replace the project's version of those sections.`)) {
      void session.restoreKept();
    }
  }, listen);
  element(root, '.project-discard').addEventListener('click', () => {
    if (window.confirm('Discard the changes this browser kept? They cannot be recovered.')) void session.discardKept();
  }, listen);
  element(root, '.project-new').addEventListener('click', () => {
    if (confirmReplace('A new project')) void session.newProject();
  }, listen);
  reopenButton.addEventListener('click', () => {
    if (confirmReplace('Reopening the published project')) void session.reopenPublished();
  }, listen);
  element(root, '.project-signin-button').addEventListener('click', () => {
    void session.signIn(token.value).then((signedIn) => { if (signedIn) token.value = ''; });
  }, listen);
  element(root, '.project-open').addEventListener('click', () => {
    if (list.value !== '' && confirmReplace(`Opening "${list.value}"`)) void session.open(list.value);
  }, listen);
  element(root, '.project-refresh').addEventListener('click', () => { void session.refreshServer(); }, listen);
  element(root, '.project-save-as').addEventListener('click', () => {
    const id = idInput.value.trim() || idInput.placeholder;
    const exists = session.snapshot().projects.some((project) => project.id === id);
    if (exists && session.snapshot().binding?.id !== id && !window.confirm(`Replace the server project "${id}" with this game?`)) return;
    void session.saveAs(id).then((saved) => { if (saved) idInput.value = ''; });
  }, listen);
  element(root, '.project-publish').addEventListener('click', () => { void session.publish(); }, listen);
  element(root, '.project-export').addEventListener('click', () => {
    void session.exportBundle().then((result) => {
      if (result === null || events.signal.aborted) return;
      downloadJson(result.filename, JSON.stringify(result.bundle));
      options.onNotice(`Exported ${result.filename}. Build it with GAME_PROJECT=<path> npm run build:game.`, 'info');
    });
  }, listen);
  element(root, '.project-import').addEventListener('click', () => fileInput.click(), listen);
  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    fileInput.value = '';
    if (file !== undefined && confirmReplace('Importing a project file')) void session.importBundle(file);
  }, listen);
  element(root, '.project-theme-reset').addEventListener('click', () => { session.setTheme(DEFAULT_THEME); renderContent(session.snapshot()); }, listen);
  element(root, '.project-hud-reset').addEventListener('click', () => { session.setHud(DEFAULT_HUD); renderContent(session.snapshot()); }, listen);
  mediaFile.addEventListener('change', () => {
    const file = mediaFile.files?.[0];
    mediaFile.value = '';
    if (file !== undefined) void session.addMedia(file).then((path) => { if (typeof path === 'string') options.onNotice(`Added ${path} to the media library.`, 'info'); });
  }, listen);
  element(root, '.project-alternate-current').addEventListener('click', () => { session.useCurrentAsAlternate(); }, listen);
  element(root, '.project-alternate-swap').addEventListener('click', () => { void session.swapCharacters(); }, listen);
  element(root, '.project-alternate-import').addEventListener('click', () => alternateFile.click(), listen);
  alternateFile.addEventListener('change', () => {
    const file = alternateFile.files?.[0];
    alternateFile.value = '';
    if (file !== undefined) void session.importAlternate(file);
  }, listen);
  element(root, '.project-alternate-remove').addEventListener('click', () => session.removeAlternate(), listen);
  courseFile.addEventListener('change', () => {
    const file = courseFile.files?.[0];
    courseFile.value = '';
    if (file !== undefined && confirmReplace('Importing a course package')) void session.importCoursePackage(file);
  }, listen);
  window.addEventListener('beforeunload', (event) => {
    if (!session.hasUnsavedProjectChanges()) return;
    event.preventDefault();
    event.returnValue = '';
  }, listen);

  const library = createLibraryEditor({
    mount: element(root, '.project-library-mount'), session, parts: options.parts, serverModels: options.serverModels,
    onNotice: options.onNotice,
  });
  options.mount.append(root);
  renderContent(session.snapshot());
  renderStatus(session.snapshot());
  return {
    dispose(): void {
      events.abort();
      unsubscribe();
      library.dispose();
      root.remove();
    },
  };
}
