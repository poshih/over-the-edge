import { inspectCharacterModel, resolveAvatarJoints, suggestAvatarBoneMap } from '../character-model-inspect';
import type { CharacterModelReport } from '../character-model-inspect';
import { AVATAR_JOINT_IDS, CharacterModelError } from '../character-profile';
import type { AvatarBoneMap, AvatarJointId, AvatarModelSettings } from '../character-profile';
import { element, setText } from '../dom';
import { MODEL_LIMITS } from '../model-data';
import { mappedAvatarModel, MODEL_LIBRARY_LIMITS, PART_ROLES } from '../model-library';
import type { PartRole } from '../model-library';
import { AVATAR_JOINT_LABELS } from './avatar-joint-labels';
import { LibraryPreview } from './library-preview';
import type { PartModelHost } from './library-preview';
import type { LibraryModel, ProjectSession } from './project-session';
import { createServerModelPicker } from './server-model-picker';
import { serverModelSettings } from './server-models';
import type { ServerModels } from './server-models';

const ROLE_LABELS: Readonly<Record<PartRole, { one: string; many: string }>> = {
  avatar: { one: 'avatar', many: 'Avatars' },
  hammer: { one: 'hammer', many: 'Hammers' },
  pot: { one: 'pot', many: 'Pots' },
};

// The avatar whose bone map is open: a GLB being added, or a library entry.
interface BoneEditing {
  readonly target: { readonly kind: 'add'; readonly file: File } | { readonly kind: 'entry'; readonly key: number };
  readonly name: string;
  readonly report: CharacterModelReport;
  readonly boneMap: Readonly<Partial<Record<AvatarJointId, string>>>;
  readonly issue: CharacterModelError | null;
}

