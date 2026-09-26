import { AUDIO_CUE_DESCRIPTIONS, AUDIO_CUE_LABELS, AUDIO_CUES, AUDIO_VOLUME } from '../audio-settings';
import type { AudioClip, AudioCue, AudioSettings } from '../audio-settings';
import { element } from '../dom';
import { builtInEnemyArt } from '../enemy-art-data';
import type { EnemyArtSettings } from '../enemy-art-data';
import { ENEMY_SPECIES } from '../enemy-types';
import type { EnemySpecies } from '../enemy-types';
import { DEFAULT_HUD, HUD_FIELDS } from '../hud';
import { MEDIA_LIMITS, MEDIA_TYPES } from '../media';
import { projectIdForTitle } from '../project';
import { readField, writeField } from '../project-fields';
import type { FieldSpec } from '../project-fields';
import { DEFAULT_THEME, THEME_FIELDS } from '../theme';
import { createJsonDownload } from './json-download';
import type { ProjectSession, ProjectSnapshot } from './project-session';
import { createRangeControl } from './range-control';
import type { RangeControl } from './range-control';
import { sectionMarkup } from './workshop-section';
import './project-editor.css';

const SPECIES_LABELS: Readonly<Record<EnemySpecies, string>> = { bird: 'Bird', 'hollow-soldier': 'Hollow soldier' };
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
        <div class="sprite-action-row">
          <button type="button" class="button button-primary project-save" title="Save changed sections to the project server">Save project</button>
          <button type="button" class="button project-new" title="Start a new game from the built-in course and defaults">New project</button>
        </div>
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

      ${sectionMarkup({ id: 'project-theme', title: 'Theme', hint: 'Sky, fog, lights and colours' }, `
        <div class="project-fields project-theme-fields"></div>
        <button type="button" class="button project-theme-reset">Reset theme</button>
      `)}

      ${sectionMarkup({ id: 'project-hud', title: 'HUD', hint: 'The standalone game\'s readout' }, `
        <div class="project-fields project-hud-fields"></div>
        <button type="button" class="button project-hud-reset">Reset HUD</button>
      `)}

      ${sectionMarkup({ id: 'project-audio', title: 'Audio', hint: 'Music and sound cues' }, `
        <p class="appearance-format">Choose sounds from the media library. Play sound events in Level can use the same files.</p>
        <div class="project-audio-fields"></div>
      `)}

      ${sectionMarkup({ id: 'project-enemies', title: 'Enemy art', hint: 'Pixel art for enemies' }, `
        <p class="appearance-format">Two frames of equal size, rows top to bottom, facing right. "." is transparent; every
          other character is a palette key. Art is cosmetic: colliders, health and behaviour stay the same.</p>
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

      ${sectionMarkup({ id: 'project-art', title: 'Course artwork', hint: 'Terrain meshes from course packages' }, `
        <label class="appearance-label" for="project-art-mode">Release look</label>
        <select id="project-art-mode">
          <option value="shapes">Extruded shapes</option>
          <option value="meshes">Terrain meshes</option>
        </select>
        <p class="appearance-format project-art-status"></p>
        <label class="appearance-label" for="project-course-file">Import course package</label>
        <input id="project-course-file" type="file" accept=".json,application/json" />
        <p class="appearance-format">A course package from npm run pack:course replaces the level and brings its GLBs.</p>
      `)}
    </div>
  `;

  const title = element<HTMLInputElement>(root, '#project-title');
  const status = element<HTMLParagraphElement>(root, '.project-status');
  const saveButton = element<HTMLButtonElement>(root, '.project-save');
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
  const artMode = element<HTMLSelectElement>(root, '#project-art-mode');
  const artStatus = element<HTMLParagraphElement>(root, '.project-art-status');
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
  for (const species of ENEMY_SPECIES) {
    const row = document.createElement('div');
    row.className = 'project-enemy';
    const label = document.createElement('label');
    label.className = 'appearance-label';
    label.htmlFor = `project-enemy-${species}`;
    label.textContent = `${SPECIES_LABELS[species]} art (JSON)`;
    const area = document.createElement('textarea');
    area.id = `project-enemy-${species}`;
    area.rows = 6;
    area.spellcheck = false;
    area.placeholder = 'Built-in art. Choose "Edit built-in art" to start from it.';
    const actions = document.createElement('div');
    actions.className = 'sprite-action-row';
    const action = (text: string, run: () => void): void => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'button';
      button.textContent = text;
      button.setAttribute('aria-label', `${text}: ${SPECIES_LABELS[species]}`);
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
          options.onNotice(`${SPECIES_LABELS[species]} art is not valid JSON: ${error.message}`, 'error');
        }
      }
    });
    action('Edit built-in art', () => { area.value = JSON.stringify(builtInEnemyArt(species), null, 1); });
    action('Use built-in art', () => { area.value = ''; apply(null); });
    row.append(label, area, actions);
    enemyMount.append(row);
    enemyAreas.set(species, area);
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
        if (document.activeElement !== area) area.value = art === null ? '' : JSON.stringify(art, null, 1);
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
    artMode.value = snapshot.art.mode;
    artStatus.textContent = snapshot.art.assets.length === 0 ? 'No terrain GLBs; terrain renders as extruded shapes.'
      : `${snapshot.art.assets.length} terrain GLB${snapshot.art.assets.length === 1 ? '' : 's'}: ${snapshot.art.assets.map((asset) => asset.name).join(', ')}.`;
    previousContent = snapshot;
  }

  function renderStatus(snapshot: ProjectSnapshot): void {
    const dirty = snapshot.dirty;
    const where = snapshot.binding === null ? 'Local project, not on the project server'
      : `Server project "${snapshot.binding.id}", revision ${snapshot.binding.revision}`;
    status.textContent = `${where} · ${snapshot.busy !== null ? `${snapshot.busy}…` : dirty.length === 0 ? 'no unsaved changes'
      : `unsaved: ${dirty.join(', ')}`}${snapshot.conflicts.length > 0 ? ` · changed on the server: ${snapshot.conflicts.join(', ')}` : ''}`;
    status.dataset.dirty = String(dirty.length > 0);
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
    saveButton.disabled = busy || snapshot.binding === null;
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
  title.addEventListener('change', () => { if (!session.setTitle(title.value)) title.value = session.snapshot().title; }, listen);
  saveButton.addEventListener('click', () => { void session.save(); }, listen);
  element(root, '.project-new').addEventListener('click', () => {
    if (confirmReplace('A new project')) void session.newProject();
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
    if (file !== undefined) void session.addMedia(file).then((path) => { if (path !== null) options.onNotice(`Added ${path} to the media library.`, 'info'); });
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
  artMode.addEventListener('change', () => session.setArtMode(artMode.value === 'meshes' ? 'meshes' : 'shapes'), listen);
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

  options.mount.append(root);
  renderContent(session.snapshot());
  renderStatus(session.snapshot());
  return {
    dispose(): void {
      events.abort();
      unsubscribe();
      root.remove();
    },
  };
}
