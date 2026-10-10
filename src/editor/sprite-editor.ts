import { element, setText } from '../dom';
import { EMPTY_SPRITES, FLIPBOOK_LIMITS, SPRITE_FIELDS, SPRITE_LIMITS } from '../sprite-data';
import type { SpriteLayer } from '../sprite-data';
import type { CharacterArms } from '../character-arms';
import type { RigGeometry } from '../rig';
import type { LeanPreview } from '../waist-lean';
import type { ProjectCommandInfo } from './document/project-commands';
import { createRangeControl } from './range-control';
import { createJsonDownload } from './json-download';
import type { RangeControl } from './range-control';
import type { SpriteEditorSnapshot, SpriteEditorState } from './sprite-state';
import { selectionEntry } from './character-commands';
import { createSkeletonEditor } from './skeleton-editor';
import { createDirectionalEditor } from './directional-editor';
import type { DirectionalViewport } from './directional-editor';
import { createCharacterEditor } from './character-editor';
import type { DocumentSettingsEditing, ProfileActions } from './character-editor';
import type { AvatarMotionControls } from './avatar-motion-controls';
import { createProjectSaveButton } from './project-save';
import type { ProjectSaveTarget } from './project-save';
import type { ServerCopies } from './server-copies';
import type { ServerModels } from './server-models';
import type { WorkshopTab } from './ui-types';
import { sectionMarkup } from './workshop-section';
import './sprite-editor.css';

type SpriteFieldKey = (typeof SPRITE_FIELDS)[number]['key'];

function fieldValue(layer: SpriteLayer, key: SpriteFieldKey): number {
  switch (key) {
    case 'width': return layer.width;
    case 'height': return layer.height;
    case 'rotation': return layer.rotation;
    case 'x': return layer.offset.x;
    case 'y': return layer.offset.y;
    case 'z': return layer.offset.z;
  }
}

export interface SpriteEditorOptions {
  readonly mount: HTMLElement;
  readonly characterMount: HTMLElement;
  // The primary character, built before the editors so the project's commands can use it.
  readonly state: SpriteEditorState;
  readonly viewport: DirectionalViewport;
  readonly onNotice: (message: string, kind: 'info' | 'error') => void;
  // The game's current hammer rig; setHammerRig follows later changes.
  readonly hammerRig: RigGeometry;
  // Each arm as the current character type draws it without the profile's own arm lengths.
  readonly naturalArms: () => CharacterArms;
  // The project's game settings, whose handle length the Character tab edits.
  readonly settingsEditing: DocumentSettingsEditing;
  // The avatars, hammers and pots this Workshop's server shares, for the Character tab.
  readonly serverModels: ServerModels;
  // The open server project, for Save to project, and the character profiles shared on the server.
  readonly projectSave: ProjectSaveTarget;
  readonly serverCopies: ServerCopies;
  // The game's registered motion kinds, their Workshop controls, and the game view's sway and jolt, for the Character tab.
  readonly motion: {
    readonly kinds: readonly string[];
    readonly controls: () => AvatarMotionControls;
    readonly subscribe: (listener: () => void) => () => void;
    readonly preview: (kind: LeanPreview) => void;
  };
}

export interface SpriteEditorHandle {
  setActive: (active: boolean) => void;
  setHammerRig: (rig: RigGeometry) => void;
  updatePreview: () => void;
  leavePreview: () => void;
  dispose: () => void;
}

