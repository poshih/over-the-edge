import { isVisualPartId } from '../appearance-profile';
import type { Appearance } from './appearance';
import {
  ALIGNMENT_FIELDS, AppearanceError, ARM_IK_FIELDS, ARM_IK_LIMITS, DEFAULT_ALIGNMENT, DEFAULT_ARM_IK,
  MODEL_LIMITS, VISUAL_PARTS,
} from './appearance-types';
import type { ArmIkSettings, VisualAlignment, VisualPartId } from './appearance-types';
import { armIkProfiles } from './arm-ik-store';
import { HISTORY_LIMITS } from './document/history';
import type { Command, History } from './document/history';
import type { ProjectCommandInfo } from './document/project-commands';
import type { DocumentAppearancePart, DocumentArmIk } from './document/project-document';
import { createProjectSaveButton } from './project-save';
import type { ProjectSaveTarget } from './project-save';
import { createRangeControl } from './range-control';
import type { RangeControl } from './range-control';
import type { ServerCopies } from './server-copies';
import { createServerCopyPicker } from './server-copy-picker';
import { createSnapshotPicker } from './snapshot-picker';
import type { VisualSaves } from './visual-saves';
import { sectionMarkup } from './workshop-section';

interface AppearanceUiOptions {
  readonly mount: HTMLElement;
  readonly appearance: Appearance;
  readonly history: History;
  readonly saves: VisualSaves;
  readonly onNotice: (message: string, kind: 'info' | 'error') => void;
  readonly onFault: (error: unknown) => void;
  readonly projectSave: ProjectSaveTarget;
  readonly serverCopies: ServerCopies;
}

