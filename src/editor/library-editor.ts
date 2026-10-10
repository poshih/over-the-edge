import { inspectCharacterModel, resolveAvatarJoints } from '../character-model-inspect';
import type { CharacterModelReport } from '../character-model-inspect';
import { AVATAR_JOINT_IDS, CharacterModelError } from '../character-profile';
import type { AvatarBoneMap, AvatarJointId, AvatarModelSettings, PartialAvatarBoneMap } from '../character-profile';
import { element, setText } from '../dom';
import { MODEL_LIMITS } from '../model-data';
import { mappedAvatarModel, MODEL_LIBRARY_LIMITS, PART_ROLES } from '../model-library';
import type { PartRole } from '../model-library';
import { AVATAR_JOINT_LABELS } from './avatar-joint-labels';
import type { Command, History } from './document/history';
import { applyProjectCommand } from './document/project-commands';
import type { ProjectCommandInfo, ProjectCommands } from './document/project-commands';
import type { ConfigureAvatar, EditOutcome, FileInput, ProjectImports } from './document/project-imports';
import type { LibraryModel, ProjectProjection } from './document/project-projection';
import { LibraryPreview } from './library-preview';
import type { PartModelHost } from './library-preview';
import { createServerModelPicker } from './server-model-picker';
import { serverModelSettings } from './server-models';
import type { ServerModels } from './server-models';

const ROLE_LABELS: Readonly<Record<PartRole, { one: string; many: string }>> = {
  avatar: { one: 'avatar', many: 'Avatars' },
  hammer: { one: 'hammer', many: 'Hammers' },
  pot: { one: 'pot', many: 'Pots' },
};

interface AddingAvatar {
  readonly kind: 'add';
  readonly finish: (model: AvatarModelSettings) => void;
  readonly cancel: () => void;
  done: boolean;
}

// The avatar whose bone map is open: a pending import, or a library entry.
interface BoneEditing {
  readonly target: AddingAvatar | { readonly kind: 'entry'; readonly key: string };
  readonly name: string;
  readonly report: CharacterModelReport;
  readonly boneMap: PartialAvatarBoneMap;
  readonly issue: CharacterModelError | null;
}

function boneIssue(report: CharacterModelReport, boneMap: PartialAvatarBoneMap): CharacterModelError | null {
  try {
    resolveAvatarJoints(report, boneMap);
    return null;
  } catch (error) {
    if (error instanceof CharacterModelError) return error;
    throw error;
  }
}

function metres(value: number): string {
  return `${Number(value.toFixed(3))} m`;
}

function avatarSummary(model: LibraryModel): string {
  const avatar = model.avatar!;
  const grips = `${avatar.grips.placement === 'fixed' ? 'fixed' : 'sliding'} grips at ${metres(avatar.grips.left)} and ${metres(avatar.grips.right)}`;
  return `${grips} · ${avatar.arms === null ? 'natural arm lengths' : 'set arm lengths'} · arms ${metres(avatar.armForwardDistance)} forward`;
}

export interface LibraryEditorOptions {
  readonly mount: HTMLElement;
  readonly history: History;
  readonly commands: ProjectCommands;
  readonly imports: ProjectImports;
  readonly projection: ProjectProjection;
  readonly parts: PartModelHost;
  readonly serverModels: ServerModels;
  readonly onNotice: (message: string, kind: 'info' | 'error') => void;
}

/**
 * Project / Model library: the avatars, hammers and pots a release can swap to, each part on its
 * own. Previews show a library model in the Workshop's game the way a release shows it once the
 * game's backend selects it.
 */
