import { element, setText } from '../dom';
import type { SpriteRig } from '../sprite-rig';
import { FLIPBOOK_LIMITS, SPRITE_FIELDS, SPRITE_LIMITS } from '../sprite-data';
import type { SpriteLayer } from '../sprite-data';
import { createRangeControl } from './range-control';
import { createJsonDownload } from './json-download';
import type { RangeControl } from './range-control';
import { SpriteEditorState } from './sprite-state';
import type { SpriteAnchorInput, SpriteEditorSnapshot } from './sprite-state';
import { createSkeletonEditor } from './skeleton-editor';
import { createDirectionalEditor } from './directional-editor';
import type { DirectionalViewport } from './directional-editor';
import { createCharacterEditor } from './character-editor';
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
  mount: HTMLElement;
  characterMount: HTMLElement;
  rig: SpriteRig;
  anchors: readonly SpriteAnchorInput[];
  targetIds: readonly string[];
  viewport: DirectionalViewport;
  onNotice: (message: string, kind: 'info' | 'error') => void;
}

export interface SpriteEditorHandle {
  ready: Promise<void>;
  snapshot: () => SpriteEditorSnapshot;
  setActive: (active: boolean) => void;
  updatePreview: () => void;
  leavePreview: () => void;
  dispose: () => void;
}