export function createAppearanceUI(options: AppearanceUiOptions): { dispose(): void } {
  const { appearance, history, saves } = options;
  const { browserAppearance } = appearance;
  const events = new AbortController();
  const listen = { signal: events.signal };
  const importing = new Map<VisualPartId, object>();
  const pendingImports = new Map<VisualPartId, number>();
  const saving = new Map<VisualPartId, object>();
  const issues = new Map<VisualPartId, { readonly value: DocumentAppearancePart | null; readonly error: Error }>();
  let armIssue: { readonly value: DocumentArmIk; readonly error: Error } | null = null;
  let selected: VisualPartId = 'pot';
  const root = document.createElement('div');
  root.className = 'appearance-editor';
  root.innerHTML = `
    <div class="workshop-scroll appearance-scroll">
      <section class="appearance-part" aria-label="Replace a part">
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
      </section>
      ${sectionMarkup({ id: 'appearance-alignment', title: 'Model alignment', hint: 'Scale, rotation and offsets', open: true }, `
        <p class="appearance-format">Auto-fit preserves proportions. Rotation is applied before fitting.
          Adjustments change the project live and can be undone.</p>
        <fieldset class="tuning-group visual-alignment"><legend class="visually-hidden">Model alignment</legend></fieldset>
      `)}
      ${sectionMarkup({ id: 'appearance-arm-ik', title: 'Body-relative elbow hints', hint: 'Arm IK for both 3D types' }, `
        <fieldset class="tuning-group arm-ik-controls"><legend class="visually-hidden">Body-relative elbow hints</legend></fieldset>
        <p class="appearance-format">Hints are preferred elbow positions relative to the torso:
          X left/right, Y down/up, Z away/toward the camera, in metres.
          Hands stay on the shaft. The Overlay also shows hint crosses and arm chains.</p>
        <div class="arm-ik-actions">
          <button type="button" class="button reset-arm-ik">Reset arm IK</button>
        </div>
        <div class="appearance-state arm-ik-state" role="status" aria-live="polite" aria-atomic="true">
          <p class="arm-ik-status"></p>
        </div>
        <div class="arm-ik-profiles"></div>
        <p class="appearance-format">Reset and profile loads change the project and can be undone.
          ${browserAppearance ? 'The last selected IK profile restores on reload.' : 'This Workshop reopens its project values, not independent IK saves.'}
          Physics presets and model alignment are separate.</p>
      `)}
      ${sectionMarkup({ id: 'appearance-arm-ik-server', title: 'Server IK profiles', hint: 'Load or save elbow hints shared on this server' },
    '<div class="arm-ik-server"></div>')}
      ${sectionMarkup({ id: 'appearance-about', title: 'About 3D parts', hint: 'What imports change' }, `
        <section class="appearance-intro" aria-label="About 3D parts">
          <p>Mesh parts mode uses separate Three.js objects for the body and limbs. Avatar mode uses one
            connected, skinned upper body instead; its pot and hammer remain separate. Choose the type in Character.</p>
          <p>Import a GLB to replace an individual rigid part. The existing visual 3D arm IK and Planck 2D
            physics keep driving it. Body-part imports are shown in Mesh parts mode; pot and hammer imports
            also work with Avatar mode. Import a whole skinned avatar, a one-model hammer or a pot model in
            Character; a profile hammer or pot model hides the matching imports here. Imported animation is not played.</p>
          <p><strong>Cosmetic only:</strong> models do not change collision shapes, mass or grip. Use the Overlay
            to compare a visual with the actual contact shape.</p>
          <p>Parts and alignment belong to the project, separately from exported character / sprite profiles.
            ${browserAppearance ? 'Imports and Use default also save in this browser; save alignment to keep later adjustments on reload.'
    : 'The project keeps models and alignment together in its own browser copy or on the project server.'}
            Imported animations, cameras and lights are not used.</p>
        </section>
      `)}
    </div>
    <footer class="workshop-footer appearance-footer">
      <div class="persistence-actions">
        <button type="button" class="button button-primary save-alignment">Save alignment</button>
        <button type="button" class="button reset-alignment">Reset fit</button>
        <button type="button" class="button default-visual">Use default</button>
      </div>
      <p>${browserAppearance ? 'Imports save automatically in this browser. Later alignment changes save separately.'
    : 'Models and alignment save with the project.'}</p>
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
  save.hidden = !browserAppearance;

  function info(label: string, section: string, part?: VisualPartId): ProjectCommandInfo {
    return {
      label: label.slice(0, HISTORY_LIMITS.label),
      place: { tab: 'appearance', section, select: part === undefined ? null : { before: [part], after: [part] } },
      coalesce: null,
    };
  }

  function partValue(part: VisualPartId): DocumentAppearancePart | null {
    return appearance.definition().find((entry) => entry.part === part) ?? null;
  }

  function apply(command: Command): AppearanceError | null {
    const error = history.apply(command);
    if (error !== null && !(error instanceof AppearanceError)) throw error;
    if (error !== null) options.onNotice(error.message, 'error');
    return error;
  }

  function armError(error: Error): void {
    armIssue = { value: appearance.armIkSettings(), error };
    options.onNotice(error.message, 'error');
    render();
  }

  const profiles = createSnapshotPicker({
    mount: get('.arm-ik-profiles'), signal: events.signal, id: 'arm-ik', noun: 'IK profile', plural: 'IK profiles',
    placeholder: 'e.g. Elbows down and out',
    actions: [createProjectSaveButton({ target: options.projectSave, sections: ['arm-ik'], label: 'the arm IK', signal: events.signal })],
    list: () => armIkProfiles.list(localStorage),
    save: (name) => {
      const result = saves.saveArmIk(name, appearance.armIkSettings());
      if (result.kind === 'refused') { armError(result.error); return null; }
      if (result.selection === 'not-selected') armError(result.error);
      else { armIssue = null; render(); }
      return result.entry;
    },
    load: (key) => {
      const read = saves.readArmIk(key);
      if (read.kind === 'refused') { armError(read.error); return null; }
      if (read.kind === 'absent') { armError(new AppearanceError('That IK profile is no longer available.')); return null; }
      try {
        const profile = read.value;
        if (apply(appearance.commands.armIk(() => profile.settings, info(`Load IK profile ${profile.name}`, 'appearance-arm-ik'))) !== null) return null;
        saves.loadedArmIk(profile, appearance.armIkSettings());
        const error = saves.selectArmIk(key);
        if (error !== null) armError(new AppearanceError(`Loaded "${profile.name}", but its selection for reload was not saved. ${error.message}`, { cause: error }));
        else { armIssue = null; render(); }
        return { name: profile.name };
      } finally {
        read.release();
      }
    },
    isStorageKey: (key) => armIkProfiles.isStorageKey(key),
    onNotice: options.onNotice,
  });
  createServerCopyPicker({
    mount: get('.arm-ik-server'), signal: events.signal, copies: options.serverCopies, kind: 'arm-ik',
    id: 'arm-ik', noun: 'IK profile', plural: 'IK profiles', placeholder: 'e.g. elbows-out', onNotice: options.onNotice,
    capture: () => appearance.armIkSettings(),
    load: async (name, read) => {
      const result = await appearance.imports.armIk(read, {
        info: info(`Load IK profile ${name}`, 'appearance-arm-ik-server'), signal: events.signal,
      });
      if (events.signal.aborted || result.kind === 'cancelled') return false;
      if (result.kind === 'refused') { armError(result.error); return false; }
      armIssue = null;
      render();
      return true;
    },
    afterLoad: 'Save it as a named IK profile to keep an independent browser save.',
  });
  get('.appearance-footer .persistence-actions').append(createProjectSaveButton({
    target: options.projectSave, sections: ['appearance'], label: 'the appearance models and alignment', signal: events.signal,
  }));

  for (const field of ARM_IK_FIELDS) {
    const control = createRangeControl({
      ...field, ...ARM_IK_LIMITS,
      description: 'Preferred elbow position in torso-local metres. X increases right, Y up, and Z toward the camera. This never moves a hand grip.',
    }, {
      id: `arm-ik-${field.key}`, name: field.key, signal: events.signal, history,
      coalesceKey: () => `appearance/arm-ik/${field.key}`,
      onInput: (value) => {
        armIssue = null;
        const error = apply(appearance.commands.armIk((current) => ({ ...current, [field.key]: value }),
          info(`Set ${field.label}`, 'appearance-arm-ik')));
        if (error !== null) armIssue = { value: appearance.armIkSettings(), error };
        render();
      },
    });
    armGroup.append(control.row);
    armControls.set(field.key, control);
  }
  get('.reset-arm-ik').addEventListener('click', () => {
    armIssue = null;
    const error = apply(appearance.commands.armIk(() => DEFAULT_ARM_IK, info('Reset arm IK', 'appearance-arm-ik')));
    if (error !== null) armIssue = { value: appearance.armIkSettings(), error };
    render();
  }, listen);
  for (const part of VISUAL_PARTS) partPicker.append(new Option(part.label, part.id));
  const alignmentKey = (part: VisualPartId, key: keyof VisualAlignment): string => `appearance/${part}/${key}`;
  for (const field of ALIGNMENT_FIELDS) {
    const control = createRangeControl(field, {
      id: `visual-${field.key}`, name: field.key, signal: events.signal, history,
      coalesceKey: () => alignmentKey(selected, field.key),
      onInput: (value) => {
        issues.delete(selected);
        const error = apply(appearance.commands.alignment(selected, (current) => ({ ...current, [field.key]: value }),
          info(`Set ${field.label}`, 'appearance-alignment', selected)));
        if (error !== null) issues.set(selected, { value: partValue(selected), error });
        render();
      },
    });
    alignmentGroup.append(control.row);
    controls.set(field.key, control);
  }
  partPicker.addEventListener('change', () => {
    if (!isVisualPartId(partPicker.value)) {
      options.onNotice('Select a supported visual part.', 'error');
      partPicker.value = selected;
      return;
    }
    for (const field of ALIGNMENT_FIELDS) history.seal(alignmentKey(selected, field.key));
    selected = partPicker.value;
    render();
  }, listen);

  async function savePart(part: VisualPartId, value: DocumentAppearancePart | null): Promise<void> {
    const token = {};
    saving.set(part, token);
    issues.delete(part);
    render();
    try {
      const result = await saves.savePart(part, value, events.signal);
      if (events.signal.aborted) return;
      if (result.kind === 'refused') {
        if (saving.get(part) === token) issues.set(part, { value, error: result.error });
        options.onNotice(result.error.message, 'error');
      } else {
        options.onNotice(value === null ? 'Saved the default visual in this browser.' : `Saved "${value.name}" and its alignment in this browser.`, 'info');
      }
    } finally {
      if (saving.get(part) === token) saving.delete(part);
      if (!events.signal.aborted) render();
    }
  }

  async function importPart(part: VisualPartId, file: File): Promise<void> {
    const token = {};
    const expected = partValue(part);
    importing.set(part, token);
    pendingImports.set(part, (pendingImports.get(part) ?? 0) + 1);
    issues.delete(part);
    render();
    try {
      const result = await appearance.importPart(part, file, {
        info: info(`Import ${file.name}`, 'appearance-alignment', part), signal: events.signal,
      });
      if (events.signal.aborted) return;
      if (result.kind === 'refused' && importing.get(part) === token) {
        issues.set(part, { value: expected, error: result.error });
        options.onNotice(result.error.message, 'error');
      }
    } finally {
      if (importing.get(part) === token) importing.delete(part);
      const remaining = pendingImports.get(part)! - 1;
      if (remaining === 0) pendingImports.delete(part);
      else pendingImports.set(part, remaining);
      if (!events.signal.aborted) render();
    }
  }

  filePicker.addEventListener('change', () => {
    const file = filePicker.files?.[0];
    filePicker.value = '';
    if (file !== undefined) void importPart(selected, file).catch(options.onFault);
  }, listen);
  save.addEventListener('click', () => {
    void savePart(selected, partValue(selected)).catch(options.onFault);
  }, listen);
  reset.addEventListener('click', () => {
    issues.delete(selected);
    const error = apply(appearance.commands.alignment(selected, () => DEFAULT_ALIGNMENT, info('Reset model fit', 'appearance-alignment', selected)));
    if (error !== null) issues.set(selected, { value: partValue(selected), error });
    render();
  }, listen);
  useDefault.addEventListener('click', () => {
    const part = selected;
    issues.delete(part);
    const error = appearance.useDefault(part, info('Use default visual', 'appearance-alignment', part));
    if (error !== null) {
      issues.set(part, { value: partValue(part), error });
      options.onNotice(error.message, 'error');
    }
    render();
  }, listen);

  function render(): void {
    const snapshot = appearance.snapshot();
    const armIk = snapshot.armIk;
    if (armIssue !== null && armIssue.value !== armIk.settings) armIssue = null;
    armStatus.textContent = armIssue !== null ? armIssue.error.message : armIk.dirty
      ? 'Document elbow hints differ from the last browser save or loaded profile.'
      : 'Document elbow hints match the last browser save or loaded profile.';
    armState.dataset.kind = armIssue !== null ? 'error' : armIk.dirty ? 'draft' : 'ready';
    profiles.setDisabled(false);
    for (const field of ARM_IK_FIELDS) {
      const control = armControls.get(field.key);
      if (!control) throw new Error(`Missing arm IK control: ${field.key}`);
      control.setValue(armIk.settings[field.key]);
    }
    const state = snapshot.parts.find((part) => part.id === selected);
    if (!state) throw new Error(`Missing appearance state for ${selected}`);
    partPicker.value = selected;
    hint.textContent = state.hint;
    source.textContent = state.name === null ? 'Document: default visual' : `Document: ${state.name}`;
    const rendering = state.rendering;
    const issue = issues.get(selected);
    if (issue !== undefined && issue.value !== state.value) issues.delete(selected);
    const error = issues.get(selected)?.error ?? state.saveError;
    let message = rendering.kind === 'loading' ? 'Loading the document model…' : rendering.kind === 'failed'
      ? `Could not show the document model: ${rendering.error.message}` : state.value === null
        ? 'Default visual selected.' : 'Document model ready.';
    if (pendingImports.has(selected)) message = `Importing a replacement… ${message}`;
    if (saving.has(selected) || state.saving) message += ' Saving captured document values…';
    if (error !== null) message += ` ${error.message}`;
    else if (browserAppearance) message += state.dirty ? ' Document values are not saved in this browser.' : ' Document values match the browser save.';
    status.textContent = message;
    statusBox.dataset.kind = error !== null || rendering.kind === 'failed' ? 'error'
      : pendingImports.has(selected) || saving.has(selected) || state.saving || rendering.kind === 'loading' ? 'busy'
        : browserAppearance && state.dirty ? 'draft' : 'ready';
    const canAlign = state.value !== null && rendering.kind === 'ready';
    alignmentGroup.disabled = !canAlign;
    save.textContent = state.value === null ? 'Save default' : 'Save alignment';
    save.disabled = !browserAppearance || !state.dirty || saving.has(selected) || state.saving;
    reset.disabled = !canAlign;
    useDefault.disabled = state.value === null;
    for (const field of ALIGNMENT_FIELDS) {
      const control = controls.get(field.key);
      if (!control) throw new Error(`Missing visual alignment control: ${field.key}`);
      control.setValue(state.alignment[field.key], { disabled: !canAlign });
    }
    for (const option of Array.from(partPicker.options)) {
      const part = snapshot.parts.find((part) => part.id === option.value);
      if (!part) throw new Error(`Unknown appearance option: ${option.value}`);
      option.textContent = `${part.label}${part.value !== null ? ' (custom)' : ''}`;
    }
  }

  options.mount.append(root);
  const unsubscribe = appearance.subscribe((event) => {
    if ((event.cause === 'undo' || event.cause === 'redo') && event.step?.place.tab === 'appearance') {
      const restored = event.cause === 'undo' ? event.step.place.select?.before : event.step.place.select?.after;
      const part = restored?.find(isVisualPartId);
      if (part !== undefined) selected = part;
    }
    render();
  });
  return {
    dispose() {
      unsubscribe();
      events.abort();
      root.remove();
    },
  };
}