export function createLibraryEditor(options: LibraryEditorOptions): { dispose(): void } {
  const { history, commands, imports, projection } = options;
  const events = new AbortController();
  const listen = { signal: events.signal };
  let editing: BoneEditing | null = null;
  let boneRead: AbortController | null = null;
  const info = (label: string): ProjectCommandInfo =>
    ({ label, place: { tab: 'project', section: 'project-models', select: null }, coalesce: null });
  const apply = (command: Command): void => {
    const refusal = applyProjectCommand(history, command);
    if (refusal !== null) options.onNotice(refusal.message, 'error');
  };
  function noticeImport<T>(outcome: EditOutcome<T>): void {
    if (!events.signal.aborted && outcome.kind === 'refused') options.onNotice(outcome.error.message, 'error');
  }
  const root = document.createElement('div');
  root.className = 'project-library';
  root.innerHTML = `
    <p class="appearance-format">Extra models a release can swap to, one part at a time. The release only
      loads one when the game's backend selects it for the player; the backend decides and stores each choice.
      Library avatars show on Avatar (3D) characters, hammers and pots on every character type.</p>
    ${PART_ROLES.map((role) => `
      <fieldset class="tuning-group project-library-part" data-role="${role}">
        <legend>${ROLE_LABELS[role].many}</legend>
        <ul class="project-media-list project-library-list" aria-label="Library ${ROLE_LABELS[role].many.toLowerCase()}"></ul>
        <label class="appearance-label" for="project-library-${role}-preview">Preview ${ROLE_LABELS[role].one}</label>
        <select id="project-library-${role}-preview" class="project-library-preview"></select>
        <label class="appearance-label" for="project-library-${role}-file">Add ${ROLE_LABELS[role].one} GLB</label>
        <input id="project-library-${role}-file" class="project-library-file" type="file" accept=".glb,model/gltf-binary" />
        <div class="project-library-server"></div>
      </fieldset>`).join('')}
    <fieldset class="tuning-group project-library-bones" hidden>
      <legend class="project-library-bones-title">Bone map</legend>
      <p class="appearance-format project-library-bones-status" role="status" aria-live="polite"></p>
      <div class="bone-map-grid project-library-bone-grid"></div>
      <p class="bone-map-issue project-library-bone-issue" role="alert" aria-atomic="true" hidden></p>
      <div class="sprite-action-row">
        <button type="button" class="button project-library-bones-close">Close bone map</button>
      </div>
    </fieldset>
    <p class="appearance-format">Self-contained GLB 2.0 files checked like the character's own models, up to
      ${MODEL_LIMITS.bytes / 1024 ** 2} MiB each and ${MODEL_LIBRARY_LIMITS.entries} per part. Each model downloads only
      when it is used: here when you preview or edit it, in a release when the game's backend selects it. A new avatar
      maps Mixamo-style joints automatically and takes the open character's grips, arm lengths and arm forward distance.</p>
  `;
  const bones = element<HTMLFieldSetElement>(root, '.project-library-bones');
  const bonesTitle = element<HTMLElement>(root, '.project-library-bones-title');
  const bonesStatus = element<HTMLParagraphElement>(root, '.project-library-bones-status');
  const bonesIssue = element<HTMLParagraphElement>(root, '.project-library-bone-issue');
  const boneSelects = new Map<AvatarJointId, HTMLSelectElement>();
  let describedJoints: CharacterModelReport | null = null;
  for (const joint of AVATAR_JOINT_IDS) {
    const label = document.createElement('label');
    label.className = 'appearance-label';
    label.htmlFor = `project-library-bone-${joint}`;
    label.textContent = AVATAR_JOINT_LABELS[joint];
    const select = document.createElement('select');
    select.id = `project-library-bone-${joint}`;
    select.dataset.joint = joint;
    select.addEventListener('change', () => { void setBone(joint, select.value); }, listen);
    element(root, '.project-library-bone-grid').append(label, select);
    boneSelects.set(joint, select);
  }

  const preview = new LibraryPreview({
    host: options.parts,
    blob: (role, id) => projection.libraryBlob(role, id, events.signal),
    onChange: () => { if (!events.signal.aborted) renderPreview(); },
    onError: (message) => options.onNotice(message, 'error'),
  });

  const library = (): readonly LibraryModel[] => projection.libraryModels();

  function closeBones(): void {
    boneRead?.abort();
    boneRead = null;
    const current = editing;
    editing = null;
    if (current?.target.kind === 'add') current.target.cancel();
  }

  // `model`, a server avatar's own settings, adds it as it is; otherwise an avatar maps its joints.
  async function add(role: PartRole, input: FileInput, model?: AvatarModelSettings): Promise<void> {
    const task = new AbortController();
    const preparation: { target: AddingAvatar | null; release: (() => void) | null } = { target: null, release: null };
    const configure: ConfigureAvatar = (report, boneMap, signal) => {
      signal.throwIfAborted();
      const issue = boneIssue(report, boneMap);
      if (issue === null) return Promise.resolve(mappedAvatarModel(boneMap as AvatarBoneMap));
      closeBones();
      return new Promise<AvatarModelSettings>((resolve, reject) => {
        const target: AddingAvatar = {
          kind: 'add', done: false,
          finish: (settings) => {
            if (target.done) return;
            target.done = true;
            resolve(settings);
          },
          cancel: () => task.abort(),
        };
        const aborted = (): void => {
          if (!target.done) {
            target.done = true;
            reject(signal.reason);
          }
          if (editing?.target === target) {
            editing = null;
            if (!events.signal.aborted) renderBones();
          }
        };
        signal.addEventListener('abort', aborted, { once: true });
        preparation.target = target;
        preparation.release = () => signal.removeEventListener('abort', aborted);
        editing = { target, name: input.name, report, boneMap, issue };
        renderBones();
      });
    };
    try {
      const outcome = await imports.library(role, input, {
        info: info(`Add library ${role} ${input.name.replace(/\.glb$/i, '')}`),
        signal: AbortSignal.any([events.signal, task.signal]),
        ...(model === undefined ? role === 'avatar' ? { configure } : {} : { model }),
      });
      noticeImport(outcome);
      if (events.signal.aborted) return;
      if (outcome.kind === 'applied' || outcome.kind === 'unchanged') {
        const added = outcome.value;
        const current = editing;
        if (preparation.target !== null && current?.target === preparation.target) {
          editing = {
            ...current, target: { kind: 'entry', key: added.key }, name: added.name, boneMap: added.avatar!.boneMap, issue: null,
          };
        }
        if (outcome.kind === 'applied') options.onNotice(`Added ${role} "${added.name}" (${added.id}) to the model library.`, 'info');
      }
    } finally {
      preparation.release?.();
      task.abort();
      if (preparation.target !== null && editing?.target === preparation.target) editing = null;
      if (!events.signal.aborted) renderBones();
    }
  }

  async function editBones(model: LibraryModel): Promise<void> {
    closeBones();
    renderBones();
    const task = new AbortController();
    boneRead = task;
    const signal = AbortSignal.any([events.signal, task.signal]);
    try {
      const blob = await projection.libraryBlob('avatar', model.id, signal);
      signal.throwIfAborted();
      const bytes = await blob.arrayBuffer();
      signal.throwIfAborted();
      const report = inspectCharacterModel(bytes, 'avatar');
      const current = library().find((candidate) => candidate.key === model.key);
      if (current === undefined) return;
      editing = { target: { kind: 'entry', key: current.key }, name: current.name, report, boneMap: current.avatar!.boneMap, issue: null };
      renderBones();
    } catch (error) {
      if (signal.aborted && error instanceof DOMException && error.name === 'AbortError') return;
      if (!(error instanceof Error)) throw error;
      options.onNotice(`Could not read library avatar "${model.name}": ${error.message}`, 'error');
    } finally {
      if (boneRead === task) boneRead = null;
    }
  }

  // A complete, valid map applies at once; others stay open with their issue.
  async function setBone(joint: AvatarJointId, name: string): Promise<void> {
    const base = editing;
    if (base === null || base.target.kind === 'add' && base.target.done) return;
    const boneMap: Partial<Record<AvatarJointId, string>> = { ...base.boneMap };
    if (name === '') delete boneMap[joint];
    else boneMap[joint] = name;
    const next: BoneEditing = { ...base, boneMap: Object.freeze(boneMap), issue: boneIssue(base.report, boneMap) };
    editing = next;
    renderBones();
    if (next.issue !== null) return;
    if (next.target.kind === 'add') {
      next.target.finish(mappedAvatarModel(boneMap as AvatarBoneMap));
    } else {
      const key = next.target.key;
      const model = library().find((candidate) => candidate.key === key);
      if (model !== undefined) {
        noticeImport(await imports.libraryAvatar(model.id, { ...model.avatar!, boneMap: boneMap as AvatarBoneMap }, {
          info: info(`Set library avatar ${model.name} bone map`), signal: events.signal,
        }));
        if (events.signal.aborted) return;
        const current = library().find((candidate) => candidate.key === key);
        if (editing === next && current !== undefined) editing = { ...next, boneMap: current.avatar!.boneMap, issue: null };
      }
    }
    if (!events.signal.aborted) renderBones();
  }

  function entryRow(model: LibraryModel): HTMLLIElement {
    const row = document.createElement('li');
    row.dataset.model = model.id;
    const name = document.createElement('span');
    name.className = 'project-media-path';
    name.textContent = `${model.name} (${model.id})`;
    const detail = document.createElement('span');
    detail.className = 'project-media-detail';
    detail.textContent = model.avatar === null ? `library ${model.role}` : avatarSummary(model);
    const actions = document.createElement('div');
    actions.className = 'project-library-actions';
    const action = (text: string, label: string, run: () => void): void => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'button';
      button.textContent = text;
      button.setAttribute('aria-label', `${label} ${model.role} ${model.id}`);
      button.addEventListener('click', run, listen);
      actions.append(button);
    };
    if (model.avatar !== null) {
      action('Bone map', 'Edit the bone map of', () => { void editBones(model); });
      action('Use character settings', 'Use the open character\'s grips, arm lengths and arm distance for', () => {
        void imports.useCharacterSettings(model.id, {
          info: info(`Use character settings for ${model.name}`), signal: events.signal,
        }).then(noticeImport);
      });
    }
    action('Remove', 'Remove', () => apply(commands.libraryRemove(model.role, model.id,
      info(`Remove library ${model.role} ${model.name}`))));
    row.append(name, detail, actions);
    return row;
  }

  function renderPreview(): void {
    const state = preview.state();
    const models = library();
    for (const role of PART_ROLES) {
      const select = element<HTMLSelectElement>(root, `#project-library-${role}-preview`);
      const choices = models.filter((model) => model.role === role);
      const values = ['', ...choices.map((model) => model.id)];
      const names = ['Character\'s own', ...choices.map((model) => `${model.name} (${model.id})`)];
      if (select.options.length !== values.length || [...select.options].some((option, index) =>
        option.value !== values[index] || option.textContent !== names[index])) {
        select.replaceChildren(...values.map((value, index) => {
          const option = document.createElement('option');
          option.value = value;
          option.textContent = names[index]!;
          return option;
        }));
      }
      select.value = state[role].id ?? '';
      select.setAttribute('aria-busy', String(state[role].loading));
    }
  }

  function renderBones(): void {
    const current = editing;
    if (current !== null && current.target.kind === 'entry') {
      const key = current.target.key;
      if (!library().some((model) => model.key === key)) editing = null;
    }
    bones.hidden = editing === null;
    if (editing === null) return;
    setText(bonesTitle, `Bone map: ${editing.name}`);
    setText(bonesStatus, editing.target.kind === 'add'
      ? editing.target.done ? `"${editing.name}" is being added to the library.`
        : `"${editing.name}" is not added yet: map all eight joints to add it.`
      : editing.issue === null ? 'Changes apply to the library avatar as soon as all eight joints resolve.'
        : 'This map is not applied: fix it to change the library avatar.');
    if (describedJoints !== editing.report) {
      describedJoints = editing.report;
      const names = editing.report.joints.map((joint) => joint.name);
      for (const select of boneSelects.values()) {
        select.replaceChildren(...['', ...names].map((name) => {
          const option = document.createElement('option');
          option.value = name;
          option.textContent = name === '' ? 'Choose a joint' : name;
          return option;
        }));
      }
    }
    const issue = editing.issue;
    for (const [joint, select] of boneSelects) {
      const value = editing.boneMap[joint] ?? '';
      if (select.value !== value) select.value = value;
      select.disabled = editing.target.kind === 'add' && editing.target.done;
      select.setAttribute('aria-invalid', String(issue !== null && (issue.joints.includes(joint) || value !== '' && issue.joints.includes(value))));
    }
    bonesIssue.hidden = issue === null;
    setText(bonesIssue, issue?.message ?? '');
  }

  function render(): void {
    const models = library();
    for (const role of PART_ROLES) {
      const list = element<HTMLUListElement>(root, `.project-library-part[data-role="${role}"] .project-library-list`);
      const rows = models.filter((model) => model.role === role).map(entryRow);
      if (rows.length === 0) {
        const empty = document.createElement('li');
        empty.className = 'project-media-empty';
        empty.textContent = `No library ${ROLE_LABELS[role].many.toLowerCase()}.`;
        rows.push(empty);
      }
      list.replaceChildren(...rows);
    }
    renderPreview();
    renderBones();
  }

  for (const role of PART_ROLES) {
    element(root, `.project-library-part[data-role="${role}"] .project-library-server`).append(createServerModelPicker({
      role, id: `project-library-${role}-server`, action: 'Add', served: options.serverModels, signal: events.signal,
      take: (download, model) => add(role, { name: `${model.name}.glb`, read: (signal) => download(signal) }, serverModelSettings(model)),
    }).root);
    const file = element<HTMLInputElement>(root, `#project-library-${role}-file`);
    file.addEventListener('change', () => {
      const chosen = file.files?.[0];
      file.value = '';
      if (chosen !== undefined) void add(role, chosen);
    }, listen);
    const select = element<HTMLSelectElement>(root, `#project-library-${role}-preview`);
    select.addEventListener('change', () => {
      const model = library().find((candidate) => candidate.role === role && candidate.id === select.value) ?? null;
      void preview.show(role, model);
    }, listen);
  }
  element(root, '.project-library-bones-close').addEventListener('click', () => {
    closeBones();
    renderBones();
  }, listen);

  const unsubscribe = history.document.subscribeAll((changes, cause) => {
    for (const change of changes) {
      if (change.section !== 'models') continue;
      const models = library();
      const current = editing;
      if (current?.target.kind === 'entry') {
        const key = current.target.key;
        const model = models.find((candidate) => candidate.key === key);
        if (model === undefined) editing = null;
        else {
          const previous = change.before.avatar.find((candidate) => candidate.entry.id === model.id);
          const reset = cause === 'open' || previous?.entry.boneMap !== model.avatar!.boneMap;
          editing = {
            ...current, name: model.name,
            boneMap: reset ? model.avatar!.boneMap : current.boneMap, issue: reset ? null : current.issue,
          };
        }
      }
      preview.refresh(models);
      render();
    }
  });
  options.mount.append(root);
  render();
  return {
    dispose(): void {
      events.abort();
      closeBones();
      unsubscribe();
      preview.dispose();
      root.remove();
    },
  };
}