function boneIssue(report: CharacterModelReport, boneMap: Partial<Record<AvatarJointId, string>>): CharacterModelError | null {
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

/**
 * Project / Model library: the avatars, hammers and pots a release can swap to, each part on its
 * own. Previews show a library model in the Workshop's game the way a release shows it once the
 * game's backend selects it.
 */
export function createLibraryEditor(options: {
  readonly mount: HTMLElement;
  readonly session: ProjectSession;
  readonly parts: PartModelHost;
  // The avatars, hammers and pots this Workshop's server shares.
  readonly serverModels: ServerModels;
  readonly onNotice: (message: string, kind: 'info' | 'error') => void;
}): { dispose(): void } {
  const { session } = options;
  const events = new AbortController();
  const listen = { signal: events.signal };
  let editing: BoneEditing | null = null;
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
      ${MODEL_LIMITS.bytes / 1024 ** 2} MiB each, ${MODEL_LIBRARY_LIMITS.entries} per part and
      ${MODEL_LIBRARY_LIMITS.totalBytes / 1024 ** 2} MiB in total. A new avatar maps Mixamo-style joints
      automatically and takes the open character's grips, arm lengths and arm forward distance.</p>
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
    blob: (role, id) => session.libraryBlob(role, id),
    onChange: () => renderPreview(),
    onError: (message) => options.onNotice(message, 'error'),
  });

  const library = (): readonly LibraryModel[] => session.snapshot().library;

  // `model`, a server avatar's own settings, adds it as it is; otherwise an avatar maps its joints.
  async function add(role: PartRole, file: File, model?: AvatarModelSettings): Promise<void> {
    if (model !== undefined) {
      await commitAdd(file, model);
      return;
    }
    if (role === 'avatar') {
      let report: CharacterModelReport;
      try {
        if (file.size > MODEL_LIMITS.bytes) throw new CharacterModelError('model-limits', `Choose a GLB file no larger than ${MODEL_LIMITS.bytes / 1024 ** 2} MiB.`);
        report = inspectCharacterModel(await file.arrayBuffer(), 'avatar');
      } catch (error) {
        if (!(error instanceof CharacterModelError)) throw error;
        options.onNotice(`${file.name}: ${error.message}`, 'error');
        return;
      }
      const boneMap = suggestAvatarBoneMap(report);
      const issue = boneIssue(report, boneMap);
      // An avatar whose joints do not all map automatically waits for its bone map.
      if (issue !== null) {
        editing = { target: { kind: 'add', file }, name: file.name, report, boneMap, issue };
        render();
        return;
      }
      await commitAdd(file, mappedAvatarModel(boneMap as AvatarBoneMap));
      return;
    }
    const added = await session.addLibraryModel(role, file);
    if (!(added instanceof Error)) options.onNotice(`Added ${role} "${added.name}" (${added.id}) to the model library.`, 'info');
  }

  async function commitAdd(file: File, model: AvatarModelSettings): Promise<LibraryModel | null> {
    const added = await session.addLibraryModel('avatar', file, model);
    if (added instanceof Error) return null;
    options.onNotice(`Added avatar "${added.name}" (${added.id}) to the model library.`, 'info');
    return added;
  }

  async function editBones(model: LibraryModel): Promise<void> {
    let report: CharacterModelReport;
    try {
      report = inspectCharacterModel(await (await session.libraryBlob('avatar', model.id)).arrayBuffer(), 'avatar');
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      options.onNotice(`Could not read library avatar "${model.name}": ${error.message}`, 'error');
      return;
    }
    editing = { target: { kind: 'entry', key: model.key }, name: model.name, report, boneMap: model.avatar!.boneMap, issue: null };
    render();
  }

  // A complete, valid map applies at once; others stay open with their issue.
  async function setBone(joint: AvatarJointId, name: string): Promise<void> {
    const base = editing;
    if (base === null) return;
    const boneMap: Partial<Record<AvatarJointId, string>> = { ...base.boneMap };
    if (name === '') delete boneMap[joint];
    else boneMap[joint] = name;
    const next: BoneEditing = { ...base, boneMap: Object.freeze(boneMap), issue: boneIssue(base.report, boneMap) };
    editing = next;
    render();
    if (next.issue !== null) return;
    if (next.target.kind === 'add') {
      const added = await commitAdd(next.target.file, mappedAvatarModel(boneMap as AvatarBoneMap));
      if (added !== null && editing === next) editing = { ...next, target: { kind: 'entry', key: added.key } };
    } else {
      const key = next.target.key;
      const model = library().find((candidate) => candidate.key === key);
      if (model !== undefined) await session.setLibraryAvatar(model.id, { ...model.avatar!, boneMap: boneMap as AvatarBoneMap });
    }
    render();
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
        void session.useCharacterSettings(model.id);
      });
    }
    action('Remove', 'Remove', () => session.removeLibraryModel(model.role, model.id));
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
      if (select.options.length !== values.length || [...select.options].some((option, index) => option.value !== values[index])) {
        select.replaceChildren(...values.map((value, index) => {
          const option = document.createElement('option');
          option.value = value;
          option.textContent = index === 0 ? 'Character\'s own' : `${choices[index - 1]!.name} (${value})`;
          return option;
        }));
      }
      select.value = state[role].id ?? '';
      select.setAttribute('aria-busy', String(state[role].loading));
    }
  }

  function renderBones(): void {
    const models = library();
    const current = editing;
    if (current !== null && current.target.kind === 'entry') {
      const key = current.target.key;
      if (!models.some((model) => model.key === key)) editing = null;
    }
    bones.hidden = editing === null;
    if (editing === null) return;
    setText(bonesTitle, `Bone map: ${editing.name}`);
    setText(bonesStatus, editing.target.kind === 'add'
      ? `"${editing.name}" is not added yet: map all eight joints to add it.`
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
    // A server model downloads while the open project is held, then is added like a GLB chosen from the computer.
    element(root, `.project-library-part[data-role="${role}"] .project-library-server`).append(createServerModelPicker({
      role, id: `project-library-${role}-server`, action: 'Add', served: options.serverModels, signal: events.signal,
      take: async (download, model) => {
        const file = await session.download(`Downloading a server ${ROLE_LABELS[role].one}`, download);
        if (file !== null) await add(role, file, serverModelSettings(model));
      },
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
    editing = null;
    render();
  }, listen);

  let shown: readonly LibraryModel[] | null = null;
  const unsubscribe = session.subscribe((event) => {
    if (event.kind !== 'content') return;
    const models = library();
    // Library rows rebuild only when the library changed.
    if (shown !== null && shown.length === models.length && shown.every((model, index) =>
      model.key === models[index]!.key && model.name === models[index]!.name && model.avatar === models[index]!.avatar &&
      model.head === models[index]!.head)) return;
    shown = models;
    preview.refresh(models);
    render();
  });
  options.mount.append(root);
  shown = library();
  render();
  return {
    dispose(): void {
      events.abort();
      unsubscribe();
      preview.dispose();
      root.remove();
    },
  };
}
