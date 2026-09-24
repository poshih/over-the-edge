import { element, setText } from '../dom';
import { CHARACTER_RIGGING_TYPES, SpriteError, SPRITE_LIMITS } from '../sprite-data';
import type { CharacterRiggingType, SpriteDocument } from '../sprite-data';
import type { SpriteEditorState } from './sprite-state';
import { createSpriteCharacterExample } from './sprite-character-example';
import './character-editor.css';

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
    description: 'One connected GPU-skinned upper-body mesh contains the torso, neck, head, arms and hands. Its bones follow the existing arm IK. The pot and hammer stay separate; sprite artwork and separate body-part meshes are hidden.',
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

      <section class="character-example" aria-labelledby="character-avatar-heading">
        <h4 id="character-avatar-heading">Connected upper-body avatar</h4>
        <p class="appearance-format">An original, built-in skinned model with joined shoulders, arms, neck and
          head, rather than separate rigid body parts. Bone weights bend the skin at shoulders, elbows and wrists.
          The existing grip targets drive its hands; the pot is not part of the avatar.</p>
        <button type="button" class="button character-use-avatar">Use built-in Avatar</button>
        <p class="appearance-format">No download or third-party model license is needed. The avatar ships with
          the game and is selected by exported profiles. Whole-avatar GLB import and animation retargeting are
          not part of this built-in rig.</p>
      </section>

      <section class="character-rig-summary" aria-labelledby="character-rig-heading">
        <h4 id="character-rig-heading">Authored sprite rig</h4>
        <p class="character-rig-counts"></p>
        <p class="appearance-format character-rig-detail"></p>
        <p class="appearance-format">Use Sprites for anchor-bound PNG cutouts, custom 2D bones, weighted skins,
          poses, animation, IK and optional hair. This authored 2D rig is separate from the built-in avatar's
          3D skeleton. Appearance imports individual rigid GLB parts, not whole avatar rigs.</p>
        <p class="appearance-format">A single head image can tilt, not invent new face views. Direction-tagged
          head images use the same facing choice as the rest of the sprites. Shared torso/IK bindings are
          never rotated automatically; Directional Presentation reports heads needing a dedicated binding.</p>
      </section>

      <section class="character-example" aria-labelledby="character-example-heading">
        <h4 id="character-example-heading">Meet Paper Climber</h4>
        <p class="appearance-format">An original, complete cutout character: pot, jacket, helmet, both arms,
          gloves and hammer. Shared PNGs cover all 13 visual slots; eight custom 2D bones and two
          grip-target IK chains drive the arms. Eight original helmet views follow aim with automatic neck tilt.
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
        <p class="appearance-format">Includes the character type, sprite layout, 2D skeleton, directional settings
          and embedded PNGs. Public image URLs remain references. Import limit:
          ${Math.floor(SPRITE_LIMITS.documentBytes / 1024 ** 2)} MiB.</p>
      </fieldset>
      <p class="appearance-format character-external-warning" hidden>This profile references external images.
        Export preserves their URLs. Never use links containing credentials or private/internal addresses.</p>
      <p class="appearance-format">GLB imports and their alignment stay separately browser-local in Appearance;
        they are not bundled with profile JSON. The built-in avatar needs no embedded model file.
        Exported PNG artwork can be used as normal game sprite data.</p>
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
    exampleButton.disabled = disabled;
    avatarButton.disabled = disabled || profile.characterRiggingType === 'avatar-3d';
    importButton.disabled = disabled;
    exportButton.disabled = disabled || !snapshot.hasContent;
    saveButton.disabled = disabled || !snapshot.dirty;
    revertButton.disabled = disabled || !snapshot.dirty || snapshot.saved === null;
    externalWarning.hidden = !snapshot.externalSources;
    setText(technology, CHARACTER_TYPES[profile.characterRiggingType].description);

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
