import { element } from '../dom';
import type { SpriteRig } from '../sprite-rig';
import { SPRITE_FIELDS, SPRITE_LIMITS } from '../sprite-data';
import type { SpriteLayer } from '../sprite-data';
import { createRangeControl } from './range-control';
import { createJsonDownload } from './json-download';
import type { RangeControl } from './range-control';
import { SpriteEditorState } from './sprite-state';
import type { SpriteAnchorInput, SpriteEditorSnapshot } from './sprite-state';
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
  rig: SpriteRig;
  anchors: readonly SpriteAnchorInput[];
  onNotice: (message: string, kind: 'info' | 'error') => void;
}

export interface SpriteEditorHandle {
  ready: Promise<void>;
  snapshot: () => SpriteEditorSnapshot;
  dispose: () => void;
}

export function createSpriteEditor(options: SpriteEditorOptions): SpriteEditorHandle {
  const state = new SpriteEditorState({ rig: options.rig, anchors: options.anchors, onNotice: options.onNotice });
  const events = new AbortController();
  const listen = { signal: events.signal };
  let selectedId: string | null = null;
  let newLayerAnchor = options.anchors[0].id;

  const root = document.createElement('div');
  const downloadJson = createJsonDownload({ mount: root, signal: events.signal });
  root.className = 'sprite-editor';
  root.innerHTML = `
    <div class="workshop-scroll sprite-scroll">
      <section class="sprite-intro">
        <h3>Dress up your visuals.</h3>
        <p>Add a PNG layer anchored to any current visual. Replace hides the underlying
          visual. Overlay keeps it visible; use depth to position the card in front.</p>
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
        <label class="appearance-label" for="sprite-layer-underlay">Underlay</label>
        <select id="sprite-layer-underlay">
          <option value="overlay">Overlay (keep the underlying visual)</option>
          <option value="replace">Replace (hide the anchor's default look)</option>
        </select>
      </fieldset>
      <fieldset class="tuning-group sprite-layer-transform" disabled><legend>Placement</legend></fieldset>
      <button type="button" class="button sprite-delete-layer" disabled>Delete selected layer</button>

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
      <p>Save keeps the current layout across reloads. Revert restores the last save.</p>
    </footer>
  `;

  const newAnchorSelect = element<HTMLSelectElement>(root, '#sprite-new-anchor');
  const newFileInput = element<HTMLInputElement>(root, '#sprite-new-file');
  const layerSelect = element<HTMLSelectElement>(root, '#sprite-layer');
  const statusBox = element<HTMLDivElement>(root, '.sprite-state');
  const status = element<HTMLParagraphElement>(root, '.sprite-status');
  const layerFields = element<HTMLFieldSetElement>(root, '.sprite-layer-fields');
  const nameInput = element<HTMLInputElement>(root, '#sprite-layer-name');
  const anchorSelect = element<HTMLSelectElement>(root, '#sprite-layer-anchor');
  const underlaySelect = element<HTMLSelectElement>(root, '#sprite-layer-underlay');
  const transformGroup = element<HTMLFieldSetElement>(root, '.sprite-layer-transform');
  const deleteButton = element<HTMLButtonElement>(root, '.sprite-delete-layer');
  const externalWarning = element<HTMLParagraphElement>(root, '.sprite-external-warning');
  const exportButton = element<HTMLButtonElement>(root, '.sprite-export');
  const importButton = element<HTMLButtonElement>(root, '.sprite-import');
  const fileInput = element<HTMLInputElement>(root, '.sprite-file');
  const saveButton = element<HTMLButtonElement>(root, '.sprite-save');
  const revertButton = element<HTMLButtonElement>(root, '.sprite-revert');
  const newButton = element<HTMLButtonElement>(root, '.sprite-new');

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
  underlaySelect.addEventListener('change', () => {
    if (selectedId === null) return;
    const value = underlaySelect.value;
    if (value !== 'replace' && value !== 'overlay') throw new Error(`Unknown sprite underlay: ${value}.`);
    state.updateLayer(selectedId, { underlay: value });
  }, listen);
  deleteButton.addEventListener('click', () => {
    if (selectedId !== null) state.deleteLayer(selectedId);
  }, listen);
  saveButton.addEventListener('click', () => void state.save(), listen);
  revertButton.addEventListener('click', () => void state.revert(), listen);
  newButton.addEventListener('click', () => {
    const snapshot = state.snapshot();
    const hasContent = snapshot.document.layers.length > 0 || snapshot.document.images.length > 0;
    if (hasContent && !window.confirm(
      'Start a new empty sprite layout? Unsaved changes will be discarded. Save or export first to keep them.',
    )) return;
    void state.newDocument();
  }, listen);
  importButton.addEventListener('click', () => fileInput.click(), listen);
  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    fileInput.value = '';
    if (file !== undefined) void state.importDocument(file);
  }, listen);
  exportButton.addEventListener('click', () => {
    const text = state.exportDocument();
    if (text === null || events.signal.aborted) return;
    downloadJson('sprites.json', text);
    options.onNotice('Exported sprites.json with uploaded PNGs and authored URL references.', 'info');
  }, listen);

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
        const label = `${layer.name} (${layer.anchor})`;
        if (option.textContent !== label) option.textContent = label;
      }
    }
  }

  function render(): void {
    const snapshot = state.snapshot();
    selectedId = snapshot.selectedLayerId;
    const layer = snapshot.document.layers.find((candidate) => candidate.id === selectedId) ?? null;
    const disabledAll = snapshot.restoring || snapshot.busy;
    const hasContent = snapshot.document.layers.length > 0 || snapshot.document.images.length > 0;

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

    if (layer !== null) {
      if (nameInput.value !== layer.name) nameInput.value = layer.name;
      if (anchorSelect.value !== layer.anchor) anchorSelect.value = layer.anchor;
      if (underlaySelect.value !== layer.underlay) underlaySelect.value = layer.underlay;
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
      message = 'Unsaved sprite changes. Save to keep them across reloads.';
      kind = 'draft';
    } else {
      message = snapshot.document.layers.length === 0
        ? 'No sprite layers yet. Add a PNG image above.'
        : 'Sprites saved on this device.';
      kind = 'ready';
    }
    if (status.textContent !== message) status.textContent = message;
    statusBox.dataset.kind = kind;
  }

  options.mount.append(root);
  const unsubscribe = state.subscribe(render);
  const ready = state.restore();

  return {
    ready,
    snapshot: () => state.snapshot(),
    dispose: () => {
      events.abort();
      unsubscribe();
      state.dispose();
      root.remove();
    },
  };
}