export function createSpriteEditor(options: SpriteEditorOptions): SpriteEditorHandle {
  const { state } = options;
  const { commands, imports } = state;
  const events = new AbortController();
  const listen = { signal: events.signal };
  let selectedId: string | null = null;
  let newLayerAnchor = state.anchors[0].id;
  let active = false;
  // The tab whose Import profile JSON opened the file picker.
  let importTab: WorkshopTab = 'sprites';
  // Cached by render() so the per-frame readout does no document work.
  let flipbookReadout: {
    layer: string; names: ReadonlyMap<string, string>; startAngle: number; spacing: number; frame: number;
  } | null = null;
  const info = (label: string, section: string | null): ProjectCommandInfo =>
    ({ label, place: { tab: 'sprites', section, select: null }, coalesce: null });
  // A step on layer `id`, which Undo selects again; Redo selects `after`.
  const layerInfo = (label: string, section: string, id: string, after: readonly string[] = [id]): ProjectCommandInfo => ({
    label, coalesce: null,
    place: {
      tab: 'sprites', section,
      select: { before: [selectionEntry('layer', id)], after: after.map((next) => selectionEntry('layer', next)) },
    },
  });
  const selection = (): readonly string[] => selectedId === null ? [] : [selectionEntry('layer', selectedId)];

  const root = document.createElement('div');
  const downloadJson = createJsonDownload({ mount: root, signal: events.signal });
  root.className = 'sprite-editor';
  root.innerHTML = `
    <div class="workshop-scroll sprite-scroll">
      <section class="sprite-mode-banner" aria-label="Sprite rendering mode">
        <p class="sprite-mode-status" role="status" aria-live="polite"></p>
        <button type="button" class="button sprite-preview-2d" hidden>Use 2D sprite character</button>
      </section>
      <p class="appearance-format sprite-external-warning" hidden>This document references external image URL(s).
        Export preserves these public references. Never use links containing credentials or private
        or internal addresses.</p>

      <section class="sprite-layers" aria-label="Sprite layers">
        <label class="appearance-label" for="sprite-layer">Layer</label>
        <select id="sprite-layer"></select>
      </section>

      ${sectionMarkup({ id: 'sprites-add', title: 'Add a layer', hint: 'A PNG on a body or tool anchor', open: true }, `
        <label class="appearance-label" for="sprite-new-anchor">New layer anchor</label>
        <select id="sprite-new-anchor"></select>
        <label class="appearance-label" for="sprite-new-file">PNG image</label>
        <input id="sprite-new-file" type="file" accept="image/png,.png" />
        <p class="appearance-format">PNG only, up to ${Math.floor(SPRITE_LIMITS.imageBytes / 1024 ** 2)} MiB.
          Fits the anchor's bounds, aspect preserved, centered at its default offset.</p>
      `)}

      ${sectionMarkup({ id: 'sprites-layer', title: 'Selected layer', hint: 'Name, anchor and placement', open: true }, `
        <fieldset class="tuning-group sprite-layer-fields" disabled>
          <legend class="visually-hidden">Layer</legend>
          <label class="appearance-label" for="sprite-layer-name">Name</label>
          <input id="sprite-layer-name" type="text" maxlength="${SPRITE_LIMITS.name}" />
          <label class="appearance-label" for="sprite-layer-anchor">Anchor</label>
          <select id="sprite-layer-anchor"></select>
        </fieldset>
        <fieldset class="tuning-group sprite-layer-transform" disabled><legend>Placement</legend></fieldset>
        <button type="button" class="button sprite-delete-layer" disabled>Delete selected layer</button>
      `)}

      ${sectionMarkup({ id: 'sprites-flipbook', title: 'Aim flipbook', hint: 'One image per aim angle' }, `
        <fieldset class="tuning-group sprite-flipbook" disabled>
          <legend class="visually-hidden">Aim flipbook</legend>
          <p class="appearance-format sprite-flipbook-summary"></p>
          <label class="appearance-label" for="sprite-flipbook-files">Frame PNGs</label>
          <input id="sprite-flipbook-files" type="file" accept="image/png,.png" multiple />
          <p class="appearance-format">Choose ${FLIPBOOK_LIMITS.minimumFrames}-${FLIPBOOK_LIMITS.maximumFrames} PNGs with
            identical pixel sizes. File names set the order (numbers sort naturally). Frame 0 faces the start angle and
            each later frame turns counterclockwise by 360 / frames degrees: right 0, up 90, left 180, down 270.</p>
          <div class="sprite-flipbook-fields">
            <div>
              <label class="appearance-label" for="sprite-flipbook-start">Start angle (deg)</label>
              <input id="sprite-flipbook-start" type="number" min="0" max="${FLIPBOOK_LIMITS.angle}" step="any" />
            </div>
            <div>
              <label class="appearance-label" for="sprite-flipbook-hysteresis">Hysteresis (deg)</label>
              <input id="sprite-flipbook-hysteresis" type="number" min="0" step="any" />
            </div>
          </div>
          <p class="appearance-format">Hysteresis keeps the shown frame this far past each sector edge; 0 turns it off.
            It must stay below half the frame spacing.</p>
          <output class="sprite-flipbook-frame" for="sprite-flipbook-start sprite-flipbook-hysteresis"></output>
          <button type="button" class="button sprite-flipbook-single">Use single image</button>
        </fieldset>
      `)}

      ${sectionMarkup({ id: 'sprites-directional', title: 'Directional Presentation', hint: 'Facing sectors and head rotation' },
        '<div class="sprite-directional-mount"></div>')}

      ${sectionMarkup({ id: 'sprites-skeleton', title: '2D skeleton', hint: 'Bones, poses, animation, IK and hair' },
        '<div class="sprite-skeleton-mount"></div>')}

      ${sectionMarkup({ id: 'sprites-file', title: 'Sprite JSON', hint: 'Import or export the whole profile' }, `
        <fieldset class="tuning-group sprite-files">
          <legend class="visually-hidden">Sprite JSON</legend>
          <div class="sprite-action-row">
            <button type="button" class="button sprite-export">Export sprites JSON</button>
            <button type="button" class="button sprite-import">Import sprites JSON</button>
          </div>
          <input class="sprite-file" type="file" accept=".json,application/json" aria-label="Import sprites JSON" hidden />
          <p class="appearance-format">Exports embed uploaded PNGs; public URLs remain references.
            Import limit: ${Math.floor(SPRITE_LIMITS.documentBytes / 1024 ** 2)} MiB.</p>
          <p class="appearance-format">Files stay in this browser, on this site. Public HTTP(S) or site-relative
            image sources from imports are kept as authored; this editor never uploads them elsewhere.</p>
        </fieldset>
      `)}

      ${sectionMarkup({ id: 'sprites-about', title: 'About sprites', hint: 'Character type and saving' }, `
        <section class="sprite-intro" aria-label="About sprites">
          <p>Add PNG cutouts or bind them to a custom 2D rig. Choose the global character type
            and load a complete 2D example in Character. Uploading a PNG never switches the type.</p>
          <p>Save keeps the whole character / sprite profile: type, artwork, rig and directional presentation.
            Revert restores the last save. New starts an empty profile with the built-in 3D character.
            Undo takes back each of them, as it takes back every edit.</p>
        </section>
      `)}
    </div>
    <footer class="workshop-footer sprite-footer">
      <div class="persistence-actions">
        <button type="button" class="button button-primary sprite-save"
          title="Save the whole character / sprite profile in this browser">Save</button>
        <button type="button" class="button sprite-revert" title="Restore the last saved profile">Revert</button>
        <button type="button" class="button sprite-new" title="Start an empty profile with the built-in 3D character">New</button>
        <button type="button" class="button sprite-retry" title="Load the character profile in the game again" hidden>Retry loading</button>
      </div>
      <div class="appearance-state sprite-state" role="status" aria-live="polite" aria-atomic="true">
        <p class="sprite-status"></p>
      </div>
    </footer>
  `;

  const newAnchorSelect = element<HTMLSelectElement>(root, '#sprite-new-anchor');
  const modeStatus = element<HTMLParagraphElement>(root, '.sprite-mode-status');
  const spriteButton = element<HTMLButtonElement>(root, '.sprite-preview-2d');
  const newFileInput = element<HTMLInputElement>(root, '#sprite-new-file');
  const layerSelect = element<HTMLSelectElement>(root, '#sprite-layer');
  const statusBox = element<HTMLDivElement>(root, '.sprite-state');
  const status = element<HTMLParagraphElement>(root, '.sprite-status');
  const retryButton = element<HTMLButtonElement>(root, '.sprite-retry');
  const layerFields = element<HTMLFieldSetElement>(root, '.sprite-layer-fields');
  const nameInput = element<HTMLInputElement>(root, '#sprite-layer-name');
  const anchorSelect = element<HTMLSelectElement>(root, '#sprite-layer-anchor');
  const transformGroup = element<HTMLFieldSetElement>(root, '.sprite-layer-transform');
  const deleteButton = element<HTMLButtonElement>(root, '.sprite-delete-layer');
  const flipbookGroup = element<HTMLFieldSetElement>(root, '.sprite-flipbook');
  const flipbookSummary = element<HTMLParagraphElement>(root, '.sprite-flipbook-summary');
  const flipbookFiles = element<HTMLInputElement>(root, '#sprite-flipbook-files');
  const flipbookStart = element<HTMLInputElement>(root, '#sprite-flipbook-start');
  const flipbookHysteresis = element<HTMLInputElement>(root, '#sprite-flipbook-hysteresis');
  const flipbookFrame = element<HTMLOutputElement>(root, '.sprite-flipbook-frame');
  const flipbookSingle = element<HTMLButtonElement>(root, '.sprite-flipbook-single');
  const externalWarning = element<HTMLParagraphElement>(root, '.sprite-external-warning');
  const exportButton = element<HTMLButtonElement>(root, '.sprite-export');
  const importButton = element<HTMLButtonElement>(root, '.sprite-import');
  const fileInput = element<HTMLInputElement>(root, '.sprite-file');
  const saveButton = element<HTMLButtonElement>(root, '.sprite-save');
  const revertButton = element<HTMLButtonElement>(root, '.sprite-revert');
  const newButton = element<HTMLButtonElement>(root, '.sprite-new');
  // Save, Revert and the profile's import and export, shared with the Character tab; each step names the tab it was made in.
  const profileActions: ProfileActions = {
    save: () => { void state.save(); },
    revert: (tab) => {
      const saved = state.snapshot().saved;
      if (saved === null) return;
      state.apply(commands.stored(saved, {
        label: 'Revert character profile', place: { tab, section: null, select: null }, coalesce: null,
      }));
    },
    importDocument: (tab) => {
      importTab = tab;
      fileInput.click();
    },
    exportDocument: () => {
      const text = state.exportDocument();
      if (events.signal.aborted) return;
      downloadJson('sprites.json', text);
      options.onNotice('Exported sprites.json with character type, rig, directional settings, PNGs, imported avatar/hammer/pot GLBs and authored URL references. Appearance GLB parts are stored separately.', 'info');
    },
  };

  for (const select of [newAnchorSelect, anchorSelect]) {
    for (const anchor of state.anchors) {
      const option = document.createElement('option');
      option.value = anchor.id;
      option.textContent = anchor.label;
      select.append(option);
    }
  }

  const controls = new Map<SpriteFieldKey, RangeControl>();
  for (const field of SPRITE_FIELDS) {
    const control = createRangeControl(field, {
      id: `sprite-${field.key}`,
      name: field.key,
      signal: events.signal,
      history: state.history,
      // The control edits whichever layer is selected; each layer's scrub is a step of its own.
      coalesceKey: () => `sprite/${encodeURIComponent(selectedId ?? '')}/${field.key}`,
      onInput: (value) => {
        if (selectedId !== null) {
          state.apply(commands.layer(selectedId, { [field.key]: value }, layerInfo(`Set ${field.label}`, 'sprites-layer', selectedId)));
        }
      },
    });
    transformGroup.append(control.row);
    controls.set(field.key, control);
  }

  spriteButton.addEventListener('click', () => {
    state.apply(commands.riggingType('sprite-2d', info('Use 2D sprite character', null)));
  }, listen);
  newAnchorSelect.addEventListener('change', () => { newLayerAnchor = newAnchorSelect.value; }, listen);
  newFileInput.addEventListener('change', () => {
    const file = newFileInput.files?.[0];
    newFileInput.value = '';
    if (file === undefined) return;
    void imports.image(file, newLayerAnchor, {
      info: {
        label: `Add layer ${file.name.replace(/\.png$/i, '')}`,
        place: { tab: 'sprites', section: 'sprites-add', select: { before: selection(), after: [] } }, coalesce: null,
      },
      signal: events.signal,
    }).then((outcome) => state.settle(outcome));
  }, listen);
  layerSelect.addEventListener('change', () => {
    state.selectLayer(layerSelect.value === '' ? null : layerSelect.value);
  }, listen);
  nameInput.addEventListener('change', () => {
    if (selectedId !== null) state.apply(commands.layer(selectedId, { name: nameInput.value }, layerInfo('Rename layer', 'sprites-layer', selectedId)));
  }, listen);
  anchorSelect.addEventListener('change', () => {
    if (selectedId !== null) {
      state.apply(commands.layer(selectedId, { anchor: anchorSelect.value }, layerInfo('Set layer anchor', 'sprites-layer', selectedId)));
    }
  }, listen);
  deleteButton.addEventListener('click', () => {
    const id = selectedId;
    if (id === null) return;
    const layers = state.definition().layers;
    const name = layers.find((layer) => layer.id === id)?.name ?? id;
    const next = layers.find((layer) => layer.id !== id)?.id;
    state.apply(commands.removeLayer(id, layerInfo(`Delete layer ${name}`, 'sprites-layer', id, next === undefined ? [] : [next])));
  }, listen);
  flipbookFiles.addEventListener('change', () => {
    const files = Array.from(flipbookFiles.files ?? []);
    flipbookFiles.value = '';
    const id = selectedId;
    if (id === null || files.length === 0) return;
    void imports.frames(id, files, { info: layerInfo('Set flipbook frames', 'sprites-flipbook', id), signal: events.signal })
      .then((outcome) => state.settle(outcome));
  }, listen);
  for (const [input, key, label] of [
    [flipbookStart, 'startAngle', 'Set flipbook start angle'], [flipbookHysteresis, 'hysteresis', 'Set flipbook hysteresis'],
  ] as const) {
    input.addEventListener('change', () => {
      const id = selectedId;
      const flipbook = state.definition().layers.find((layer) => layer.id === id)?.flipbook;
      if (id === null || flipbook === undefined) return;
      const applied = state.apply(commands.layer(id, { flipbook: { ...flipbook, [key]: input.valueAsNumber } },
        layerInfo(label, 'sprites-flipbook', id)));
      input.setAttribute('aria-invalid', String(!applied));
    }, listen);
  }
  flipbookSingle.addEventListener('click', () => {
    if (selectedId !== null) state.apply(commands.layer(selectedId, { flipbook: null }, layerInfo('Use single image', 'sprites-flipbook', selectedId)));
  }, listen);
  saveButton.addEventListener('click', profileActions.save, listen);
  revertButton.addEventListener('click', () => profileActions.revert('sprites'), listen);
  newButton.addEventListener('click', () => {
    state.apply(commands.stored(EMPTY_SPRITES, info('New character profile', null)));
  }, listen);
  importButton.addEventListener('click', () => profileActions.importDocument('sprites'), listen);
  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    fileInput.value = '';
    if (file === undefined) return;
    void imports.profile(file, {
      info: {
        label: `Import profile ${file.name.replace(/\.json$/i, '')}`,
        place: { tab: importTab, section: importTab === 'sprites' ? 'sprites-file' : 'character-file', select: null }, coalesce: null,
      },
      signal: events.signal,
    }).then((outcome) => state.settleProfile(outcome));
  }, listen);
  exportButton.addEventListener('click', profileActions.exportDocument, listen);
  retryButton.addEventListener('click', () => state.retry(), listen);

  function syncLayerOptions(layers: SpriteEditorSnapshot['document']['layers']): void {
    const wanted = layers.length === 0 ? [''] : layers.map((layer) => layer.id);
    const current = Array.from(layerSelect.options, (option) => option.value);
    if (current.length !== wanted.length || current.some((value, index) => value !== wanted[index])) {
      layerSelect.innerHTML = '';
      if (layers.length === 0) {
        const option = document.createElement('option');
        option.value = '';
        option.textContent = 'No layers yet';
        layerSelect.append(option);
      } else {
        for (const layer of layers) {
          const option = document.createElement('option');
          option.value = layer.id;
          layerSelect.append(option);
        }
      }
    }
    if (layers.length > 0) {
      for (const [index, layer] of layers.entries()) {
        const option = layerSelect.options[index];
        const label = layer.flipbook === undefined ? `${layer.name} (${layer.anchor})` :
          `${layer.name} (${layer.anchor}, ${layer.flipbook.images.length}-frame flipbook)`;
        if (option.textContent !== label) option.textContent = label;
      }
    }
  }

  function degreesText(value: number): string {
    return `${Math.round(value * 1000) / 1000} deg`;
  }

  function setNumberValue(input: HTMLInputElement, value: number | null): void {
    // Keep an in-progress entry; the profile's value returns after focus leaves.
    if (document.activeElement === input) return;
    const text = value === null ? '' : String(value);
    if (input.value !== text) input.value = text;
    input.removeAttribute('aria-invalid');
  }

  function renderFlipbook(layer: SpriteLayer | null, snapshot: SpriteEditorSnapshot): void {
    const flipbook = layer?.flipbook;
    const incompatible = layer !== null && (layer.skin !== null || layer.tileLength !== null);
    flipbookGroup.disabled = layer === null;
    flipbookFiles.disabled = layer === null || incompatible;
    flipbookStart.disabled = flipbook === undefined;
    flipbookHysteresis.disabled = flipbook === undefined;
    flipbookSingle.disabled = flipbook === undefined;
    setNumberValue(flipbookStart, flipbook?.startAngle ?? null);
    setNumberValue(flipbookHysteresis, flipbook?.hysteresis ?? null);
    const names = new Map(snapshot.document.images.map((image) => [image.id, image.name]));
    const spacing = flipbook === undefined ? 0 : FLIPBOOK_LIMITS.angle / flipbook.images.length;
    setText(flipbookSummary, layer === null ? 'Select a layer to give it aim frames.' :
      incompatible ? 'Weighted meshes and tiled shafts keep a single image. Use a rigid binding to add aim frames.' :
      flipbook === undefined ? 'Single image. Choose frame PNGs to show one frame per aim angle instead.' :
      `${flipbook.images.length} frames, one every ${degreesText(spacing)}; frame 0 is "${names.get(flipbook.images[0]) ?? flipbook.images[0]}". ` +
      'Visible in every direction. Head tilt still applies to its head bone or unbound head artwork.');
    const spriteMode = snapshot.document.characterRiggingType === 'sprite-2d';
    // The readout reads the rig, so only once it shows this profile.
    const shown = snapshot.rendering.kind === 'ready';
    flipbookReadout = layer === null || flipbook === undefined || !spriteMode || !shown ? null :
      { layer: layer.id, names, startAngle: flipbook.startAngle, spacing, frame: -1 };
    if (flipbook === undefined) setText(flipbookFrame, '');
    else if (!spriteMode) setText(flipbookFrame, 'Frames preview in 2D sprite mode.');
    else if (!shown) setText(flipbookFrame, 'Frames preview once the character shows.');
    updateFlipbookFrame();
  }

  function updateFlipbookFrame(): void {
    const readout = flipbookReadout;
    if (!active || readout === null) return;
    const current = state.flipbookState(readout.layer);
    if (current === null || current.frame === readout.frame) return;
    readout.frame = current.frame;
    const angle = (readout.startAngle + current.frame * readout.spacing) % FLIPBOOK_LIMITS.angle;
    setText(flipbookFrame, `Showing frame ${current.frame} (frames 0-${current.frameCount - 1}): ` +
      `"${readout.names.get(current.image) ?? current.image}", drawn for ${degreesText(angle)} aim. ` +
      'Drag the Directional Presentation preview aim to scrub frames.');
  }

  function render(): void {
    const snapshot = state.snapshot();
    selectedId = snapshot.selectedLayerId;
    const layer = snapshot.document.layers.find((candidate) => candidate.id === selectedId) ?? null;
    const hasContent = snapshot.hasContent;
    const type = snapshot.document.characterRiggingType;
    spriteButton.hidden = type === 'sprite-2d';
    spriteButton.disabled = snapshot.document.layers.length === 0;
    const modeMessage = type === 'sprite-2d' ?
      'Pure 2D mode: only the sprites in this profile are rendered. All 3D visuals are hidden. Hammer artwork stays on top; depth orders artwork within each render pass.' :
      'Sprite rendering and preview are inactive in Mesh parts and Avatar modes. Artwork stays editable. ' +
      (snapshot.document.layers.length === 0 ? 'Load the complete 2D example in Character to get started.' :
        'Use 2D sprite character to preview this artwork; Save to keep the type or Revert to your last save.');
    if (modeStatus.textContent !== modeMessage) modeStatus.textContent = modeMessage;

    exportButton.disabled = !hasContent;
    saveButton.disabled = snapshot.saving || !snapshot.dirty;
    revertButton.disabled = !snapshot.dirty || snapshot.saved === null;
    newButton.disabled = !hasContent;

    syncLayerOptions(snapshot.document.layers);
    if (layerSelect.value !== (selectedId ?? '')) layerSelect.value = selectedId ?? '';
    layerSelect.disabled = snapshot.document.layers.length === 0;

    const hasLayer = layer !== null;
    layerFields.disabled = !hasLayer;
    transformGroup.disabled = !hasLayer;
    deleteButton.disabled = !hasLayer;
    renderFlipbook(layer, snapshot);

    if (layer !== null) {
      if (nameInput.value !== layer.name) nameInput.value = layer.name;
      if (anchorSelect.value !== layer.anchor) anchorSelect.value = layer.anchor;
      for (const field of SPRITE_FIELDS) {
        const control = controls.get(field.key);
        if (control === undefined) throw new Error(`Missing sprite range control: ${field.key}`);
        control.setValue(fieldValue(layer, field.key));
      }
    } else {
      nameInput.value = '';
      for (const field of SPRITE_FIELDS) controls.get(field.key)?.setValue(0, { disabled: true });
    }

    externalWarning.hidden = !snapshot.externalSources;

    const rendering = snapshot.rendering;
    retryButton.hidden = rendering.kind !== 'failed';
    let message: string;
    let kind: string;
    if (snapshot.error !== null) {
      message = snapshot.error;
      kind = 'error';
    } else if (rendering.kind === 'failed') {
      message = `The character could not be shown: ${rendering.error.message} The game shows the previous one meanwhile.`;
      kind = 'error';
    } else if (rendering.kind === 'loading') {
      message = 'Loading the character... The game shows the previous one until it is ready.';
      kind = 'busy';
    } else if (snapshot.saving) {
      message = 'Saving the character / sprite profile...';
      kind = 'busy';
    } else if (snapshot.dirty) {
      message = 'Unsaved character / sprite profile changes. Save to keep them across reloads.';
      kind = 'draft';
    } else {
      message = !snapshot.hasContent
        ? 'No sprite layers yet. Add a PNG layer, or load the complete example in Character.'
        : 'Character / sprite profile saved on this device.';
      kind = 'ready';
    }
    if (status.textContent !== message) status.textContent = message;
    statusBox.dataset.kind = kind;
  }

  options.mount.append(root);
  element(root, '.sprite-footer .persistence-actions').append(createProjectSaveButton({
    target: options.projectSave, sections: ['characters/primary'], label: 'the character profile', signal: events.signal,
  }));
  const characterEditor = createCharacterEditor({
    mount: options.characterMount, state, hammerRig: options.hammerRig,
    naturalArms: options.naturalArms, settingsEditing: options.settingsEditing, actions: profileActions,
    serverModels: options.serverModels, onNotice: options.onNotice, signal: events.signal,
    projectSave: options.projectSave, serverCopies: options.serverCopies, motion: options.motion,
  });
  const skeletonEditor = createSkeletonEditor({
    mount: element<HTMLDivElement>(root, '.sprite-skeleton-mount'),
    state, anchors: state.anchors, targetIds: state.targetIds, signal: events.signal,
  });
  const directionalEditor = createDirectionalEditor({
    mount: element<HTMLDivElement>(root, '.sprite-directional-mount'),
    state, viewport: options.viewport, presentationState: () => state.presentationState(),
    signal: events.signal,
  });
  const unsubscribe = state.subscribe(render);

  return {
    setActive: (value) => {
      active = value;
      directionalEditor.setActive(value);
      updateFlipbookFrame();
    },
    setHammerRig: (rig) => characterEditor.setHammerRig(rig),
    updatePreview: () => {
      directionalEditor.updatePreview();
      updateFlipbookFrame();
    },
    leavePreview: directionalEditor.leavePreview,
    dispose: () => {
      events.abort();
      unsubscribe();
      characterEditor.dispose();
      skeletonEditor.dispose();
      directionalEditor.dispose();
      root.remove();
    },
  };
}
