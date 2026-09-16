import { Appearance } from './appearance';
import {
  ALIGNMENT_FIELDS, AppearanceError, ARM_IK_FIELDS, ARM_IK_LIMITS, isVisualPart, MODEL_LIMITS, VISUAL_PARTS,
} from './appearance-types';
import type { ArmIkSettings, VisualAlignment, VisualPartId } from './appearance-types';
import { armIkProfiles } from './arm-ik-store';
import { createRangeControl } from './range-control';
import type { RangeControl } from './range-control';
import { createSnapshotPicker } from './snapshot-picker';

interface AppearanceUiOptions {
  mount: HTMLElement;
  appearance: Appearance;
  onDebug: () => void;
  onNotice: (message: string, kind: 'info' | 'error') => void;
}

export function createAppearanceUI(options: AppearanceUiOptions): { dispose: () => void } {
  const events = new AbortController();
  const listen = { signal: events.signal };
  let selected: VisualPartId = 'pot';
  const root = document.createElement('div');
  root.className = 'appearance-editor';
  root.innerHTML = `
    <div class="workshop-scroll appearance-scroll">
      <section class="appearance-intro">
        <h3>Your own character.</h3>
        <p>Import a GLB for any visible part. The existing physics and arm IK keep driving it.</p>
        <p><strong>Cosmetic only:</strong> models do not change collision shapes, mass or grip.</p>
      </section>
      <div class="arm-ik-profiles"></div>
      <p class="appearance-format">The last saved or loaded IK profile restores on reload.
        Reset changes only the preview. Physics presets and model alignment are separate.</p>
      <p class="appearance-format arm-ik-migration" role="status" hidden>
        Arm IK now uses body-relative hints. Your previous swivel-angle save is untouched;
        its angles cannot be converted exactly. Tune the new hints and save a named profile.
      </p>
      <fieldset class="tuning-group arm-ik-controls"><legend>Body-relative elbow hints</legend></fieldset>
      <p class="appearance-format">Hints are preferred elbow positions relative to the torso:
        X left/right, Y down/up, Z away/toward the camera, in metres.
        Hands stay on the shaft. The collision overlay also shows hint crosses and arm chains.</p>
      <div class="arm-ik-actions">
        <button type="button" class="button reset-arm-ik">Reset arm IK</button>
      </div>
      <div class="appearance-state arm-ik-state" role="status" aria-live="polite" aria-atomic="true">
        <p class="arm-ik-status"></p>
      </div>
      <label class="appearance-label" for="visual-part">Body part</label>
      <select id="visual-part"></select>
      <p class="appearance-hint"></p>
      <label class="appearance-label" for="visual-file">GLB model</label>
      <input id="visual-file" type="file" accept=".glb,model/gltf-binary" />
      <p class="appearance-format">Self-contained GLB 2.0, up to ${MODEL_LIMITS.bytes / 1024 ** 2} MiB.
        Embed textures; export without Draco, Meshopt or KTX2 compression.</p>
      <div class="appearance-state model-state" role="status" aria-live="polite" aria-atomic="true">
        <p class="appearance-source"></p>
        <p class="appearance-status"></p>
      </div>
      <div class="appearance-fit-heading">
        <h3>Align the visual</h3>
        <p>Auto-fit preserves proportions. Rotation is applied before fitting.
          Adjustments preview live; save alignment to keep them.</p>
      </div>
      <fieldset class="tuning-group visual-alignment"><legend>Model alignment</legend></fieldset>
      <button type="button" class="button appearance-debug">Toggle collision overlay</button>
      <p class="appearance-format">Files stay in this browser, on this site. No upload to a server.
        Saved visuals restore automatically. Imported animations, cameras and lights are not used.</p>
    </div>
    <footer class="workshop-footer appearance-footer">
      <div class="persistence-actions">
        <button type="button" class="button button-primary save-alignment">Save alignment</button>
        <button type="button" class="button reset-alignment">Reset fit</button>
        <button type="button" class="button default-visual">Use default</button>
      </div>
      <p>Model imports save automatically. Alignment saves separately.</p>
    </footer>
  `;
  const get = <T extends HTMLElement>(selector: string): T => {
    const element = root.querySelector<T>(selector);
    if (!element) throw new Error(`Missing appearance editor element: ${selector}`);
    return element;
  };
  const partPicker = get<HTMLSelectElement>('#visual-part');
  const filePicker = get<HTMLInputElement>('#visual-file');
  const hint = get<HTMLParagraphElement>('.appearance-hint');
  const source = get<HTMLParagraphElement>('.appearance-source');
  const status = get<HTMLParagraphElement>('.appearance-status');
  const statusBox = get<HTMLDivElement>('.model-state');
  const alignmentGroup = get<HTMLFieldSetElement>('.visual-alignment');
  const save = get<HTMLButtonElement>('.save-alignment');
  const reset = get<HTMLButtonElement>('.reset-alignment');
  const useDefault = get<HTMLButtonElement>('.default-visual');
  const controls = new Map<keyof VisualAlignment, RangeControl>();
  const armControls = new Map<keyof ArmIkSettings, RangeControl>();
  const armGroup = get<HTMLFieldSetElement>('.arm-ik-controls');
  const armStatus = get<HTMLParagraphElement>('.arm-ik-status');
  const armState = get<HTMLDivElement>('.arm-ik-state');
  const resetArmIk = get<HTMLButtonElement>('.reset-arm-ik');
  const armMigration = get<HTMLParagraphElement>('.arm-ik-migration');
  let selectedProfile: string | null = null;
  const profiles = createSnapshotPicker({
    mount: get('.arm-ik-profiles'), signal: events.signal, id: 'arm-ik', noun: 'IK profile', plural: 'IK profiles',
    placeholder: 'e.g. Elbows down and out',
    list: () => armIkProfiles.list(localStorage),
    save: (name) => options.appearance.saveArmIk(name),
    load: (key) => options.appearance.loadArmIk(key),
    isStorageKey: (key) => armIkProfiles.isStorageKey(key),
    onNotice: options.onNotice,
  });
  const changeArmIk = (key: keyof ArmIkSettings, value: number): void => {
    try {
      options.appearance.previewArmIk({ ...options.appearance.armIkSettings(), [key]: value });
    } catch (error) {
      if (!(error instanceof AppearanceError)) throw error;
      options.onNotice(error.message, 'error');
      render();
    }
  };
  for (const field of ARM_IK_FIELDS) {
    const control = createRangeControl({
      ...field, ...ARM_IK_LIMITS,
      description: 'Preferred elbow position in torso-local metres. X increases right, Y up, and Z toward the camera. This never moves a hand grip.',
    }, {
      id: `arm-ik-${field.key}`,
      name: field.key,
      signal: events.signal,
      onInput: (value) => changeArmIk(field.key, value),
    });
    armGroup.append(control.row);
    armControls.set(field.key, control);
  }
  resetArmIk.addEventListener('click', () => options.appearance.resetArmIk(), listen);
  for (const part of VISUAL_PARTS) {
    const option = document.createElement('option');
    option.value = part.id;
    option.textContent = part.label;
    partPicker.append(option);
  }
  for (const field of ALIGNMENT_FIELDS) {
    const control = createRangeControl(field, {
      id: `visual-${field.key}`,
      name: field.key,
      signal: events.signal,
      onInput: (value) => {
        const state = options.appearance.snapshot().parts.find((part) => part.id === selected);
        if (!state) throw new Error(`Missing appearance state for ${selected}`);
        try {
          options.appearance.preview(selected, { ...state.alignment, [field.key]: value });
        } catch (error) {
          if (!(error instanceof AppearanceError)) throw error;
          options.onNotice(error.message, 'error');
          render();
        }
      },
    });
    alignmentGroup.append(control.row);
    controls.set(field.key, control);
  }
  partPicker.addEventListener('change', () => {
    if (!isVisualPart(partPicker.value)) {
      options.onNotice('Select a supported visual part.', 'error');
      partPicker.value = selected;
      return;
    }
    selected = partPicker.value;
    render();
  }, listen);
  filePicker.addEventListener('change', () => {
    const file = filePicker.files?.[0];
    filePicker.value = '';
    if (file) void options.appearance.importFile(selected, file);
  }, listen);
  save.addEventListener('click', () => void options.appearance.saveAlignment(selected), listen);
  reset.addEventListener('click', () => options.appearance.resetAlignment(selected), listen);
  useDefault.addEventListener('click', () => void options.appearance.useDefault(selected), listen);
  get<HTMLButtonElement>('.appearance-debug').addEventListener('click', options.onDebug, listen);

  function render(): void {
    const snapshot = options.appearance.snapshot();
    const armIk = snapshot.armIk;
    armGroup.disabled = snapshot.restoring;
    profiles.setDisabled(snapshot.restoring);
    if (armIk.profile !== null && armIk.profile.key !== selectedProfile) {
      selectedProfile = armIk.profile.key;
      profiles.select(selectedProfile);
    }
    resetArmIk.disabled = snapshot.restoring;
    armMigration.hidden = !armIk.previousSave;
    armStatus.textContent = snapshot.restoring ? 'Restoring appearance...' :
      armIk.error !== null ? armIk.error :
        armIk.dirty || armIk.profile === null ? 'Unsaved elbow-hint preview. Save a named IK profile to keep it.' :
          `Showing saved IK profile "${armIk.profile.name}".`;
    armState.dataset.kind = armIk.error !== null ? 'error' : armIk.dirty ? 'draft' : 'ready';
    for (const field of ARM_IK_FIELDS) {
      const control = armControls.get(field.key);
      if (!control) throw new Error(`Missing arm IK control: ${field.key}`);
      control.setValue(armIk.settings[field.key], { disabled: snapshot.restoring });
    }
    const state = snapshot.parts.find((part) => part.id === selected);
    if (!state) throw new Error(`Missing appearance state for ${selected}`);
    partPicker.value = selected;
    hint.textContent = state.hint;
    const sourceText = state.name === null ? 'Default visual' : state.name;
    if (source.textContent !== sourceText) source.textContent = sourceText;
    let message: string;
    let kind: string;
    if (state.busy) {
      message = snapshot.restoring ? 'Restoring saved visuals...' : 'Working on this part...';
      kind = 'busy';
    } else if (state.error !== null) {
      message = state.error;
      kind = 'error';
    } else if (snapshot.error !== null) {
      message = snapshot.error;
      kind = 'error';
    } else {
      message = state.name === null ? 'Choose a model to replace this part.' :
        state.dirty ? 'Alignment preview is not saved yet.' : 'Model and alignment saved on this device.';
      kind = state.dirty ? 'draft' : 'ready';
    }
    if (status.textContent !== message) status.textContent = message;
    statusBox.dataset.kind = kind;
    filePicker.disabled = state.busy;
    alignmentGroup.disabled = state.busy || !state.custom;
    save.disabled = state.busy || !state.custom || !state.dirty;
    reset.disabled = state.busy || !state.custom;
    useDefault.disabled = state.busy || (!state.custom && state.error === null);
    for (const field of ALIGNMENT_FIELDS) {
      const control = controls.get(field.key);
      if (!control) throw new Error(`Missing visual alignment control: ${field.key}`);
      control.setValue(state.alignment[field.key], { disabled: state.busy || !state.custom });
    }
    for (const option of Array.from(partPicker.options)) {
      const part = snapshot.parts.find((part) => part.id === option.value);
      if (!part) throw new Error(`Unknown appearance option: ${option.value}`);
      option.textContent = `${part.label}${part.custom ? ' (custom)' : ''}`;
    }
  }

  options.mount.append(root);
  const unsubscribe = options.appearance.subscribe(render);
  return {
    dispose: () => {
      unsubscribe();
      events.abort();
      root.remove();
    },
  };
}