export function createSpriteEditor(options: SpriteEditorOptions): SpriteEditorHandle {
  const state = new SpriteEditorState({
    rig: options.rig, anchors: options.anchors, targetIds: options.targetIds, onNotice: options.onNotice,
  });
  const events = new AbortController();
  const listen = { signal: events.signal };
  let selectedId: string | null = null;
  let newLayerAnchor = options.anchors[0].id;
  let active = false;
  // Cached by render() so the per-frame readout does no document work.
  let flipbookReadout: {
    layer: string; names: ReadonlyMap<string, string>; startAngle: number; spacing: number; frame: number;
  } | null = null;

  const root = document.createElement('div');
  const downloadJson = createJsonDownload({ mount: root, signal: events.signal });
  root.className = 'sprite-editor';
  root.innerHTML = `
    <div class="workshop-scroll sprite-scroll">
      <section class="sprite-intro">
        <h3>Author your sprite artwork.</h3>
        <p>Add PNG cutouts or bind them to a custom 2D rig. Choose the global character type
          and load a complete 2D example in Character. Uploading a PNG never switches the type.</p>
      </section>
      <section class="sprite-mode-banner" aria-label="Sprite rendering mode">
        <p class="sprite-mode-status" role="status" aria-live="polite"></p>
        <button type="button" class="button sprite-preview-2d" hidden>Use 2D sprite character</button>
      </section>
      <label class="appearance-label" for="sprite-new-anchor">New layer anchor</label>
      <select id="sprite-new-anchor"></select>
      <label class="appearance-label" for="sprite-new-file">PNG image</label>
      <input id="sprite-new-file" type="file" accept="image/png,.png" />
      <p class="appearance-format">PNG only, up to ${Math.floor(SPRITE_LIMITS.imageBytes / 1024 ** 2)} MiB.
        Fits the anchor's bounds, aspect preserved, centered at its default offset.</p>

      <label class="appearance-label" for="sprite-layer">Layer</label>
      <select id="sprite-layer"></select>

      <div class="appearance-state sprite-state" role="status" aria-live="polite" aria-atomic="true">
        <p class="sprite-status"></p>
      </div>

      <fieldset class="tuning-group sprite-layer-fields" disabled>
        <legend>Layer</legend>
        <label class="appearance-label" for="sprite-layer-name">Name</label>
        <input id="sprite-layer-name" type="text" maxlength="${SPRITE_LIMITS.name}" />
        <label class="appearance-label" for="sprite-layer-anchor">Anchor</label>
        <select id="sprite-layer-anchor"></select>
      </fieldset>
      <fieldset class="tuning-group sprite-layer-transform" disabled><legend>Placement</legend></fieldset>
      <fieldset class="tuning-group sprite-flipbook" disabled>
        <legend>Aim flipbook</legend>
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
      <button type="button" class="button sprite-delete-layer" disabled>Delete selected layer</button>
      <div class="sprite-directional-mount"></div>
      <div class="sprite-skeleton-mount"></div>

      <p class="appearance-format sprite-external-warning" hidden>This document references external image URL(s).
        Export preserves these public references. Never use links containing credentials or private
        or internal addresses.</p>

      <fieldset class="tuning-group sprite-files">
        <legend>Sprite JSON</legend>
        <div class="sprite-action-row">
          <button type="button" class="button sprite-export">Export sprites JSON</button>
          <button type="button" class="button sprite-import">Import sprites JSON</button>
        </div>
        <input class="sprite-file" type="file" accept=".json,application/json" aria-label="Import sprites JSON" hidden />
        <p class="appearance-format">Exports embed uploaded PNGs; public URLs remain references.
          Import limit: ${Math.floor(SPRITE_LIMITS.documentBytes / 1024 ** 2)} MiB.</p>
      </fieldset>
      <p class="appearance-format">Files stay in this browser, on this site. Public HTTP(S) or site-relative
        image sources from imports are kept as authored; this editor never uploads them elsewhere.</p>
    </div>
    <footer class="workshop-footer sprite-footer">
      <div class="persistence-actions">
        <button type="button" class="button button-primary sprite-save">Save</button>
        <button type="button" class="button sprite-revert">Revert</button>
        <button type="button" class="button sprite-new">New</button>
      </div>
      <p>Save keeps the whole character / sprite profile: type, artwork, rig and directional presentation.
        Revert restores the last save.</p>
    </footer>
  `;

  const newAnchorSelect = element<HTMLSelectElement>(root, '#sprite-new-anchor');
  const modeStatus = element<HTMLParagraphElement>(root, '.sprite-mode-status');
  const spriteButton = element<HTMLButtonElement>(root, '.sprite-preview-2d');
  const newFileInput = element<HTMLInputElement>(root, '#sprite-new-file');
  const layerSelect = element<HTMLSelectElement>(root, '#sprite-layer');
  const statusBox = element<HTMLDivElement>(root, '.sprite-state');
  const status = element<HTMLParagraphElement>(root, '.sprite-status');
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
  const documentActions = {
    save: () => { void state.save(); },
    revert: () => { void state.revert(); },
    importDocument: () => fileInput.click(),
    exportDocument: () => {
      const text = state.exportDocument();
      if (text === null || events.signal.aborted) return;
      downloadJson('sprites.json', text);
      options.onNotice('Exported sprites.json with character type, rig, directional settings, PNGs and authored URL references. GLB parts are stored separately.', 'info');
    },
  };

  for (const select of [newAnchorSelect, anchorSelect]) {
    for (const anchor of options.anchors) {
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
      onInput: (value) => {
        if (selectedId === null) return;
        state.updateLayer(selectedId, { [field.key]: value });
      },
    });
    transformGroup.append(control.row);
    controls.set(field.key, control);
  }

  spriteButton.addEventListener('click', () => { state.setCharacterRiggingType('sprite-2d'); }, listen);
  newAnchorSelect.addEventListener('change', () => { newLayerAnchor = newAnchorSelect.value; }, listen);
  newFileInput.addEventListener('change', () => {
    const file = newFileInput.files?.[0];
    newFileInput.value = '';
    if (file !== undefined) void state.addImageLayer(file, newLayerAnchor);
  }, listen);
  layerSelect.addEventListener('change', () => {
    state.selectLayer(layerSelect.value === '' ? null : layerSelect.value);
  }, listen);
  nameInput.addEventListener('change', () => {
    if (selectedId !== null) state.updateLayer(selectedId, { name: nameInput.value });
  }, listen);
  anchorSelect.addEventListener('change', () => {
    if (selectedId !== null) state.updateLayer(selectedId, { anchor: anchorSelect.value });
  }, listen);
  deleteButton.addEventListener('click', () => {
    if (selectedId !== null) state.deleteLayer(selectedId);
  }, listen);
  flipbookFiles.addEventListener('change', () => {
    const files = Array.from(flipbookFiles.files ?? []);
    flipbookFiles.value = '';
    if (selectedId !== null && files.length > 0) void state.setLayerFlipbookFrames(selectedId, files);
  }, listen);
  for (const [input, key] of [[flipbookStart, 'startAngle'], [flipbookHysteresis, 'hysteresis']] as const) {
    input.addEventListener('change', () => {
      const flipbook = state.snapshot().document.layers.find((layer) => layer.id === selectedId)?.flipbook;
      if (selectedId === null || flipbook === undefined) return;
      state.updateLayer(selectedId, { flipbook: { ...flipbook, [key]: input.valueAsNumber } });
      input.setAttribute('aria-invalid', String(state.snapshot().error !== null));
    }, listen);
  }
  flipbookSingle.addEventListener('click', () => {
    if (selectedId !== null) state.updateLayer(selectedId, { flipbook: null });
  }, listen);
  saveButton.addEventListener('click', documentActions.save, listen);
  revertButton.addEventListener('click', documentActions.revert, listen);
  newButton.addEventListener('click', () => {
    const snapshot = state.snapshot();
    if (snapshot.hasContent && !window.confirm(
      'Start a new built-in 3D character with an empty sprite profile? Unsaved changes will be discarded. Save or export first to keep them.',
    )) return;
    void state.newDocument();
  }, listen);
  importButton.addEventListener('click', documentActions.importDocument, listen);
  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    fileInput.value = '';
    if (file !== undefined) void state.importDocument(file);
  }, listen);
  exportButton.addEventListener('click', documentActions.exportDocument, listen);

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
    // Keep an in-progress entry; the last valid draft value returns after focus leaves.
    if (document.activeElement === input) return;
    const text = value === null ? '' : String(value);
    if (input.value !== text) input.value = text;
    input.removeAttribute('aria-invalid');
  }

  function renderFlipbook(layer: SpriteLayer | null, snapshot: SpriteEditorSnapshot, disabledAll: boolean): void {
    const flipbook = layer?.flipbook;
    const incompatible = layer !== null && (layer.skin !== null || layer.tileLength !== null);
    flipbookGroup.disabled = disabledAll || layer === null;
    flipbookFiles.disabled = disabledAll || layer === null || incompatible;
    flipbookStart.disabled = disabledAll || flipbook === undefined;
    flipbookHysteresis.disabled = disabledAll || flipbook === undefined;
    flipbookSingle.disabled = disabledAll || flipbook === undefined;
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
    flipbookReadout = layer === null || flipbook === undefined || !spriteMode ? null :
      { layer: layer.id, names, startAngle: flipbook.startAngle, spacing, frame: -1 };
    if (flipbook === undefined) setText(flipbookFrame, '');
    else if (!spriteMode) setText(flipbookFrame, 'Frames preview in 2D sprite mode.');
    updateFlipbookFrame();
  }

  function updateFlipbookFrame(): void {
    const readout = flipbookReadout;
    if (!active || readout === null) return;
    const current = options.rig.flipbookState(readout.layer);
    if (current === null || current.frame === readout.frame) return;
    readout.frame = current.frame;
    const angle = (readout.startAngle + current.frame * readout.spacing) % FLIPBOOK_LIMITS.angle;
    setText(flipbookFrame, `Showing frame ${current.frame} (frames 0-${current.frameCount - 1}): ` +
      `"${readout.names.get(current.image) ?? current.image}", drawn for ${degreesText(angle)} aim. ` +
      'Drag the Directional Presentation preview aim below to scrub frames.');
  }

  function render(): void {
    const snapshot = state.snapshot();
    selectedId = snapshot.selectedLayerId;
    const layer = snapshot.document.layers.find((candidate) => candidate.id === selectedId) ?? null;
    const disabledAll = snapshot.restoring || snapshot.busy;
    const hasContent = snapshot.hasContent;
    const type = snapshot.document.characterRiggingType;
    spriteButton.hidden = type === 'sprite-2d';
    spriteButton.disabled = disabledAll || snapshot.document.layers.length === 0;
    const modeMessage = type === 'sprite-2d' ?
      'Pure 2D mode: only the sprites in this profile are rendered. All 3D visuals are hidden. Hammer artwork stays on top; depth orders artwork within each render pass.' :
      'Sprite rendering and preview are inactive in Mesh parts and Avatar modes. Artwork stays editable. ' +
      (snapshot.document.layers.length === 0 ? 'Load the complete 2D example in Character to get started.' :
        'Use 2D sprite character to preview this artwork; Save to keep the type or Revert to your last save.');
    if (modeStatus.textContent !== modeMessage) modeStatus.textContent = modeMessage;

    newAnchorSelect.disabled = disabledAll;
    newFileInput.disabled = disabledAll;
    importButton.disabled = disabledAll;
    exportButton.disabled = disabledAll || !hasContent;
    saveButton.disabled = disabledAll || !snapshot.dirty;
    revertButton.disabled = disabledAll || !snapshot.dirty || snapshot.saved === null;
    newButton.disabled = disabledAll || !hasContent;

    syncLayerOptions(snapshot.document.layers);
    if (layerSelect.value !== (selectedId ?? '')) layerSelect.value = selectedId ?? '';
    layerSelect.disabled = disabledAll || snapshot.document.layers.length === 0;

    const hasLayer = layer !== null;
    layerFields.disabled = disabledAll || !hasLayer;
    transformGroup.disabled = disabledAll || !hasLayer;
    deleteButton.disabled = disabledAll || !hasLayer;
    renderFlipbook(layer, snapshot, disabledAll);

    if (layer !== null) {
      if (nameInput.value !== layer.name) nameInput.value = layer.name;
      if (anchorSelect.value !== layer.anchor) anchorSelect.value = layer.anchor;
      for (const field of SPRITE_FIELDS) {
        const control = controls.get(field.key);
        if (control === undefined) throw new Error(`Missing sprite range control: ${field.key}`);
        control.setValue(fieldValue(layer, field.key), { disabled: disabledAll });
      }
    } else {
      nameInput.value = '';
      for (const field of SPRITE_FIELDS) controls.get(field.key)?.setValue(0, { disabled: true });
    }

    externalWarning.hidden = !snapshot.externalSources;

    let message: string;
    let kind: string;
    if (snapshot.restoring) {
      message = 'Restoring saved sprites...';
      kind = 'busy';
    } else if (snapshot.busy) {
      message = 'Working on sprites...';
      kind = 'busy';
    } else if (snapshot.error !== null) {
      message = snapshot.error;
      kind = 'error';
    } else if (snapshot.dirty) {
      message = 'Unsaved character / sprite profile changes. Save to keep them across reloads.';
      kind = 'draft';
    } else {
      message = !snapshot.hasContent
        ? 'No sprite layers yet. Add a PNG above, or load the complete example in Character.'
        : 'Character / sprite profile saved on this device.';
      kind = 'ready';
    }
    if (status.textContent !== message) status.textContent = message;
    statusBox.dataset.kind = kind;
  }

  options.mount.append(root);
  const characterEditor = createCharacterEditor({
    mount: options.characterMount, state, actions: documentActions,
    onNotice: options.onNotice, signal: events.signal,
  });
  const skeletonEditor = createSkeletonEditor({
    mount: element<HTMLDivElement>(root, '.sprite-skeleton-mount'),
    state, anchors: options.anchors, targetIds: options.targetIds, signal: events.signal,
  });
  const directionalEditor = createDirectionalEditor({
    mount: element<HTMLDivElement>(root, '.sprite-directional-mount'),
    state, viewport: options.viewport, presentationState: () => options.rig.presentationState(),
    actions: documentActions, signal: events.signal,
  });
  const unsubscribe = state.subscribe(render);
  const ready = state.restore();

  return {
    ready,
    snapshot: () => state.snapshot(),
    setActive: (value) => {
      active = value;
      directionalEditor.setActive(value);
      updateFlipbookFrame();
    },
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
      state.dispose();
      root.remove();
    },
  };
}
