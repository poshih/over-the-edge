import { element, setText } from '../dom';
import { CHARACTER_RIGGING_TYPES, SpriteError, SPRITE_FILE_BYTES } from '../sprite-data';
import type { CharacterRiggingType, SpriteDocument } from '../sprite-data';
import type { SpriteEditorState } from './sprite-state';
import { ARM_FORWARD_DISTANCE_LIMITS, DEFAULT_ARM_FORWARD_DISTANCE } from '../character-depth';
import {
  AVATAR_JOINT_IDS, CHARACTER_MODEL_LIMITS, DEFAULT_CEL_OUTLINE, SHADING_LIMITS,
} from '../character-profile';
import type { AvatarJointId, CelOutline, CharacterShading, ShadingMode } from '../character-profile';
import { RIG } from '../config';
import { createRangeControl } from './range-control';
import { createSpriteCharacterExample } from './sprite-character-example';
import './character-editor.css';

const JOINT_LABELS: Readonly<Record<AvatarJointId, string>> = {
  body: 'Body', head: 'Head',
  'left-upper-arm': 'Left upper arm', 'left-forearm': 'Left forearm', 'left-hand': 'Left hand',
  'right-upper-arm': 'Right upper arm', 'right-forearm': 'Right forearm', 'right-hand': 'Right hand',
};
const HEAD_HALF_LENGTH = Math.max(...RIG.headVertices.map(point => point.x));
const HEAD_HALF_HEIGHT = Math.max(...RIG.headVertices.map(point => point.y));
const metres = (value: number): string => `${Number(value.toFixed(2))} m`;

const CHARACTER_TYPES: Readonly<Record<CharacterRiggingType, { label: string; description: string }>> = {
  'model-3d': {
    label: 'Mesh parts (3D)',
    description: 'Separate torso, head, upper-arm, forearm and hand meshes follow the articulated rig. Individual parts can be replaced with GLBs in Appearance. Sprites and the unified avatar are hidden.',
  },
  'sprite-2d': {
    label: '2D sprite character',
    description: 'Draw only this profile’s PNGs; all 3D parts are hidden. Head cutouts and dedicated head bones follow aim with bounded neck tilt by default. Authored Directional Presentation replaces that default. A custom 2D skeleton is optional.',
  },
  'avatar-3d': {
    label: 'Avatar (3D, connected body)',
    description: 'One connected GPU-skinned mesh contains the torso, neck, head, arms and hands: the built-in upper body, or your imported skinned GLB. Its bones follow the existing arm IK. The pot and hammer stay separate; sprite artwork and separate body-part meshes are hidden.',
  },
};

export function createCharacterEditor(options: {
  readonly mount: HTMLElement;
  readonly state: SpriteEditorState;
  readonly actions: {
    save(): void;
    revert(): void;
    importDocument(): void;
    exportDocument(): void;
  };
  readonly onNotice: (message: string, kind: 'info' | 'error') => void;
  readonly signal: AbortSignal;
}): { dispose(): void } {
  const events = new AbortController();
  const listen = { signal: events.signal };
  let disposed = false;
  let describedDocument: SpriteDocument | null = null;
  const root = document.createElement('div');
  root.className = 'character-editor';
  root.innerHTML = `
    <div class="workshop-scroll character-scroll">
      <section class="character-intro">
        <h3>Choose your character's look.</h3>
        <p>Choose <strong>2D sprites</strong>, <strong>separate 3D mesh parts</strong>, or a
          <strong>connected, skinned 3D avatar</strong>. The default remains the separate mesh-part character.</p>
        <p>Every type keeps <strong>Planck 2D physics</strong>, hammer motion, grip positions and IK targets unchanged.</p>
      </section>

      <label class="appearance-label" for="character-rigging-type">Character type</label>
      <select id="character-rigging-type" name="characterRiggingType" aria-describedby="character-technology character-type-help"></select>
      <p id="character-technology" class="appearance-format" aria-live="polite"></p>
      <p id="character-type-help" class="appearance-format">Type changes are draft-only. Switching types keeps
        all images, layers, bones, directional settings and imported GLB parts; it ends temporary sprite previews.
        Choose Save to keep the profile across reloads.</p>
      <p class="appearance-format">Hybrid has been removed. Older Hybrid profiles with sprites become pure 2D;
        those without sprites become Mesh parts. Incomplete sprite profiles no longer reveal missing 3D parts.</p>

      <fieldset class="tuning-group character-arm-placement">
        <legend>3D arm placement</legend>
        <div class="character-arm-forward-control"></div>
        <button type="button" class="button character-arm-forward-reset">Reset arm forward distance</button>
        <p class="appearance-format">Moves the hand and hammer plane toward the camera, measured from the
          configured chest front. The default is ${DEFAULT_ARM_FORWARD_DISTANCE} m.
          This is visual only: the hammer still draws on top and gameplay physics stay unchanged.
          Save the character profile to keep it.</p>
        <p class="appearance-format character-arm-forward-inactive" hidden>Applies to Mesh parts and Avatar.
          The saved value is retained in 2D mode, which keeps its authored sprite depths.</p>
      </fieldset>

      <section class="character-example" aria-labelledby="character-avatar-heading">
        <h4 id="character-avatar-heading">Connected upper-body avatar</h4>
        <p class="appearance-format">A built-in skinned model with joined shoulders, arms, neck and
          head, rather than separate rigid body parts. Bone weights bend the skin at shoulders, elbows and wrists.
          The existing grip targets drive its hands; the pot is not part of the avatar.</p>
        <button type="button" class="button character-use-avatar">Use Avatar</button>
        <p class="appearance-format">No download or third-party model license is needed. The avatar ships with
          the game and is selected by exported profiles. Import your own skinned GLB below to replace its mesh;
          imported animation clips are not played.</p>
      </section>

      <section class="character-example character-model" aria-labelledby="character-model-heading">
        <h4 id="character-model-heading">Your skinned avatar (GLB)</h4>
        <p class="appearance-format">Replace the built-in avatar mesh with a rigged GLB. Map eight of its skin
          joints to the avatar's body, head, upper arms, forearms and hands. The existing arm IK, grips, head gaze
          and arm forward distance drive them; arm lengths come from the GLB bind pose. Unmapped joints, such as
          spine, neck, fingers and legs, follow their nearest mapped ancestor.</p>
        <p class="appearance-format">Left and right are screen sides. The character faces the camera, so a rig's
          anatomical right arm drives the left joints. Mixamo-style names are mapped automatically.</p>
        <label class="appearance-label" for="character-avatar-file">Skinned avatar GLB</label>
        <input id="character-avatar-file" type="file" accept=".glb,model/gltf-binary" />
        <p class="appearance-format">Self-contained GLB 2.0 with one armature, up to
          ${CHARACTER_MODEL_LIMITS.bytes / 1024 ** 2} MiB, at most 4 weights per vertex, normalized.</p>
        <p class="appearance-format character-avatar-status" role="status" aria-live="polite"></p>
        <fieldset class="tuning-group character-bone-map" hidden>
          <legend>Bone map</legend>
          <div class="character-bone-grid"></div>
          <p class="character-bone-issue" role="alert" aria-atomic="true" hidden></p>
        </fieldset>
        <details class="character-unmapped" hidden>
          <summary class="character-unmapped-summary"></summary>
          <ul class="character-unmapped-list"></ul>
        </details>
        <div class="character-action-row">
          <button type="button" class="button character-avatar-discard" hidden>Discard bone map changes</button>
          <button type="button" class="button character-avatar-remove">Use built-in avatar mesh</button>
        </div>
      </section>

      <section class="character-example character-hammer" aria-labelledby="character-hammer-heading">
        <h4 id="character-hammer-heading">One-model hammer (GLB)</h4>
        <p class="appearance-format">Replace the stretched shaft and separate head with one rigid model, in every
          character type. Model it with its origin at the butt of the handle, the handle along +X, in metres.
          The physical head sits at x = ${metres(RIG.handleLength)}; its collision block spans
          x ${metres(RIG.handleLength - HEAD_HALF_LENGTH)} to ${metres(RIG.handleLength + HEAD_HALF_LENGTH)} and
          y -${metres(HEAD_HALF_HEIGHT)} to ${metres(HEAD_HALF_HEIGHT)}. Length, reach, grips and contacts stay physical.</p>
        <label class="appearance-label" for="character-hammer-file">Hammer GLB</label>
        <input id="character-hammer-file" type="file" accept=".glb,model/gltf-binary" />
        <p class="appearance-format character-hammer-status" role="status" aria-live="polite"></p>
        <button type="button" class="button character-hammer-remove">Use two-part hammer</button>
      </section>

      <fieldset class="tuning-group character-shading">
        <legend>Avatar shading</legend>
        <div class="character-shading-modes" role="radiogroup" aria-label="Shading mode">
          <label><input type="radio" name="character-shading-mode" value="pbr" /> PBR</label>
          <label><input type="radio" name="character-shading-mode" value="cel" /> Cel</label>
        </div>
        <div class="character-cel-bands"></div>
        <label class="character-outline-toggle"><input type="checkbox" id="character-outline-enabled" /> Outline</label>
        <label class="appearance-label" for="character-outline-color">Outline colour</label>
        <input id="character-outline-color" type="color" />
        <div class="character-outline-width"></div>
        <p class="appearance-format">Styles Avatar mode: the connected avatar and its separate pot and hammer.
          Flip between PBR and cel to compare the same model live; cel materials are built once and reused.
          Save keeps the choice.</p>
        <p class="appearance-format character-shading-inactive" hidden>Applies in Avatar mode. Other character
          types keep their own materials.</p>
      </fieldset>

      <section class="character-rig-summary" aria-labelledby="character-rig-heading">
        <h4 id="character-rig-heading">Authored sprite rig</h4>
        <p class="character-rig-counts"></p>
        <p class="appearance-format character-rig-detail"></p>
        <p class="appearance-format">Use Sprites for anchor-bound PNG cutouts, custom 2D bones, weighted skins,
          poses, animation, IK and optional hair. This authored 2D rig is separate from the avatar's
          3D skeleton. Appearance imports individual rigid GLB parts; import a whole skinned avatar above.</p>
        <p class="appearance-format">A single head image can tilt, not invent new face views. Direction-tagged
          head images use the same facing choice as the rest of the sprites. Shared torso/IK bindings are
          never rotated automatically; Directional Presentation reports heads needing a dedicated binding.</p>
      </section>

      <section class="character-example" aria-labelledby="character-example-heading">
        <h4 id="character-example-heading">Meet Paper Climber</h4>
        <p class="appearance-format">A complete custom cutout character: pot, jacket, helmet, both arms,
          gloves and hammer. Shared PNGs cover all 13 visual slots; eight custom 2D bones and two
          grip-target IK chains drive the arms. Eight custom helmet views follow aim with automatic neck tilt.
          Previously saved single-helmet examples keep their artwork and gain tilt without reloading.</p>
        <button type="button" class="button character-load-example">Load complete 2D example</button>
        <p class="appearance-format">Loads a new 2D draft, not a save. Revert restores your last saved profile
          until you choose Save. Artwork is generated only when you load this example.</p>
        <p class="character-example-error" role="alert" aria-atomic="true" hidden></p>
      </section>

      <div class="appearance-state character-state" role="status" aria-live="polite" aria-atomic="true">
        <p class="character-status"></p>
      </div>
      <fieldset class="tuning-group character-files">
        <legend>Whole character / sprite profile</legend>
        <div class="character-action-row">
          <button type="button" class="button character-import">Import profile JSON</button>
          <button type="button" class="button character-export">Export profile JSON</button>
        </div>
        <p class="appearance-format">Includes the character type, 3D arm forward distance, sprite layout, 2D skeleton, directional settings,
          embedded PNGs, the imported avatar and hammer GLBs, bone map and shading. Public image URLs remain
          references. Import limit: ${Math.floor(SPRITE_FILE_BYTES / 1024 ** 2)} MiB.</p>
      </fieldset>
      <p class="appearance-format character-external-warning" hidden>This profile references external images.
        Export preserves their URLs. Never use links containing credentials or private/internal addresses.</p>
      <p class="appearance-format">Appearance's per-part GLB imports and their alignment stay browser-local;
        they are not bundled with profile JSON. Avatar and hammer GLBs imported here are part of the profile.
        The built-in avatar needs no embedded model file. Exported profiles can be used as game sprite data.</p>
    </div>
    <footer class="workshop-footer character-footer">
      <div class="character-action-row">
        <button type="button" class="button button-primary character-save">Save character profile</button>
        <button type="button" class="button character-revert">Revert character profile</button>
      </div>
      <p>These actions apply to the whole character / sprite profile, not just the type.
        Only Save writes this profile to browser storage.</p>
    </footer>
  `;

  const typeSelect = element<HTMLSelectElement>(root, '#character-rigging-type');
  const technology = element<HTMLParagraphElement>(root, '#character-technology');
  const counts = element<HTMLParagraphElement>(root, '.character-rig-counts');
  const detail = element<HTMLParagraphElement>(root, '.character-rig-detail');
  const exampleButton = element<HTMLButtonElement>(root, '.character-load-example');
  const avatarButton = element<HTMLButtonElement>(root, '.character-use-avatar');
  const exampleError = element<HTMLParagraphElement>(root, '.character-example-error');
  const statusBox = element<HTMLDivElement>(root, '.character-state');
  const status = element<HTMLParagraphElement>(root, '.character-status');
  const importButton = element<HTMLButtonElement>(root, '.character-import');
  const exportButton = element<HTMLButtonElement>(root, '.character-export');
  const saveButton = element<HTMLButtonElement>(root, '.character-save');
  const revertButton = element<HTMLButtonElement>(root, '.character-revert');
  const externalWarning = element<HTMLParagraphElement>(root, '.character-external-warning');
  const forwardReset = element<HTMLButtonElement>(root, '.character-arm-forward-reset');
  const forwardInactive = element<HTMLParagraphElement>(root, '.character-arm-forward-inactive');
  const forward = createRangeControl({
    ...ARM_FORWARD_DISTANCE_LIMITS, label: 'Arm forward distance', unit: 'm',
    description: 'Distance between the configured chest front and both hand/hammer grip targets. Applies to the two 3D character modes.',
  }, {
    id: 'character-arm-forward-distance', name: 'armForwardDistance', signal: events.signal,
    onInput: value => { if (!options.state.setArmForwardDistance(value)) render(); },
  });
  element(root, '.character-arm-forward-control').append(forward.row);
  forwardReset.addEventListener('click', () => { options.state.setArmForwardDistance(DEFAULT_ARM_FORWARD_DISTANCE); }, listen);

  const avatarFile = element<HTMLInputElement>(root, '#character-avatar-file');
  const avatarStatus = element<HTMLParagraphElement>(root, '.character-avatar-status');
  const boneMap = element<HTMLFieldSetElement>(root, '.character-bone-map');
  const boneIssue = element<HTMLParagraphElement>(root, '.character-bone-issue');
  const unmapped = element<HTMLDetailsElement>(root, '.character-unmapped');
  const unmappedSummary = element<HTMLElement>(root, '.character-unmapped-summary');
  const unmappedList = element<HTMLUListElement>(root, '.character-unmapped-list');
  const avatarDiscard = element<HTMLButtonElement>(root, '.character-avatar-discard');
  const avatarRemove = element<HTMLButtonElement>(root, '.character-avatar-remove');
  const hammerFile = element<HTMLInputElement>(root, '#character-hammer-file');
  const hammerStatus = element<HTMLParagraphElement>(root, '.character-hammer-status');
  const hammerRemove = element<HTMLButtonElement>(root, '.character-hammer-remove');
  const shadingModes = Array.from(root.querySelectorAll<HTMLInputElement>('input[name="character-shading-mode"]'));
  const outlineEnabled = element<HTMLInputElement>(root, '#character-outline-enabled');
  const outlineColor = element<HTMLInputElement>(root, '#character-outline-color');
  const shadingInactive = element<HTMLParagraphElement>(root, '.character-shading-inactive');
  const boneSelects = new Map<AvatarJointId, HTMLSelectElement>();
  let describedJoints: readonly string[] | null = null;
  let lastOutline: CelOutline = DEFAULT_CEL_OUTLINE;
  for (const joint of AVATAR_JOINT_IDS) {
    const label = document.createElement('label');
    label.className = 'appearance-label';
    label.htmlFor = `character-bone-${joint}`;
    label.textContent = JOINT_LABELS[joint];
    const select = document.createElement('select');
    select.id = `character-bone-${joint}`;
    select.name = `bone-${joint}`;
    select.dataset.joint = joint;
    select.addEventListener('change', () => { void options.state.setAvatarBone(joint, select.value === '' ? null : select.value); }, listen);
    element(root, '.character-bone-grid').append(label, select);
    boneSelects.set(joint, select);
  }
  const editShading = (change: Partial<CharacterShading>): void => {
    const current = options.state.snapshot().shading;
    if (!options.state.setShading({ ...current, ...change })) render();
  };
  const bands = createRangeControl({
    ...SHADING_LIMITS.bands, label: 'Cel bands', unit: '',
    description: 'Number of stepped light bands in cel shading.',
  }, {
    id: 'character-cel-bands', name: 'celBands', signal: events.signal,
    onInput: value => editShading({ bands: value }),
  });
  element(root, '.character-cel-bands').append(bands.row);
  const outlineWidth = createRangeControl({
    ...SHADING_LIMITS.outlineWidth, label: 'Outline width', unit: 'm',
    description: 'World-space width of the cel outline around the avatar, pot and hammer.',
  }, {
    id: 'character-outline-width', name: 'outlineWidth', signal: events.signal,
    onInput: value => editShading({ outline: { ...lastOutline, width: value } }),
  });
  element(root, '.character-outline-width').append(outlineWidth.row);
  for (const input of shadingModes) {
    input.addEventListener('change', () => { if (input.checked) editShading({ mode: input.value as ShadingMode }); }, listen);
  }
  outlineEnabled.addEventListener('change', () => editShading({ outline: outlineEnabled.checked ? lastOutline : null }), listen);
  outlineColor.addEventListener('input', () => editShading({ outline: { ...lastOutline, color: outlineColor.value } }), listen);
  avatarFile.addEventListener('change', () => {
    const file = avatarFile.files?.[0];
    avatarFile.value = '';
    if (file !== undefined) void options.state.importAvatarModel(file);
  }, listen);
  avatarDiscard.addEventListener('click', () => options.state.cancelAvatarImport(), listen);
  avatarRemove.addEventListener('click', () => { void options.state.removeAvatarModel(); }, listen);
  hammerFile.addEventListener('change', () => {
    const file = hammerFile.files?.[0];
    hammerFile.value = '';
    if (file !== undefined) void options.state.importHammerModel(file);
  }, listen);
  hammerRemove.addEventListener('click', () => { void options.state.removeHammerModel(); }, listen);

  for (const type of CHARACTER_RIGGING_TYPES) {
    const option = document.createElement('option');
    option.value = type;
    option.textContent = CHARACTER_TYPES[type].label;
    typeSelect.append(option);
  }
  typeSelect.addEventListener('change', () => {
    if (!options.state.setCharacterRiggingType(typeSelect.value)) render();
  }, listen);
  avatarButton.addEventListener('click', () => { options.state.setCharacterRiggingType('avatar-3d'); }, listen);
  saveButton.addEventListener('click', options.actions.save, listen);
  revertButton.addEventListener('click', options.actions.revert, listen);
  importButton.addEventListener('click', options.actions.importDocument, listen);
  exportButton.addEventListener('click', options.actions.exportDocument, listen);
  exampleButton.addEventListener('click', () => {
    const snapshot = options.state.snapshot();
    if (snapshot.restoring || snapshot.busy) return;
    if ((snapshot.hasContent || snapshot.dirty) && !window.confirm(
      'Replace the current character / sprite draft with Paper Climber? Unsaved edits will be discarded. ' +
      (snapshot.saved === null ? 'No saved profile is available to Revert to; export first to keep this draft.' :
        'Your saved profile stays untouched and available through Revert until you choose Save.'),
    )) return;
    exampleError.hidden = true;
    setText(exampleError, '');
    try {
      void options.state.importDocument(new File(
        [JSON.stringify(createSpriteCharacterExample())],
        'paper-climber.sprites.json',
        { type: 'application/json' },
      ));
    } catch (error) {
      if (!(error instanceof SpriteError)) throw error;
      const message = `Could not create Paper Climber: ${error.message} Your current draft is unchanged.`;
      setText(exampleError, message);
      exampleError.hidden = false;
      options.onNotice(message, 'error');
    }
  }, listen);

  function render(): void {
    if (disposed) return;
    const snapshot = options.state.snapshot();
    const profile = snapshot.document;
    const disabled = snapshot.restoring || snapshot.busy;
    typeSelect.disabled = disabled;
    typeSelect.value = profile.characterRiggingType;
    const forwardDisabled = disabled || profile.characterRiggingType === 'sprite-2d';
    forward.setValue(profile.armForwardDistance, { disabled: forwardDisabled });
    forwardReset.disabled = forwardDisabled || profile.armForwardDistance === DEFAULT_ARM_FORWARD_DISTANCE;
    forwardInactive.hidden = profile.characterRiggingType !== 'sprite-2d';
    exampleButton.disabled = disabled;
    avatarButton.disabled = disabled || profile.characterRiggingType === 'avatar-3d';
    importButton.disabled = disabled;
    exportButton.disabled = disabled || !snapshot.hasContent;
    saveButton.disabled = disabled || !snapshot.dirty;
    revertButton.disabled = disabled || !snapshot.dirty || snapshot.saved === null;
    externalWarning.hidden = !snapshot.externalSources;
    setText(technology, CHARACTER_TYPES[profile.characterRiggingType].description);
    renderModels(snapshot, disabled);

    if (profile !== describedDocument) {
      let rigid = 0;
      let weighted = 0;
      for (const layer of profile.layers) {
        if (layer.skin !== null) weighted += 1;
        else if (layer.bone !== null) rigid += 1;
      }
      const bones = profile.skeleton?.bones.length ?? 0;
      const ik = profile.skeleton?.ik.length ?? 0;
      setText(counts, `${profile.layers.length} layers / ${bones} bones / ${ik} IK constraints`);
      setText(detail, profile.skeleton === null ?
        'No custom 2D skeleton. Unbound PNG cutouts follow their original visual anchors; adding a PNG does not create a bone rig.' :
        `${rigid} rigid bone-bound sprites, ${weighted} weighted skins, ${profile.layers.length - rigid - weighted} unbound cutouts. ` +
        'This is a custom 2D skeleton, not a 3D rig. Bones move bound sprites; unbound cutouts keep following their original anchors.');
      describedDocument = profile;
      exampleError.hidden = true;
      setText(exampleError, '');
    }
    if (disabled) exampleError.hidden = true;
    const message = snapshot.restoring ? 'Restoring the saved character / sprite profile...' :
      snapshot.busy ? 'Working on the character / sprite profile...' :
      snapshot.error !== null ? snapshot.error :
      snapshot.dirty ? 'Unsaved character profile changes. Save to keep them; Revert restores your last save.' :
      snapshot.hasContent ? 'Character / sprite profile saved on this device.' :
      'Built-in 3D character. No sprite artwork authored yet.';
    setText(status, message);
    statusBox.dataset.kind = disabled ? 'busy' : snapshot.error !== null ? 'error' : snapshot.dirty ? 'draft' : 'ready';
    if (snapshot.modelIssue === null) delete statusBox.dataset.code;
    else statusBox.dataset.code = snapshot.modelIssue.code;
  }

  function renderModels(snapshot: ReturnType<SpriteEditorState['snapshot']>, disabled: boolean): void {
    const avatar = snapshot.avatarModel;
    avatarFile.disabled = disabled;
    setText(avatarStatus, avatar === null ? 'Using the built-in avatar mesh.' :
      avatar.pending ? `"${avatar.name}" is not applied: complete its bone map below.` :
      `Using "${avatar.name}" as the avatar${avatar.joints === null ? '.' :
        `: ${avatar.joints.length} skin joints, ${avatar.unmapped.length} unmapped.`}`);
    boneMap.hidden = avatar === null;
    const joints = avatar?.joints ?? null;
    if (joints !== describedJoints) {
      describedJoints = joints;
      for (const select of boneSelects.values()) {
        const choices = ['', ...joints ?? []];
        select.replaceChildren(...choices.map(name => {
          const option = document.createElement('option');
          option.value = name;
          option.textContent = name === '' ? 'Choose a joint' : name;
          return option;
        }));
      }
    }
    for (const [joint, select] of boneSelects) {
      const value = avatar?.boneMap[joint] ?? '';
      if (select.value !== value) select.value = value;
      select.disabled = disabled || joints === null;
      const issue = avatar?.issue ?? null;
      select.setAttribute('aria-invalid', String(issue !== null &&
        (issue.joints.includes(joint) || value !== '' && issue.joints.includes(value))));
    }
    const issue = avatar?.issue ?? null;
    boneIssue.hidden = issue === null;
    setText(boneIssue, issue?.message ?? '');
    if (issue === null) delete boneIssue.dataset.code;
    else boneIssue.dataset.code = issue.code;
    const followers = avatar?.unmapped ?? [];
    unmapped.hidden = followers.length === 0;
    setText(unmappedSummary, `${followers.length} unmapped joints follow their nearest mapped ancestor`);
    const text = followers.map(joint => `${joint.name || '(unnamed)'} follows ${
      joint.follows === null ? 'the avatar root' : JOINT_LABELS[joint.follows].toLowerCase()}`);
    if (unmappedList.childElementCount !== text.length ||
      Array.from(unmappedList.children).some((item, index) => item.textContent !== text[index])) {
      unmappedList.replaceChildren(...text.map(line => {
        const item = document.createElement('li');
        item.textContent = line;
        return item;
      }));
    }
    avatarDiscard.hidden = avatar?.pending !== true;
    avatarDiscard.disabled = disabled;
    avatarRemove.disabled = disabled || snapshot.document.avatar === undefined;
    hammerFile.disabled = disabled;
    setText(hammerStatus, snapshot.hammerModel === null ? 'Using the two-part hammer (default).' :
      `Using "${snapshot.hammerModel.name}" as a one-model hammer.`);
    hammerRemove.disabled = disabled || snapshot.hammerModel === null;
    const shading = snapshot.shading;
    if (shading.outline !== null) lastOutline = shading.outline;
    for (const input of shadingModes) {
      input.checked = input.value === shading.mode;
      input.disabled = disabled;
    }
    bands.setValue(shading.bands, { disabled });
    outlineEnabled.checked = shading.outline !== null;
    outlineEnabled.disabled = disabled;
    if (outlineColor.value !== lastOutline.color) outlineColor.value = lastOutline.color;
    outlineColor.disabled = disabled || shading.outline === null;
    outlineWidth.setValue(lastOutline.width, { disabled: disabled || shading.outline === null });
    shadingInactive.hidden = snapshot.document.characterRiggingType === 'avatar-3d';
  }

  options.mount.append(root);
  const unsubscribe = options.state.subscribe(render);
  options.signal.addEventListener('abort', dispose, { ...listen, once: true });

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    unsubscribe();
    events.abort();
    root.remove();
  }

  return { dispose };
}
