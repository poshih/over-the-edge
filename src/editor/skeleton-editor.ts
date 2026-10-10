import { element, setText } from '../dom';
import { restPose } from '../skeleton-pose';
import {
  FACING_DIRECTIONS,
  SKELETON_LIMITS,
  SkeletonError,
  fixedJointIds,
  isTipAttached,
  validateDirection,
  validateSkin,
} from '../skeleton-data';
import type {
  BonePose,
  FacingDirection,
  SkeletonClip,
  SkeletonDefinition,
  SkeletonPreview,
  SpriteSkin,
} from '../skeleton-data';
import type { SpriteLayer } from '../sprite-data';
import { SpriteError } from '../sprite-data';
import { selectionEntry, selectionIds } from './character-commands';
import type { ProjectCommandInfo } from './document/project-commands';
import type { Selection } from './document/project-document';
import type { SpriteLayerEdit } from './document/visual-contract';
import { createRangeControl } from './range-control';
import type { RangeControl } from './range-control';
import type { SpriteAnchorInput, SpriteEditorSnapshot, SpriteEditorState } from './sprite-state';
import { sectionMarkup } from './workshop-section';
import './skeleton-editor.css';

const DIAGRAM_WIDTH = 240;
const DIAGRAM_HEIGHT = 180;
const JOINT_EPSILON = 1e-6;
const POSITION_STEP = 0.01;
const LENGTH_STEP = 0.01;
const DURATION_STEP = 0.01;
const WEIGHT_STEP = 0.05;
const DEFAULT_BONE_LENGTH = 1;
const DEFAULT_MESH_COLUMNS = 2;
const DEFAULT_MESH_ROWS = 2;
const DEFAULT_HAIR_GRAVITY = 9.81;

type PreviewMode = 'live' | 'direction' | 'clip' | 'frame';
type StatusKind = 'ready' | 'draft' | 'busy' | 'error';
// What a skeleton step selects, named in its selection by kind.
type Target = 'bone' | 'direction' | 'clip' | 'keyframe' | 'ik' | 'hair' | 'collider' | 'vertex';

interface SelectOption {
  readonly value: string;
  readonly label: string;
  readonly disabled?: boolean;
}

interface WeightRowControls {
  readonly bone: HTMLSelectElement;
  readonly weight: HTMLInputElement;
}

type Mutable<T> = T extends object ? { -readonly [Key in keyof T]: Mutable<T[Key]> } : T;
type MutableBonePose = Mutable<BonePose>;
type MutableSkeleton = Mutable<SkeletonDefinition>;

class UiError extends Error {}

function titleCase(text: string): string {
  return text.split('-').map(part => part.charAt(0).toUpperCase() + part.slice(1)).join(' ');
}

function nextId(prefix: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  let index = used.size + 1;
  let candidate = `${prefix}-${index}`;
  while (used.has(candidate)) {
    index += 1;
    candidate = `${prefix}-${index}`;
  }
  return candidate;
}

function clonePose(entries: readonly BonePose[]): MutableBonePose[] {
  return entries.map(entry => ({ ...entry }));
}

function cloneSkeleton(definition: SkeletonDefinition): MutableSkeleton {
  return {
    anchor: definition.anchor,
    bones: definition.bones.map(bone => ({ ...bone })),
    poses: definition.poses.map(entry => ({ direction: entry.direction, pose: clonePose(entry.pose) })),
    clips: definition.clips.map(clip => ({
      ...clip,
      frames: clip.frames.map(frame => ({ time: frame.time, pose: clonePose(frame.pose) })),
    })),
    animation: definition.animation,
    ik: definition.ik.map(entry => ({ ...entry })),
    hair: definition.hair.map(entry => ({ ...entry, bones: [...entry.bones] })),
    colliders: definition.colliders.map(entry => ({ ...entry })),
  };
}

function selectedLayer(snapshot: SpriteEditorSnapshot): SpriteLayer | null {
  return snapshot.document.layers.find(layer => layer.id === snapshot.selectedLayerId) ?? null;
}

function syncSelectOptions(select: HTMLSelectElement, options: readonly SelectOption[]): void {
  const signature = options.map(option => `${option.value}\u0000${option.label}\u0000${option.disabled === true ? '1' : '0'}`).join('\n');
  if (select.dataset.optionsSignature === signature) return;
  select.replaceChildren();
  for (const option of options) {
    const element = document.createElement('option');
    element.value = option.value;
    element.disabled = option.disabled === true;
    element.textContent = option.label;
    select.append(element);
  }
  select.dataset.optionsSignature = signature;
}

function setTextInputValue(input: HTMLInputElement, value: string, force: boolean): void {
  if (!force && document.activeElement === input) return;
  if (input.value !== value) input.value = value;
}

function setNumberInputValue(input: HTMLInputElement, value: number, force: boolean): void {
  if (!force && document.activeElement === input) return;
  const text = String(value);
  if (input.value !== text) input.value = text;
}

function setChecked(input: HTMLInputElement, checked: boolean): void {
  if (input.checked !== checked) input.checked = checked;
}

function readText(input: HTMLInputElement, label: string): string {
  const value = input.value.trim();
  if (value.length === 0) {
    input.focus();
    throw new UiError(`${label} is required.`);
  }
  return value;
}

function readNumber(input: HTMLInputElement, label: string): number {
  if (!Number.isFinite(input.valueAsNumber) || input.validity.rangeUnderflow || input.validity.rangeOverflow || input.validity.badInput) {
    input.reportValidity();
    input.focus();
    throw new UiError(`Enter a valid ${label.toLowerCase()}.`);
  }
  return input.valueAsNumber;
}

function readInteger(input: HTMLInputElement, label: string): number {
  const value = readNumber(input, label);
  if (!Number.isInteger(value)) {
    input.focus();
    throw new UiError(`${label} must be a whole number.`);
  }
  return value;
}

function poseForDirection(definition: SkeletonDefinition, direction: FacingDirection): readonly BonePose[] {
  return definition.poses.find(entry => entry.direction === direction)?.pose ?? [];
}

function poseForBone(entries: readonly BonePose[], boneId: string | null): BonePose | null {
  if (boneId === null) return null;
  return entries.find(entry => entry.bone === boneId) ?? null;
}

function upsertPose(entries: readonly BonePose[], bone: string, value: BonePose | null): BonePose[] {
  const filtered = entries.filter(entry => entry.bone !== bone).map(entry => ({ ...entry }));
  if (value !== null) filtered.push({ ...value });
  return filtered;
}

function sortDirectionalPoses(entries: MutableSkeleton['poses']): MutableSkeleton['poses'] {
  const order = new Map(FACING_DIRECTIONS.map((direction, index) => [direction, index]));
  return [...entries].sort((left, right) => order.get(left.direction)! - order.get(right.direction)!);
}

function pathFromRootToTip(definition: SkeletonDefinition, root: string, tip: string): readonly string[] | null {
  const chain: string[] = [];
  const byId = new Map(definition.bones.map(bone => [bone.id, bone]));
  let current: string | null = tip;
  while (current !== null) {
    chain.push(current);
    if (current === root) return chain.reverse();
    current = byId.get(current)?.parent ?? null;
  }
  return null;
}

function poseEditorValue(pose: BonePose | null, key: keyof Omit<BonePose, 'bone'>): number {
  if (pose === null) return 0;
  return pose[key];
}

function buildBoneOptions(definition: SkeletonDefinition | null, blankLabel: string): readonly SelectOption[] {
  const options: SelectOption[] = [{ value: '', label: blankLabel }];
  if (definition === null) return options;
  for (const bone of definition.bones) options.push({ value: bone.id, label: `${bone.name} (${bone.id})` });
  return options;
}

function boneDeleteProblem(snapshot: SpriteEditorSnapshot, definition: SkeletonDefinition, boneId: string): string | null {
  if (snapshot.document.presentation?.bones.includes(boneId)) {
    return 'Remove this bone from Directional Presentation before deleting it.';
  }
  if (definition.bones.length <= 1) return 'A skeleton needs at least one bone. Delete the whole skeleton instead.';
  if (definition.bones.some(bone => bone.parent === boneId)) {
    return 'Delete or reparent child bones before deleting this bone.';
  }
  if (snapshot.document.layers.some(layer => layer.bone === boneId)) {
    return 'Clear rigid sprite bindings that reference this bone before deleting it.';
  }
  if (snapshot.document.layers.some(layer => layer.skin?.weights.some(weights => weights.some(weight => weight.bone === boneId)) === true)) {
    return 'Clear or reweight mesh vertices that reference this bone before deleting it.';
  }
  if (definition.poses.some(entry => entry.pose.some(pose => pose.bone === boneId))) {
    return 'Remove directional pose offsets that reference this bone before deleting it.';
  }
  if (definition.clips.some(clip => clip.frames.some(frame => frame.pose.some(pose => pose.bone === boneId)))) {
    return 'Remove animation keyframe offsets that reference this bone before deleting it.';
  }
  if (definition.ik.some(chain => [chain.upper, chain.lower, chain.hand].includes(boneId))) {
    return 'Delete IK constraints that reference this bone before deleting it.';
  }
  if (definition.hair.some(chain => chain.bones.includes(boneId))) {
    return 'Delete hair chains that reference this bone before deleting it.';
  }
  if (definition.colliders.some(collider => collider.bone === boneId)) {
    return 'Delete colliders that reference this bone before deleting it.';
  }
  return null;
}

function skeletonDeleteProblem(snapshot: SpriteEditorSnapshot): string | null {
  if (snapshot.document.presentation !== null && snapshot.document.presentation.bones.length > 0) {
    return 'Clear controlled bones in Directional Presentation before deleting the skeleton.';
  }
  if (snapshot.document.layers.some(layer => layer.bone !== null || layer.skin !== null)) {
    return 'Clear sprite bone bindings and meshes before deleting the skeleton.';
  }
  return null;
}

function layerOutline(layer: SpriteLayer, definition: SkeletonDefinition): readonly { x: number; y: number }[] {
  const halfWidth = layer.width / 2;
  const halfHeight = layer.height / 2;
  const local = [
    { x: -halfWidth, y: halfHeight },
    { x: halfWidth, y: halfHeight },
    { x: halfWidth, y: -halfHeight },
    { x: -halfWidth, y: -halfHeight },
  ];
  let originX = layer.offset.x;
  let originY = layer.offset.y;
  let angle = layer.rotation * Math.PI / 180;
  if (layer.bone !== null) {
    const pose = restPose(definition).find(bone => bone.id === layer.bone);
    if (pose !== undefined) {
      const x = layer.offset.x;
      const y = layer.offset.y;
      originX = pose.x + x * Math.cos(pose.angle) - y * Math.sin(pose.angle);
      originY = pose.y + x * Math.sin(pose.angle) + y * Math.cos(pose.angle);
      angle += pose.angle;
    }
  }
  return local.map(point => ({
    x: originX + point.x * Math.cos(angle) - point.y * Math.sin(angle),
    y: originY + point.x * Math.sin(angle) + point.y * Math.cos(angle),
  }));
}

function frameLabel(frame: SkeletonClip['frames'][number], index: number): string {
  return `${index + 1}. ${frame.time.toFixed(2)} s`;
}

export function createSkeletonEditor(options: {
  mount: HTMLElement;
  state: SpriteEditorState;
  anchors: readonly SpriteAnchorInput[];
  targetIds: readonly string[];
  signal: AbortSignal;
}): { dispose(): void } {
  const { state } = options;
  const { commands } = state;
  const events = new AbortController();
  const listen = { signal: events.signal };
  let disposed = false;
  let localMessage: { text: string; kind: StatusKind } | null = null;
  let selectedBoneId: string | null = null;
  let selectedDirection: FacingDirection = FACING_DIRECTIONS[0];
  let selectedClipId: string | null = null;
  let previewMode: PreviewMode = 'live';
  let previewConstraints: 'enabled' | 'disabled' = 'enabled';
  let selectedIkId: string | null = null;
  let selectedHairId: string | null = null;
  let selectedColliderId: string | null = null;
  let selectedVertexIndex = 0;
  const selectedFrameIndexByClip = new Map<string, number>();
  let meshBoneSelection: Set<string> | null = null;

  const root = document.createElement('section');
  root.className = 'skeleton-editor';
  root.innerHTML = `
    <section class="sprite-intro skeleton-intro">
      <p>Create a compact bone rig, layer bindings, additive poses, clip animation and optional constraints.</p>
      <p class="appearance-format">Saved bone rotations use degrees. Meshes bind in skeleton-root space. Legacy layers stay anchor-driven until you bind them.</p>
    </section>
    <div class="appearance-state skeleton-state" role="status" aria-live="polite" aria-atomic="true">
      <p class="skeleton-status"></p>
    </div>

    ${sectionMarkup({ id: 'sprites-skeleton-rig', title: 'Skeleton', hint: 'Create, delete and root anchor', open: true }, `
    <fieldset class="tuning-group skeleton-definition-group">
      <legend class="visually-hidden">Skeleton</legend>
      <div class="skeleton-action-row">
        <button type="button" class="button skeleton-create">Create skeleton</button>
        <button type="button" class="button skeleton-delete">Delete skeleton</button>
      </div>
      <label class="appearance-label" for="skeleton-anchor">Root anchor</label>
      <select id="skeleton-anchor"></select>
    </fieldset>
    `)}

    ${sectionMarkup({ id: 'sprites-skeleton-bones', title: 'Bones', hint: 'Hierarchy, diagram and bind pose' }, `
    <fieldset class="tuning-group skeleton-bones-group">
      <legend class="visually-hidden">Bones</legend>
      <label class="appearance-label" for="skeleton-bone">Selected bone</label>
      <select id="skeleton-bone"></select>
      <div class="skeleton-action-row">
        <button type="button" class="button skeleton-add-root">Add root bone</button>
        <button type="button" class="button skeleton-add-child">Add child bone</button>
      </div>
      <div class="skeleton-diagram-panel">
        <div class="skeleton-diagram-shell">
          <svg class="skeleton-diagram" viewBox="0 0 ${DIAGRAM_WIDTH} ${DIAGRAM_HEIGHT}" role="img" aria-label="Skeleton bone diagram"></svg>
        </div>
        <p class="appearance-format skeleton-diagram-hint">Bind-pose diagram. Click a bone here or in the picker above to edit it. Animation previews appear in the game.</p>
      </div>
      <div class="skeleton-meta-row">
        <span class="skeleton-token-label">Bone ID</span>
        <code class="skeleton-token skeleton-bone-id">—</code>
      </div>
      <div class="skeleton-form-grid">
        <div class="skeleton-form-field">
          <label class="appearance-label" for="skeleton-bone-name">Name</label>
          <input id="skeleton-bone-name" type="text" maxlength="${SKELETON_LIMITS.name}" />
        </div>
        <div class="skeleton-form-field">
          <label class="appearance-label" for="skeleton-bone-parent">Parent</label>
          <select id="skeleton-bone-parent"></select>
        </div>
        <div class="skeleton-form-field">
          <label class="appearance-label" for="skeleton-bone-x">Local X</label>
          <input id="skeleton-bone-x" type="number" min="${-SKELETON_LIMITS.position}" max="${SKELETON_LIMITS.position}" step="${POSITION_STEP}" />
        </div>
        <div class="skeleton-form-field">
          <label class="appearance-label" for="skeleton-bone-y">Local Y</label>
          <input id="skeleton-bone-y" type="number" min="${-SKELETON_LIMITS.position}" max="${SKELETON_LIMITS.position}" step="${POSITION_STEP}" />
        </div>
        <div class="skeleton-form-field">
          <label class="appearance-label" for="skeleton-bone-length">Length</label>
          <input id="skeleton-bone-length" type="number" min="0.01" max="${SKELETON_LIMITS.length}" step="${LENGTH_STEP}" />
        </div>
        <div class="skeleton-form-field">
          <label class="appearance-label" for="skeleton-bone-rotation">Rotation</label>
          <input id="skeleton-bone-rotation" type="number" min="${-SKELETON_LIMITS.rotation}" max="${SKELETON_LIMITS.rotation}" step="1" />
        </div>
      </div>
      <div class="skeleton-action-row">
        <button type="button" class="button skeleton-apply-bone">Apply bone edits</button>
        <button type="button" class="button skeleton-delete-bone">Delete bone</button>
      </div>
      <p class="appearance-format">Child bones for IK or hair must begin at the parent tip. Length edits keep already tip-attached children on the new tip.</p>
    </fieldset>
    `)}

    ${sectionMarkup({ id: 'sprites-skeleton-layer', title: 'Selected layer rigging', hint: 'Bone binding, tiling and mesh weights' }, `
    <fieldset class="tuning-group skeleton-layer-group">
      <legend class="visually-hidden">Selected layer rigging</legend>
      <p class="skeleton-layer-label"></p>
      <label class="appearance-label" for="skeleton-layer-bone">Rigid bone binding</label>
      <select id="skeleton-layer-bone"></select>
      <div class="skeleton-action-row skeleton-action-row-tight">
        <button type="button" class="button skeleton-apply-rigid">Apply rigid binding</button>
      </div>
      <div class="skeleton-toggle-row">
        <label class="skeleton-toggle" for="skeleton-layer-tiled">
          <input id="skeleton-layer-tiled" type="checkbox" />
          <span>Tileable shaft mode</span>
        </label>
        <div>
          <label class="appearance-label" for="skeleton-layer-tile-length">Tile length</label>
          <input id="skeleton-layer-tile-length" type="number" min="${0.01}" max="${SKELETON_LIMITS.length}" step="${LENGTH_STEP}" />
        </div>
        <button type="button" class="button skeleton-apply-tile">Apply tile</button>
      </div>
      <p class="appearance-format">World units per horizontal texture repeat. Shaft replacements follow the fixed-length physical handle; tiling never changes reach or grip positions.</p>
      <div class="skeleton-subsection">
        <p class="appearance-label" id="skeleton-directions-label">Visible directions</p>
        <div class="skeleton-direction-grid" role="group" aria-labelledby="skeleton-directions-label"></div>
        <p class="appearance-format skeleton-flipbook-note" hidden>This aim flipbook stays visible in every
          direction and cannot tile or bind a mesh. Choose Use single image in Sprites first to change that.</p>
      </div>
      <div class="skeleton-subsection">
        <h4>Mesh binding</h4>
        <div class="skeleton-inline-grid skeleton-inline-grid-2">
          <div>
            <label class="appearance-label" for="skeleton-mesh-columns">Columns</label>
            <input id="skeleton-mesh-columns" type="number" min="1" max="${SKELETON_LIMITS.grid}" step="1" />
          </div>
          <div>
            <label class="appearance-label" for="skeleton-mesh-rows">Rows</label>
            <input id="skeleton-mesh-rows" type="number" min="1" max="${SKELETON_LIMITS.grid}" step="1" />
          </div>
        </div>
        <label class="appearance-label" for="skeleton-mesh-bones">Influencing bones</label>
        <select id="skeleton-mesh-bones" multiple size="6"></select>
        <div class="skeleton-action-row">
          <button type="button" class="button skeleton-bind-mesh">Bind mesh</button>
          <button type="button" class="button skeleton-switch-rigid">Switch back to rigid</button>
        </div>
        <p class="appearance-format">Mesh binding clears single-bone and tile settings. Auto-weights start from the chosen bones and can be refined per vertex below.</p>
      </div>
      <div class="skeleton-subsection skeleton-weights-subsection">
        <h4>Vertex weights</h4>
        <label class="appearance-label" for="skeleton-weight-vertex">Vertex</label>
        <select id="skeleton-weight-vertex"></select>
        <div class="skeleton-weight-rows"></div>
        <div class="skeleton-action-row skeleton-action-row-tight">
          <button type="button" class="button skeleton-apply-weights">Apply vertex weights</button>
        </div>
        <p class="appearance-format">Each vertex needs 1-4 influences totaling exactly 1.</p>
      </div>
    </fieldset>
    `)}

    ${sectionMarkup({ id: 'sprites-skeleton-pose', title: 'Directional pose', hint: 'Per-direction bone offsets' }, `
    <fieldset class="tuning-group skeleton-pose-group">
      <legend class="visually-hidden">Directional pose</legend>
      <label class="appearance-label" for="skeleton-direction">Direction</label>
      <select id="skeleton-direction"></select>
      <p class="skeleton-selection-note"></p>
      <div class="skeleton-inline-grid skeleton-inline-grid-3">
        <div>
          <label class="appearance-label" for="skeleton-pose-x">Offset X</label>
          <input id="skeleton-pose-x" type="number" min="${-SKELETON_LIMITS.position}" max="${SKELETON_LIMITS.position}" step="${POSITION_STEP}" />
        </div>
        <div>
          <label class="appearance-label" for="skeleton-pose-y">Offset Y</label>
          <input id="skeleton-pose-y" type="number" min="${-SKELETON_LIMITS.position}" max="${SKELETON_LIMITS.position}" step="${POSITION_STEP}" />
        </div>
        <div>
          <label class="appearance-label" for="skeleton-pose-rotation">Rotation</label>
          <input id="skeleton-pose-rotation" type="number" min="${-SKELETON_LIMITS.rotation}" max="${SKELETON_LIMITS.rotation}" step="1" />
        </div>
      </div>
      <div class="skeleton-action-row">
        <button type="button" class="button skeleton-apply-pose">Apply directional offset</button>
        <button type="button" class="button skeleton-clear-pose">Clear directional offset</button>
      </div>
    </fieldset>
    `)}

    ${sectionMarkup({ id: 'sprites-skeleton-animation', title: 'Animation clips', hint: 'Keyframes and preview' }, `
    <fieldset class="tuning-group skeleton-animation-group">
      <legend class="visually-hidden">Animation clips</legend>
      <label class="appearance-label" for="skeleton-default-clip">Default live clip</label>
      <select id="skeleton-default-clip"></select>
      <label class="appearance-label" for="skeleton-clip">Selected clip</label>
      <select id="skeleton-clip"></select>
      <div class="skeleton-meta-row">
        <span class="skeleton-token-label">Clip ID</span>
        <code class="skeleton-token skeleton-clip-id">—</code>
      </div>
      <div class="skeleton-inline-grid skeleton-inline-grid-2">
        <div>
          <label class="appearance-label" for="skeleton-clip-name">Clip name</label>
          <input id="skeleton-clip-name" type="text" maxlength="${SKELETON_LIMITS.name}" />
        </div>
        <div>
          <label class="appearance-label" for="skeleton-clip-duration">Duration</label>
          <input id="skeleton-clip-duration" type="number" min="0.05" max="${SKELETON_LIMITS.duration}" step="${DURATION_STEP}" />
        </div>
      </div>
      <label class="skeleton-toggle" for="skeleton-clip-loop">
        <input id="skeleton-clip-loop" type="checkbox" />
        <span>Loop clip</span>
      </label>
      <div class="skeleton-action-row">
        <button type="button" class="button skeleton-add-clip">Add clip</button>
        <button type="button" class="button skeleton-apply-clip">Apply clip settings</button>
        <button type="button" class="button skeleton-delete-clip">Delete clip</button>
      </div>
      <label class="appearance-label" for="skeleton-frame">Keyframe</label>
      <select id="skeleton-frame"></select>
      <div class="skeleton-inline-grid skeleton-inline-grid-3">
        <div>
          <label class="appearance-label" for="skeleton-frame-time">Keyframe time</label>
          <input id="skeleton-frame-time" type="number" min="0" max="${SKELETON_LIMITS.duration}" step="${DURATION_STEP}" />
        </div>
        <div>
          <label class="appearance-label" for="skeleton-frame-x">Offset X</label>
          <input id="skeleton-frame-x" type="number" min="${-SKELETON_LIMITS.position}" max="${SKELETON_LIMITS.position}" step="${POSITION_STEP}" />
        </div>
        <div>
          <label class="appearance-label" for="skeleton-frame-y">Offset Y</label>
          <input id="skeleton-frame-y" type="number" min="${-SKELETON_LIMITS.position}" max="${SKELETON_LIMITS.position}" step="${POSITION_STEP}" />
        </div>
      </div>
      <label class="appearance-label" for="skeleton-frame-rotation">Bone rotation</label>
      <input id="skeleton-frame-rotation" type="number" min="${-SKELETON_LIMITS.rotation}" max="${SKELETON_LIMITS.rotation}" step="1" />
      <div class="skeleton-action-row">
        <button type="button" class="button skeleton-add-frame">Add keyframe</button>
        <button type="button" class="button skeleton-replace-frame">Replace keyframe</button>
        <button type="button" class="button skeleton-delete-frame">Delete keyframe</button>
      </div>
      <div class="skeleton-action-row">
        <button type="button" class="button skeleton-apply-frame-pose">Apply bone offset</button>
        <button type="button" class="button skeleton-clear-frame-pose">Clear bone offset</button>
      </div>
      <div class="skeleton-subsection skeleton-preview-subsection">
        <h4>Preview</h4>
        <p class="appearance-format skeleton-preview-unavailable" id="skeleton-preview-help" hidden>
          Sprite previews are disabled in Mesh parts and Avatar modes. Select 2D sprites in Character to preview this rig.
          Bones, bindings and poses remain editable.
        </p>
        <label class="appearance-label" for="skeleton-preview-mode">Preview mode</label>
        <select id="skeleton-preview-mode" aria-describedby="skeleton-preview-help">
          <option value="live">Live game animation</option>
          <option value="direction">Directional pose</option>
          <option value="clip">Scrub selected clip</option>
          <option value="frame">Selected keyframe pose</option>
        </select>
        <label class="appearance-label" for="skeleton-preview-constraints">Constraint preview</label>
        <select id="skeleton-preview-constraints">
          <option value="enabled">Constraints enabled</option>
          <option value="disabled">Constraints disabled</option>
        </select>
        <div class="skeleton-preview-range"></div>
        <div class="skeleton-action-row skeleton-action-row-tight">
          <button type="button" class="button skeleton-preview-live">Return to live</button>
        </div>
      </div>
    </fieldset>
    `)}

    ${sectionMarkup({ id: 'sprites-skeleton-ik', title: 'Two-bone IK', hint: 'Hands on the grip targets' }, `
    <fieldset class="tuning-group skeleton-ik-group">
      <legend class="visually-hidden">Two-bone IK</legend>
      <label class="appearance-label" for="skeleton-ik">Constraint</label>
      <select id="skeleton-ik"></select>
      <div class="skeleton-meta-row">
        <span class="skeleton-token-label">IK ID</span>
        <code class="skeleton-token skeleton-ik-id">—</code>
      </div>
      <div class="skeleton-inline-grid skeleton-inline-grid-3">
        <div>
          <label class="appearance-label" for="skeleton-ik-upper">Upper bone</label>
          <select id="skeleton-ik-upper"></select>
        </div>
        <div>
          <label class="appearance-label" for="skeleton-ik-lower">Lower bone</label>
          <select id="skeleton-ik-lower"></select>
        </div>
        <div>
          <label class="appearance-label" for="skeleton-ik-hand">Hand bone</label>
          <select id="skeleton-ik-hand"></select>
        </div>
      </div>
      <label class="appearance-label" for="skeleton-ik-target">Target port</label>
      <select id="skeleton-ik-target"></select>
      <div class="skeleton-inline-grid skeleton-inline-grid-2">
        <div>
          <label class="appearance-label" for="skeleton-ik-bend">Bend</label>
          <select id="skeleton-ik-bend">
            <option value="1">+1</option>
            <option value="-1">-1</option>
          </select>
        </div>
        <div>
          <label class="appearance-label" for="skeleton-ik-mix">Mix</label>
          <input id="skeleton-ik-mix" type="number" min="0" max="1" step="0.05" />
        </div>
      </div>
      <div class="skeleton-inline-grid skeleton-inline-grid-3">
        <div>
          <label class="appearance-label" for="skeleton-ik-offset-x">Grip offset X</label>
          <input id="skeleton-ik-offset-x" type="number" min="${-SKELETON_LIMITS.position}" max="${SKELETON_LIMITS.position}" step="${POSITION_STEP}" />
        </div>
        <div>
          <label class="appearance-label" for="skeleton-ik-offset-y">Grip offset Y</label>
          <input id="skeleton-ik-offset-y" type="number" min="${-SKELETON_LIMITS.position}" max="${SKELETON_LIMITS.position}" step="${POSITION_STEP}" />
        </div>
        <div>
          <label class="appearance-label" for="skeleton-ik-rotation">Wrist rotation</label>
          <input id="skeleton-ik-rotation" type="number" min="${-SKELETON_LIMITS.rotation}" max="${SKELETON_LIMITS.rotation}" step="1" />
        </div>
      </div>
      <div class="skeleton-action-row">
        <button type="button" class="button skeleton-add-ik">Add IK</button>
        <button type="button" class="button skeleton-apply-ik">Apply IK</button>
        <button type="button" class="button skeleton-delete-ik">Delete IK</button>
      </div>
    </fieldset>
    `)}

    ${sectionMarkup({ id: 'sprites-skeleton-hair', title: 'Hair chain', hint: 'Spring-bone secondary motion' }, `
    <fieldset class="tuning-group skeleton-hair-group">
      <legend class="visually-hidden">Hair chain</legend>
      <label class="appearance-label" for="skeleton-hair">Chain</label>
      <select id="skeleton-hair"></select>
      <div class="skeleton-meta-row">
        <span class="skeleton-token-label">Hair ID</span>
        <code class="skeleton-token skeleton-hair-id">—</code>
      </div>
      <div class="skeleton-inline-grid skeleton-inline-grid-2">
        <div>
          <label class="appearance-label" for="skeleton-hair-root">Root bone</label>
          <select id="skeleton-hair-root"></select>
        </div>
        <div>
          <label class="appearance-label" for="skeleton-hair-tip">Tip bone</label>
          <select id="skeleton-hair-tip"></select>
        </div>
      </div>
      <div class="skeleton-inline-grid skeleton-inline-grid-2">
        <div>
          <label class="appearance-label" for="skeleton-hair-stiffness">Stiffness</label>
          <input id="skeleton-hair-stiffness" type="number" min="0" max="1" step="0.05" />
        </div>
        <div>
          <label class="appearance-label" for="skeleton-hair-damping">Damping</label>
          <input id="skeleton-hair-damping" type="number" min="0" max="1" step="0.05" />
        </div>
      </div>
      <div class="skeleton-inline-grid skeleton-inline-grid-2">
        <div>
          <label class="appearance-label" for="skeleton-hair-gravity">Gravity (+down / -up)</label>
          <input id="skeleton-hair-gravity" type="number" min="-50" max="50" step="0.5" />
        </div>
        <div>
          <label class="appearance-label" for="skeleton-hair-radius">Collision radius</label>
          <input id="skeleton-hair-radius" type="number" min="0" max="1" step="0.01" />
        </div>
      </div>
      <p class="skeleton-hair-summary"></p>
      <div class="skeleton-action-row">
        <button type="button" class="button skeleton-add-hair">Add hair</button>
        <button type="button" class="button skeleton-apply-hair">Apply hair</button>
        <button type="button" class="button skeleton-delete-hair">Delete hair</button>
      </div>
    </fieldset>
    `)}

    ${sectionMarkup({ id: 'sprites-skeleton-colliders', title: 'Hair colliders', hint: 'Circles the hair slides around' }, `
    <fieldset class="tuning-group skeleton-collider-group">
      <legend class="visually-hidden">Hair colliders</legend>
      <label class="appearance-label" for="skeleton-collider">Collider</label>
      <select id="skeleton-collider"></select>
      <div class="skeleton-meta-row">
        <span class="skeleton-token-label">Collider ID</span>
        <code class="skeleton-token skeleton-collider-id">—</code>
      </div>
      <div class="skeleton-inline-grid skeleton-inline-grid-2">
        <div>
          <label class="appearance-label" for="skeleton-collider-bone">Bone</label>
          <select id="skeleton-collider-bone"></select>
        </div>
        <div>
          <label class="appearance-label" for="skeleton-collider-radius">Radius</label>
          <input id="skeleton-collider-radius" type="number" min="0.01" max="${SKELETON_LIMITS.length}" step="0.01" />
        </div>
      </div>
      <div class="skeleton-inline-grid skeleton-inline-grid-2">
        <div>
          <label class="appearance-label" for="skeleton-collider-x">Offset X</label>
          <input id="skeleton-collider-x" type="number" min="${-SKELETON_LIMITS.position}" max="${SKELETON_LIMITS.position}" step="${POSITION_STEP}" />
        </div>
        <div>
          <label class="appearance-label" for="skeleton-collider-y">Offset Y</label>
          <input id="skeleton-collider-y" type="number" min="${-SKELETON_LIMITS.position}" max="${SKELETON_LIMITS.position}" step="${POSITION_STEP}" />
        </div>
      </div>
      <div class="skeleton-action-row">
        <button type="button" class="button skeleton-add-collider">Add collider</button>
        <button type="button" class="button skeleton-apply-collider">Apply collider</button>
        <button type="button" class="button skeleton-delete-collider">Delete collider</button>
      </div>
    </fieldset>
    `)}
  `;

  const get = <T extends HTMLElement>(selector: string): T => element<T>(root, selector);
  const getSvg = (selector: string): SVGSVGElement => {
    const node = root.querySelector(selector);
    if (!(node instanceof SVGSVGElement)) throw new Error(`Missing UI element: ${selector}`);
    return node;
  };

  const statusBox = get<HTMLDivElement>('.skeleton-state');
  const status = get<HTMLParagraphElement>('.skeleton-status');
  const createButton = get<HTMLButtonElement>('.skeleton-create');
  const deleteSkeletonButton = get<HTMLButtonElement>('.skeleton-delete');
  const anchorSelect = get<HTMLSelectElement>('#skeleton-anchor');
  const bonesGroup = get<HTMLFieldSetElement>('.skeleton-bones-group');
  const boneSelect = get<HTMLSelectElement>('#skeleton-bone');
  const addRootBoneButton = get<HTMLButtonElement>('.skeleton-add-root');
  const addChildBoneButton = get<HTMLButtonElement>('.skeleton-add-child');
  const diagram = getSvg('.skeleton-diagram');
  const boneId = get<HTMLElement>('.skeleton-bone-id');
  const boneNameInput = get<HTMLInputElement>('#skeleton-bone-name');
  const boneParentSelect = get<HTMLSelectElement>('#skeleton-bone-parent');
  const boneXInput = get<HTMLInputElement>('#skeleton-bone-x');
  const boneYInput = get<HTMLInputElement>('#skeleton-bone-y');
  const boneLengthInput = get<HTMLInputElement>('#skeleton-bone-length');
  const boneRotationInput = get<HTMLInputElement>('#skeleton-bone-rotation');
  const applyBoneButton = get<HTMLButtonElement>('.skeleton-apply-bone');
  const deleteBoneButton = get<HTMLButtonElement>('.skeleton-delete-bone');
  const layerGroup = get<HTMLFieldSetElement>('.skeleton-layer-group');
  const layerLabel = get<HTMLParagraphElement>('.skeleton-layer-label');
  const layerBoneSelect = get<HTMLSelectElement>('#skeleton-layer-bone');
  const applyRigidButton = get<HTMLButtonElement>('.skeleton-apply-rigid');
  const tileToggle = get<HTMLInputElement>('#skeleton-layer-tiled');
  const tileLengthInput = get<HTMLInputElement>('#skeleton-layer-tile-length');
  const applyTileButton = get<HTMLButtonElement>('.skeleton-apply-tile');
  const directionsGrid = get<HTMLDivElement>('.skeleton-direction-grid');
  const flipbookNote = get<HTMLParagraphElement>('.skeleton-flipbook-note');
  const meshColumnsInput = get<HTMLInputElement>('#skeleton-mesh-columns');
  const meshRowsInput = get<HTMLInputElement>('#skeleton-mesh-rows');
  const meshBonesSelect = get<HTMLSelectElement>('#skeleton-mesh-bones');
  const bindMeshButton = get<HTMLButtonElement>('.skeleton-bind-mesh');
  const switchRigidButton = get<HTMLButtonElement>('.skeleton-switch-rigid');
  const weightsSection = get<HTMLDivElement>('.skeleton-weights-subsection');
  const weightVertexSelect = get<HTMLSelectElement>('#skeleton-weight-vertex');
  const weightRowsHost = get<HTMLDivElement>('.skeleton-weight-rows');
  const applyWeightsButton = get<HTMLButtonElement>('.skeleton-apply-weights');
  const poseGroup = get<HTMLFieldSetElement>('.skeleton-pose-group');
  const directionSelect = get<HTMLSelectElement>('#skeleton-direction');
  const selectionNote = get<HTMLParagraphElement>('.skeleton-selection-note');
  const poseXInput = get<HTMLInputElement>('#skeleton-pose-x');
  const poseYInput = get<HTMLInputElement>('#skeleton-pose-y');
  const poseRotationInput = get<HTMLInputElement>('#skeleton-pose-rotation');
  const applyPoseButton = get<HTMLButtonElement>('.skeleton-apply-pose');
  const clearPoseButton = get<HTMLButtonElement>('.skeleton-clear-pose');
  const animationGroup = get<HTMLFieldSetElement>('.skeleton-animation-group');
  const defaultClipSelect = get<HTMLSelectElement>('#skeleton-default-clip');
  const clipSelect = get<HTMLSelectElement>('#skeleton-clip');
  const clipId = get<HTMLElement>('.skeleton-clip-id');
  const clipNameInput = get<HTMLInputElement>('#skeleton-clip-name');
  const clipDurationInput = get<HTMLInputElement>('#skeleton-clip-duration');
  const clipLoopInput = get<HTMLInputElement>('#skeleton-clip-loop');
  const addClipButton = get<HTMLButtonElement>('.skeleton-add-clip');
  const applyClipButton = get<HTMLButtonElement>('.skeleton-apply-clip');
  const deleteClipButton = get<HTMLButtonElement>('.skeleton-delete-clip');
  const frameSelect = get<HTMLSelectElement>('#skeleton-frame');
  const frameTimeInput = get<HTMLInputElement>('#skeleton-frame-time');
  const frameXInput = get<HTMLInputElement>('#skeleton-frame-x');
  const frameYInput = get<HTMLInputElement>('#skeleton-frame-y');
  const frameRotationInput = get<HTMLInputElement>('#skeleton-frame-rotation');
  const addFrameButton = get<HTMLButtonElement>('.skeleton-add-frame');
  const replaceFrameButton = get<HTMLButtonElement>('.skeleton-replace-frame');
  const deleteFrameButton = get<HTMLButtonElement>('.skeleton-delete-frame');
  const applyFramePoseButton = get<HTMLButtonElement>('.skeleton-apply-frame-pose');
  const clearFramePoseButton = get<HTMLButtonElement>('.skeleton-clear-frame-pose');
  const previewModeSelect = get<HTMLSelectElement>('#skeleton-preview-mode');
  const previewConstraintsSelect = get<HTMLSelectElement>('#skeleton-preview-constraints');
  const previewLiveButton = get<HTMLButtonElement>('.skeleton-preview-live');
  const previewUnavailable = get<HTMLParagraphElement>('.skeleton-preview-unavailable');
  const ikGroup = get<HTMLFieldSetElement>('.skeleton-ik-group');
  const ikSelect = get<HTMLSelectElement>('#skeleton-ik');
  const ikId = get<HTMLElement>('.skeleton-ik-id');
  const ikUpperSelect = get<HTMLSelectElement>('#skeleton-ik-upper');
  const ikLowerSelect = get<HTMLSelectElement>('#skeleton-ik-lower');
  const ikHandSelect = get<HTMLSelectElement>('#skeleton-ik-hand');
  const ikTargetSelect = get<HTMLSelectElement>('#skeleton-ik-target');
  const ikBendSelect = get<HTMLSelectElement>('#skeleton-ik-bend');
  const ikMixInput = get<HTMLInputElement>('#skeleton-ik-mix');
  const ikOffsetXInput = get<HTMLInputElement>('#skeleton-ik-offset-x');
  const ikOffsetYInput = get<HTMLInputElement>('#skeleton-ik-offset-y');
  const ikRotationInput = get<HTMLInputElement>('#skeleton-ik-rotation');
  const addIkButton = get<HTMLButtonElement>('.skeleton-add-ik');
  const applyIkButton = get<HTMLButtonElement>('.skeleton-apply-ik');
  const deleteIkButton = get<HTMLButtonElement>('.skeleton-delete-ik');
  const hairGroup = get<HTMLFieldSetElement>('.skeleton-hair-group');
  const hairSelect = get<HTMLSelectElement>('#skeleton-hair');
  const hairId = get<HTMLElement>('.skeleton-hair-id');
  const hairRootSelect = get<HTMLSelectElement>('#skeleton-hair-root');
  const hairTipSelect = get<HTMLSelectElement>('#skeleton-hair-tip');
  const hairStiffnessInput = get<HTMLInputElement>('#skeleton-hair-stiffness');
  const hairDampingInput = get<HTMLInputElement>('#skeleton-hair-damping');
  const hairGravityInput = get<HTMLInputElement>('#skeleton-hair-gravity');
  const hairRadiusInput = get<HTMLInputElement>('#skeleton-hair-radius');
  const hairSummary = get<HTMLParagraphElement>('.skeleton-hair-summary');
  const addHairButton = get<HTMLButtonElement>('.skeleton-add-hair');
  const applyHairButton = get<HTMLButtonElement>('.skeleton-apply-hair');
  const deleteHairButton = get<HTMLButtonElement>('.skeleton-delete-hair');
  const colliderGroup = get<HTMLFieldSetElement>('.skeleton-collider-group');
  const colliderSelect = get<HTMLSelectElement>('#skeleton-collider');
  const colliderId = get<HTMLElement>('.skeleton-collider-id');
  const colliderBoneSelect = get<HTMLSelectElement>('#skeleton-collider-bone');
  const colliderRadiusInput = get<HTMLInputElement>('#skeleton-collider-radius');
  const colliderXInput = get<HTMLInputElement>('#skeleton-collider-x');
  const colliderYInput = get<HTMLInputElement>('#skeleton-collider-y');
  const addColliderButton = get<HTMLButtonElement>('.skeleton-add-collider');
  const applyColliderButton = get<HTMLButtonElement>('.skeleton-apply-collider');
  const deleteColliderButton = get<HTMLButtonElement>('.skeleton-delete-collider');
  const defaultAnchorId = options.anchors[0].id;

  const directionInputs = new Map<FacingDirection, HTMLInputElement>();
  for (const direction of FACING_DIRECTIONS) {
    const label = document.createElement('label');
    label.className = 'skeleton-direction-toggle';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.value = direction;
    input.dataset.direction = direction;
    const text = document.createElement('span');
    text.textContent = titleCase(direction);
    label.append(input, text);
    directionsGrid.append(label);
    directionInputs.set(direction, input);
  }

  const weightRows: WeightRowControls[] = [];
  for (let index = 0; index < SKELETON_LIMITS.influences; index += 1) {
    const row = document.createElement('div');
    row.className = 'skeleton-weight-row';
    const bone = document.createElement('select');
    bone.ariaLabel = `Weight bone ${index + 1}`;
    const weight = document.createElement('input');
    weight.type = 'number';
    weight.min = '0';
    weight.max = '1';
    weight.step = String(WEIGHT_STEP);
    weight.ariaLabel = `Weight value ${index + 1}`;
    row.append(bone, weight);
    weightRowsHost.append(row);
    weightRows.push({ bone, weight });
  }

  syncSelectOptions(anchorSelect, options.anchors.map(anchor => ({ value: anchor.id, label: anchor.label })));
  syncSelectOptions(directionSelect, FACING_DIRECTIONS.map(direction => ({ value: direction, label: titleCase(direction) })));
  syncSelectOptions(ikTargetSelect, options.targetIds.map(id => ({ value: id, label: id })));
  anchorSelect.value = defaultAnchorId;
  meshColumnsInput.value = String(DEFAULT_MESH_COLUMNS);
  meshRowsInput.value = String(DEFAULT_MESH_ROWS);
  hairGravityInput.value = String(DEFAULT_HAIR_GRAVITY);

  const previewTimeControl: RangeControl = createRangeControl({
    label: 'Preview time', min: 0, max: SKELETON_LIMITS.duration, step: DURATION_STEP, unit: 's',
  }, {
    id: 'skeleton-preview-time',
    name: 'preview-time',
    signal: events.signal,
    onInput: () => {
      if (previewMode === 'clip') applyPreview();
    },
  });
  get<HTMLDivElement>('.skeleton-preview-range').append(previewTimeControl.row);

  function setMessage(text: string | null, kind: StatusKind = 'error'): void {
    localMessage = text === null ? null : { text, kind };
  }

  function clearMessage(): void {
    localMessage = null;
  }

  function expectSkeleton(): SkeletonDefinition {
    const skeleton = state.definition().skeleton;
    if (skeleton === null) throw new UiError('Create a skeleton first.');
    return skeleton;
  }

  function currentClip(definition: SkeletonDefinition | null): SkeletonClip | null {
    if (definition === null || definition.clips.length === 0) return null;
    return definition.clips.find(clip => clip.id === selectedClipId) ?? definition.clips[0] ?? null;
  }

  function currentFrame(clip: SkeletonClip | null): SkeletonClip['frames'][number] | null {
    if (clip === null || clip.frames.length === 0) return null;
    const index = selectedFrameIndexByClip.get(clip.id) ?? 0;
    return clip.frames[Math.max(0, Math.min(clip.frames.length - 1, index))] ?? null;
  }

  function previewFor(skeleton: SkeletonDefinition | null): SkeletonPreview | null {
    if (previewMode === 'live' || skeleton === null) return null;
    const direction = selectedDirection, constraints = previewConstraints;
    const clip = currentClip(skeleton);
    if (previewMode === 'clip') {
      if (clip === null) throw new UiError('Create and select a clip before scrubbing a preview.');
      const time = Math.min(clip.duration, previewTimeControl.input.valueAsNumber);
      return { time, clip: clip.id, direction, pose: [], constraints };
    }
    if (previewMode === 'frame') {
      const frame = currentFrame(clip);
      if (frame === null) throw new UiError('Select a keyframe to preview.');
      return { time: 0, clip: null, direction, pose: clonePose(frame.pose), constraints };
    }
    return { time: 0, clip: null, direction, pose: [], constraints };
  }

  function applyPreview(): void {
    try {
      state.setPreview(previewFor(state.definition().skeleton));
    } catch (error) {
      if (error instanceof UiError || error instanceof SkeletonError) {
        setMessage(error.message);
        render();
        return;
      }
      throw error;
    }
  }

  const info = (label: string, section: string, select: Selection | null): ProjectCommandInfo =>
    ({ label, place: { tab: 'sprites', section, select }, coalesce: null });
  // A step on layer `id`, which Undo and Redo select again, along with the targets `select` names.
  const layerInfo = (label: string, id: string, select: Selection = { before: [], after: [] }): ProjectCommandInfo => {
    const layer = selectionEntry('layer', id);
    return info(label, 'sprites-skeleton-layer', { before: [layer, ...select.before], after: [layer, ...select.after] });
  };

  function selectionOf(target: Target): string | null {
    switch (target) {
      case 'bone': return selectedBoneId;
      case 'direction': return selectedDirection;
      case 'clip': return selectedClipId;
      case 'keyframe': return selectedClipId === null ? null : String(selectedFrameIndexByClip.get(selectedClipId) ?? 0);
      case 'ik': return selectedIkId;
      case 'hair': return selectedHairId;
      case 'collider': return selectedColliderId;
      case 'vertex': return String(selectedVertexIndex);
    }
  }

  // The editor's selection of `targets`, as a step records it.
  function selection(...targets: Target[]): string[] {
    return targets.flatMap((target) => {
      const id = selectionOf(target);
      return id === null ? [] : [selectionEntry(target, id)];
    });
  }

  // A step that leaves the selection of `targets` as it is.
  function keeping(...targets: Target[]): Selection {
    const entries = selection(...targets);
    return { before: entries, after: entries };
  }

  // A step that adds the `target` named `id`, which it selects.
  function adding(target: Target, id: string): Selection {
    return { before: selection(target), after: [selectionEntry(target, id)] };
  }

  // A step that deletes the `target` named `id` from `entries`, selecting the first that remains.
  function deleting(target: Target, entries: readonly { readonly id: string }[], id: string | null): Selection {
    const next = entries.find((entry) => entry.id !== id)?.id;
    return { before: selection(target), after: next === undefined ? [] : [selectionEntry(target, next)] };
  }

  // Takes up the selection a Sprites step recorded: its own after it, the earlier one after Undo. render() settles any
  // target the profile no longer has.
  function restore(entries: readonly string[]): void {
    for (const id of selectionIds(entries, 'bone')) selectedBoneId = id;
    for (const id of selectionIds(entries, 'direction')) selectedDirection = validateDirection(id);
    for (const id of selectionIds(entries, 'clip')) selectedClipId = id;
    for (const index of selectionIds(entries, 'keyframe')) {
      if (selectedClipId !== null) selectedFrameIndexByClip.set(selectedClipId, Number.parseInt(index, 10));
    }
    for (const id of selectionIds(entries, 'ik')) selectedIkId = id;
    for (const id of selectionIds(entries, 'hair')) selectedHairId = id;
    for (const id of selectionIds(entries, 'collider')) selectedColliderId = id;
    for (const index of selectionIds(entries, 'vertex')) selectedVertexIndex = Number.parseInt(index, 10);
  }

  // After a step, the preview follows the profile's skeleton; `then` updates what the step's selection does not cover.
  function applied(then?: () => void): void {
    then?.();
    if (previewMode !== 'live') applyPreview();
    render();
  }

  // One step: a skeleton built from the profile's own as the step runs. Form values and the selection it makes are read
  // before it, so a refusal leaves the editor as it was; the step's own event selects what it made.
  function updateSkeleton(
    label: string, section: string, select: Selection | null, build: (draft: MutableSkeleton) => void, then?: () => void,
  ): void {
    clearMessage();
    if (!state.apply(commands.skeleton((current) => {
      if (current === null) throw new SpriteError('Create a skeleton first.');
      const draft = cloneSkeleton(current);
      build(draft);
      return draft;
    }, info(label, section, select)))) return;
    applied(then);
  }

  function withUiErrors(action: () => void): void {
    try {
      action();
    } catch (error) {
      if (error instanceof UiError || error instanceof SkeletonError) {
        setMessage(error.message);
        render();
        return;
      }
      throw error;
    }
  }

  function ensureSelections(snapshot: SpriteEditorSnapshot): void {
    const skeleton = snapshot.document.skeleton;
    if (skeleton === null) {
      selectedBoneId = null;
      selectedClipId = null;
      selectedIkId = null;
      selectedHairId = null;
      selectedColliderId = null;
      selectedVertexIndex = 0;
      meshBoneSelection = null;
      selectedFrameIndexByClip.clear();
      return;
    }
    if (!skeleton.bones.some(bone => bone.id === selectedBoneId)) selectedBoneId = skeleton.bones[0]?.id ?? null;
    if (!skeleton.clips.some(clip => clip.id === selectedClipId)) selectedClipId = skeleton.clips[0]?.id ?? null;
    if (!skeleton.ik.some(ik => ik.id === selectedIkId)) selectedIkId = skeleton.ik[0]?.id ?? null;
    if (!skeleton.hair.some(chain => chain.id === selectedHairId)) selectedHairId = skeleton.hair[0]?.id ?? null;
    if (!skeleton.colliders.some(collider => collider.id === selectedColliderId)) selectedColliderId = skeleton.colliders[0]?.id ?? null;
    if (meshBoneSelection === null) meshBoneSelection = new Set(skeleton.bones.map(bone => bone.id));
    else {
      for (const id of meshBoneSelection) {
        if (!skeleton.bones.some(bone => bone.id === id)) meshBoneSelection.delete(id);
      }
    }
    for (const id of selectedFrameIndexByClip.keys()) {
      if (!skeleton.clips.some(clip => clip.id === id)) selectedFrameIndexByClip.delete(id);
    }
    const layer = selectedLayer(snapshot);
    const vertexCount = layer?.skin?.weights.length ?? 0;
    if (vertexCount === 0) selectedVertexIndex = 0;
    else selectedVertexIndex = Math.max(0, Math.min(vertexCount - 1, selectedVertexIndex));
    const clip = currentClip(skeleton);
    if (clip !== null) {
      const index = selectedFrameIndexByClip.get(clip.id) ?? 0;
      selectedFrameIndexByClip.set(clip.id, Math.max(0, Math.min(clip.frames.length - 1, index)));
    }
    if (snapshot.preview === null) previewMode = 'live';
    else {
      previewConstraints = snapshot.preview.constraints;
      if (snapshot.preview.clip !== null) previewMode = 'clip';
    }
  }

  function renderDiagram(definition: SkeletonDefinition | null, layer: SpriteLayer | null): void {
    diagram.replaceChildren();
    const ns = 'http://www.w3.org/2000/svg';
    const background = document.createElementNS(ns, 'rect');
    background.setAttribute('x', '0');
    background.setAttribute('y', '0');
    background.setAttribute('width', String(DIAGRAM_WIDTH));
    background.setAttribute('height', String(DIAGRAM_HEIGHT));
    background.setAttribute('rx', '10');
    background.setAttribute('fill', '#f7f6ef');
    background.setAttribute('stroke', '#d0d5c6');
    diagram.append(background);
    if (definition === null) {
      const label = document.createElementNS(ns, 'text');
      label.setAttribute('x', String(DIAGRAM_WIDTH / 2));
      label.setAttribute('y', String(DIAGRAM_HEIGHT / 2));
      label.setAttribute('text-anchor', 'middle');
      label.setAttribute('fill', '#657565');
      label.setAttribute('font-size', '11');
      label.textContent = 'No skeleton yet';
      diagram.append(label);
      return;
    }
    const bones = restPose(definition);
    const segments = bones.map(bone => ({
      ...bone,
      tipX: bone.x + Math.cos(bone.angle) * bone.length,
      tipY: bone.y + Math.sin(bone.angle) * bone.length,
    }));
    const points = segments.flatMap(segment => [
      { x: segment.x, y: segment.y },
      { x: segment.tipX, y: segment.tipY },
    ]);
    if (layer !== null && (layer.skin !== null || layer.bone !== null)) {
      points.push(...layerOutline(layer, definition));
    }
    const minX = Math.min(...points.map(point => point.x));
    const maxX = Math.max(...points.map(point => point.x));
    const minY = Math.min(...points.map(point => point.y));
    const maxY = Math.max(...points.map(point => point.y));
    const spanX = Math.max(1, maxX - minX);
    const spanY = Math.max(1, maxY - minY);
    const padding = 18;
    const scale = Math.min((DIAGRAM_WIDTH - padding * 2) / spanX, (DIAGRAM_HEIGHT - padding * 2) / spanY);
    const centerX = (minX + maxX) / 2;
    const centerY = (minY + maxY) / 2;
    const project = (x: number, y: number): { x: number; y: number } => ({
      x: DIAGRAM_WIDTH / 2 + (x - centerX) * scale,
      y: DIAGRAM_HEIGHT / 2 - (y - centerY) * scale,
    });

    const axis = document.createElementNS(ns, 'line');
    axis.setAttribute('x1', '12');
    axis.setAttribute('x2', String(DIAGRAM_WIDTH - 12));
    axis.setAttribute('y1', String(DIAGRAM_HEIGHT / 2));
    axis.setAttribute('y2', String(DIAGRAM_HEIGHT / 2));
    axis.setAttribute('stroke', '#e1e5d8');
    axis.setAttribute('stroke-width', '1');
    diagram.append(axis);

    if (layer !== null && (layer.skin !== null || layer.bone !== null)) {
      const outline = layerOutline(layer, definition).map(point => project(point.x, point.y));
      const polygon = document.createElementNS(ns, 'polygon');
      polygon.setAttribute('points', outline.map(point => `${point.x},${point.y}`).join(' '));
      polygon.setAttribute('fill', layer.skin !== null ? 'rgba(90, 137, 126, 0.12)' : 'rgba(133, 95, 61, 0.08)');
      polygon.setAttribute('stroke', layer.skin !== null ? '#3c7368' : '#8f6745');
      polygon.setAttribute('stroke-dasharray', '5 4');
      polygon.setAttribute('stroke-width', '1.5');
      diagram.append(polygon);
    }

    for (const segment of segments) {
      const start = project(segment.x, segment.y);
      const tip = project(segment.tipX, segment.tipY);
      const selected = segment.id === selectedBoneId;
      const group = document.createElementNS(ns, 'g');
      group.setAttribute('data-bone-id', segment.id);
      group.setAttribute('class', selected ? 'is-selected' : '');
      const line = document.createElementNS(ns, 'line');
      line.setAttribute('x1', String(start.x));
      line.setAttribute('y1', String(start.y));
      line.setAttribute('x2', String(tip.x));
      line.setAttribute('y2', String(tip.y));
      line.setAttribute('stroke', selected ? '#24584d' : '#596857');
      line.setAttribute('stroke-width', selected ? '4' : '3');
      line.setAttribute('stroke-linecap', 'round');
      const root = document.createElementNS(ns, 'circle');
      root.setAttribute('cx', String(start.x));
      root.setAttribute('cy', String(start.y));
      root.setAttribute('r', selected ? '5' : '4');
      root.setAttribute('fill', selected ? '#24584d' : '#8fa28d');
      const tipCircle = document.createElementNS(ns, 'circle');
      tipCircle.setAttribute('cx', String(tip.x));
      tipCircle.setAttribute('cy', String(tip.y));
      tipCircle.setAttribute('r', '3');
      tipCircle.setAttribute('fill', '#f6f3ea');
      tipCircle.setAttribute('stroke', selected ? '#24584d' : '#6c7b6a');
      tipCircle.setAttribute('stroke-width', '2');
      group.append(line, root, tipCircle);
      diagram.append(group);
    }
  }

  function render(force = false): void {
    if (disposed) return;
    const snapshot = state.snapshot();
    ensureSelections(snapshot);
    const skeleton = snapshot.document.skeleton;
    const layer = selectedLayer(snapshot);
    const spritesEnabled = snapshot.document.characterRiggingType === 'sprite-2d';
    // Previews pose the rig, so they wait until it shows the profile.
    const previewDisabled = snapshot.rendering.kind !== 'ready' || !spritesEnabled;
    previewUnavailable.hidden = spritesEnabled;
    const clip = currentClip(skeleton);
    const frame = currentFrame(clip);
    const bone = skeleton?.bones.find(entry => entry.id === selectedBoneId) ?? null;
    const ik = skeleton?.ik.find(entry => entry.id === selectedIkId) ?? null;
    const hair = skeleton?.hair.find(entry => entry.id === selectedHairId) ?? null;
    const collider = skeleton?.colliders.find(entry => entry.id === selectedColliderId) ?? null;
    const fixed = skeleton !== null && selectedBoneId !== null ? fixedJointIds(skeleton).has(selectedBoneId) : false;
    const selectedPose = skeleton === null || selectedBoneId === null ? null : poseForBone(poseForDirection(skeleton, selectedDirection), selectedBoneId);
    const selectedFramePose = frame === null || selectedBoneId === null ? null : poseForBone(frame.pose, selectedBoneId);

    let message: string;
    let kind: StatusKind;
    if (localMessage !== null) {
      message = localMessage.text;
      kind = localMessage.kind;
    } else if (snapshot.error !== null) {
      message = snapshot.error;
      kind = 'error';
    } else if (snapshot.rendering.kind === 'failed') {
      message = `The character could not be shown: ${snapshot.rendering.error.message}`;
      kind = 'error';
    } else if (snapshot.rendering.kind === 'loading') {
      message = 'Loading the character… Previews wait until it shows.';
      kind = 'busy';
    } else if (!spritesEnabled) {
      message = 'Sprite rendering and pose preview are inactive in Mesh parts and Avatar modes. Select 2D sprites in Character to preview this retained 2D rig.';
      kind = snapshot.dirty ? 'draft' : 'ready';
    } else if (skeleton === null) {
      message = 'No skeleton yet. Create one to enable bone binding, animation and constraints.';
      kind = snapshot.dirty ? 'draft' : 'ready';
    } else if (snapshot.directionalPreview) {
      message = 'Directional aim preview is active on the game canvas. Return to live to end the preview.';
      kind = 'draft';
    } else if (snapshot.preview !== null) {
      message = 'Explicit preview active. Return to live to resume the game-driven clip.';
      kind = 'draft';
    } else if (snapshot.dirty) {
      message = 'Skeleton changes are unsaved until you save the sprite document.';
      kind = 'draft';
    } else {
      message = 'Skeleton and layer rigging are ready.';
      kind = 'ready';
    }
    setText(status, message);
    statusBox.dataset.kind = kind;

    const anchorOptions = options.anchors.map(anchor => ({ value: anchor.id, label: anchor.label }));
    syncSelectOptions(anchorSelect, anchorOptions);
    const anchorValue = skeleton?.anchor ?? defaultAnchorId;
    if (anchorSelect.value !== anchorValue) anchorSelect.value = anchorValue;
    createButton.disabled = skeleton !== null;
    deleteSkeletonButton.disabled = skeleton === null;
    anchorSelect.disabled = skeleton === null;

    const boneOptions = skeleton === null ? [{ value: '', label: 'No bones yet' }] : skeleton.bones.map(item => ({ value: item.id, label: `${item.name} (${item.id})` }));
    syncSelectOptions(boneSelect, boneOptions);
    boneSelect.disabled = skeleton === null;
    if (boneSelect.value !== (selectedBoneId ?? '')) boneSelect.value = selectedBoneId ?? '';
    bonesGroup.disabled = skeleton === null;
    addRootBoneButton.disabled = skeleton === null || skeleton.bones.length >= SKELETON_LIMITS.bones;
    addChildBoneButton.disabled = bone === null || skeleton === null || skeleton.bones.length >= SKELETON_LIMITS.bones;
    setText(boneId, bone?.id ?? '—');
    syncSelectOptions(boneParentSelect, skeleton === null || bone === null ? [{ value: '', label: 'No parent' }] : [
      { value: '', label: 'No parent' },
      ...skeleton.bones.filter(item => item.id !== bone.id).map(item => ({ value: item.id, label: `${item.name} (${item.id})` })),
    ]);
    if (bone !== null) {
      if (boneParentSelect.value !== (bone.parent ?? '')) boneParentSelect.value = bone.parent ?? '';
      setTextInputValue(boneNameInput, bone.name, force);
      setNumberInputValue(boneXInput, bone.x, force);
      setNumberInputValue(boneYInput, bone.y, force);
      setNumberInputValue(boneLengthInput, bone.length, force);
      setNumberInputValue(boneRotationInput, bone.rotation, force);
    } else {
      setTextInputValue(boneNameInput, '', true);
      setNumberInputValue(boneXInput, 0, true);
      setNumberInputValue(boneYInput, 0, true);
      setNumberInputValue(boneLengthInput, DEFAULT_BONE_LENGTH, true);
      setNumberInputValue(boneRotationInput, 0, true);
    }
    renderDiagram(skeleton, layer);

    layerGroup.disabled = layer === null;
    setText(layerLabel, layer === null ? 'Select a layer in Sprites to edit its rigging.' : `Layer: ${layer.name}`);
    syncSelectOptions(layerBoneSelect, buildBoneOptions(skeleton, 'Legacy anchor space'));
    if (layerBoneSelect.value !== (layer?.bone ?? '')) layerBoneSelect.value = layer?.bone ?? '';
    applyRigidButton.disabled = layer === null || skeleton === null;
    const flipbook = layer?.flipbook !== undefined;
    flipbookNote.hidden = !flipbook;
    setChecked(tileToggle, layer !== null && layer.tileLength !== null);
    tileToggle.disabled = layer === null || layer.skin !== null || flipbook;
    tileLengthInput.disabled = layer === null || layer.skin !== null || flipbook || !tileToggle.checked;
    setNumberInputValue(tileLengthInput, layer?.tileLength ?? 1, force);
    applyTileButton.disabled = layer === null || layer.skin !== null || flipbook;
    for (const direction of FACING_DIRECTIONS) {
      const input = directionInputs.get(direction)!;
      setChecked(input, layer?.directions.includes(direction) ?? false);
      input.disabled = layer === null || flipbook;
    }
    if (skeleton !== null) {
      syncSelectOptions(meshBonesSelect, skeleton.bones.map(item => ({ value: item.id, label: `${item.name} (${item.id})` })));
      for (const option of Array.from(meshBonesSelect.options)) option.selected = meshBoneSelection !== null && meshBoneSelection.has(option.value);
    } else {
      syncSelectOptions(meshBonesSelect, [{ value: '', label: 'Create a skeleton first', disabled: true }]);
    }
    meshBonesSelect.disabled = skeleton === null || layer === null;
    if (layer !== null && layer.skin !== null) {
      setNumberInputValue(meshColumnsInput, layer.skin.columns, force);
      setNumberInputValue(meshRowsInput, layer.skin.rows, force);
    }
    meshColumnsInput.disabled = skeleton === null || layer === null;
    meshRowsInput.disabled = skeleton === null || layer === null;
    bindMeshButton.disabled = skeleton === null || layer === null || flipbook;
    switchRigidButton.disabled = skeleton === null || layer?.skin === null;
    const skin = layer?.skin ?? null;
    weightsSection.classList.toggle('is-disabled', skin === null);
    weightsSection.setAttribute('aria-disabled', skin === null ? 'true' : 'false');
    if (skin !== null) {
      const vertices: SelectOption[] = [];
      for (let row = 0; row <= skin.rows; row += 1) {
        for (let column = 0; column <= skin.columns; column += 1) {
          const index = row * (skin.columns + 1) + column;
          vertices.push({ value: String(index), label: `Column ${column}, Row ${row}` });
        }
      }
      syncSelectOptions(weightVertexSelect, vertices);
      if (weightVertexSelect.value !== String(selectedVertexIndex)) weightVertexSelect.value = String(selectedVertexIndex);
      const weightOptions = buildBoneOptions(skeleton, 'Unused');
      const weights = skin.weights[selectedVertexIndex] ?? [];
      for (const [index, row] of weightRows.entries()) {
        syncSelectOptions(row.bone, weightOptions);
        const influence = weights[index];
        if (row.bone.value !== (influence?.bone ?? '')) row.bone.value = influence?.bone ?? '';
        setNumberInputValue(row.weight, influence?.weight ?? 0, force);
        row.bone.disabled = false;
        row.weight.disabled = false;
      }
    } else {
      syncSelectOptions(weightVertexSelect, [{ value: '0', label: 'Bind a mesh first', disabled: true }]);
      weightVertexSelect.value = '0';
      for (const row of weightRows) {
        syncSelectOptions(row.bone, [{ value: '', label: 'Unused' }]);
        row.bone.value = '';
        setNumberInputValue(row.weight, 0, true);
        row.bone.disabled = true;
        row.weight.disabled = true;
      }
    }
    weightVertexSelect.disabled = skin === null;
    applyWeightsButton.disabled = skin === null;

    poseGroup.disabled = skeleton === null || bone === null;
    if (directionSelect.value !== selectedDirection) directionSelect.value = selectedDirection;
    setText(selectionNote, bone === null ? 'Select a bone above to edit offsets.' : `Editing ${bone.name} (${bone.id}) for ${titleCase(selectedDirection)}.`);
    setNumberInputValue(poseXInput, poseEditorValue(selectedPose, 'x'), force);
    setNumberInputValue(poseYInput, poseEditorValue(selectedPose, 'y'), force);
    setNumberInputValue(poseRotationInput, poseEditorValue(selectedPose, 'rotation'), force);
    poseXInput.disabled = skeleton === null || bone === null || fixed;
    poseYInput.disabled = skeleton === null || bone === null || fixed;
    poseRotationInput.disabled = skeleton === null || bone === null;
    applyPoseButton.disabled = skeleton === null || bone === null;
    clearPoseButton.disabled = skeleton === null || bone === null || selectedPose === null;

    animationGroup.disabled = skeleton === null;
    const clipOptions = skeleton === null || skeleton.clips.length === 0 ? [{ value: '', label: 'No clips yet' }] : skeleton.clips.map(item => ({ value: item.id, label: item.name }));
    syncSelectOptions(defaultClipSelect, [{ value: '', label: 'No default clip' }, ...(skeleton?.clips.map(item => ({ value: item.id, label: item.name })) ?? [])]);
    if (defaultClipSelect.value !== (skeleton?.animation ?? '')) defaultClipSelect.value = skeleton?.animation ?? '';
    syncSelectOptions(clipSelect, clipOptions);
    if (clipSelect.value !== (selectedClipId ?? '')) clipSelect.value = selectedClipId ?? '';
    setText(clipId, clip?.id ?? '—');
    setTextInputValue(clipNameInput, clip?.name ?? '', force);
    setNumberInputValue(clipDurationInput, clip?.duration ?? 1, force);
    setChecked(clipLoopInput, clip?.loop ?? true);
    addClipButton.disabled = skeleton === null || skeleton.clips.length >= SKELETON_LIMITS.clips;
    applyClipButton.disabled = clip === null;
    deleteClipButton.disabled = clip === null;
    if (clip !== null) {
      syncSelectOptions(frameSelect, clip.frames.map((entry, index) => ({ value: String(index), label: frameLabel(entry, index) })));
      const frameIndex = selectedFrameIndexByClip.get(clip.id) ?? 0;
      if (frameSelect.value !== String(frameIndex)) frameSelect.value = String(frameIndex);
      frameTimeInput.max = String(clip.duration);
      previewTimeControl.input.max = String(clip.duration);
      if (!Number.isNaN(previewTimeControl.input.valueAsNumber) && previewTimeControl.input.valueAsNumber > clip.duration) {
        previewTimeControl.setValue(clip.duration, { disabled: previewDisabled || previewMode !== 'clip' });
      } else {
        previewTimeControl.setValue(snapshot.preview?.time ?? 0, { disabled: previewDisabled || previewMode !== 'clip' });
      }
    } else {
      syncSelectOptions(frameSelect, [{ value: '', label: 'No keyframes yet' }]);
      frameSelect.value = '';
      previewTimeControl.input.max = String(SKELETON_LIMITS.duration);
      previewTimeControl.setValue(0, { disabled: true });
    }
    setNumberInputValue(frameTimeInput, frame?.time ?? 0, force);
    setNumberInputValue(frameXInput, poseEditorValue(selectedFramePose, 'x'), force);
    setNumberInputValue(frameYInput, poseEditorValue(selectedFramePose, 'y'), force);
    setNumberInputValue(frameRotationInput, poseEditorValue(selectedFramePose, 'rotation'), force);
    const frameDisabled = clip === null || frame === null;
    frameSelect.disabled = clip === null;
    frameTimeInput.disabled = clip === null;
    frameXInput.disabled = frameDisabled || fixed;
    frameYInput.disabled = frameDisabled || fixed;
    frameRotationInput.disabled = frameDisabled;
    addFrameButton.disabled = clip === null;
    replaceFrameButton.disabled = frame === null;
    deleteFrameButton.disabled = frame === null || clip?.frames.length === 1;
    applyFramePoseButton.disabled = frame === null || bone === null;
    clearFramePoseButton.disabled = frame === null || bone === null || selectedFramePose === null;
    previewModeSelect.disabled = previewDisabled || skeleton === null;
    previewConstraintsSelect.disabled = previewDisabled || skeleton === null || previewMode === 'live';
    previewLiveButton.disabled = !spritesEnabled || snapshot.preview === null && !snapshot.directionalPreview;
    if (previewModeSelect.value !== previewMode) previewModeSelect.value = previewMode;
    if (previewConstraintsSelect.value !== previewConstraints) previewConstraintsSelect.value = previewConstraints;
    previewTimeControl.input.disabled = previewDisabled || previewMode !== 'clip' || clip === null;

    ikGroup.disabled = skeleton === null;
    const blankBones = buildBoneOptions(skeleton, 'Select a bone');
    syncSelectOptions(ikSelect, skeleton === null || skeleton.ik.length === 0
      ? [{ value: '', label: 'No IK constraints yet' }]
      : skeleton.ik.map(entry => ({ value: entry.id, label: `${entry.upper} → ${entry.hand}` })));
    if (ikSelect.value !== (selectedIkId ?? '')) ikSelect.value = selectedIkId ?? '';
    setText(ikId, ik?.id ?? '—');
    syncSelectOptions(ikUpperSelect, blankBones);
    syncSelectOptions(ikLowerSelect, blankBones);
    syncSelectOptions(ikHandSelect, blankBones);
    if (ik !== null) {
      if (ikUpperSelect.value !== ik.upper) ikUpperSelect.value = ik.upper;
      if (ikLowerSelect.value !== ik.lower) ikLowerSelect.value = ik.lower;
      if (ikHandSelect.value !== ik.hand) ikHandSelect.value = ik.hand;
      if (ikTargetSelect.value !== ik.target) ikTargetSelect.value = ik.target;
      if (ikBendSelect.value !== String(ik.bend)) ikBendSelect.value = String(ik.bend);
      setNumberInputValue(ikMixInput, ik.mix, force);
      setNumberInputValue(ikOffsetXInput, ik.offsetX, force);
      setNumberInputValue(ikOffsetYInput, ik.offsetY, force);
      setNumberInputValue(ikRotationInput, ik.handRotation, force);
    } else if (skeleton !== null && skeleton.bones.length > 0 && force) {
      const suggestedUpper = selectedBoneId ?? skeleton.bones[0].id;
      const lower = skeleton.bones.find(item => item.parent === suggestedUpper) ?? skeleton.bones[1] ?? skeleton.bones[0];
      const hand = skeleton.bones.find(item => item.parent === lower.id) ?? skeleton.bones[2] ?? lower;
      ikUpperSelect.value = suggestedUpper;
      ikLowerSelect.value = lower.id;
      ikHandSelect.value = hand.id;
      if (options.targetIds[0] !== undefined) ikTargetSelect.value = options.targetIds[0];
      ikBendSelect.value = '1';
      setNumberInputValue(ikMixInput, 1, true);
      setNumberInputValue(ikOffsetXInput, 0, true);
      setNumberInputValue(ikOffsetYInput, 0, true);
      setNumberInputValue(ikRotationInput, 0, true);
    }
    addIkButton.disabled = skeleton === null || skeleton.ik.length >= SKELETON_LIMITS.ik;
    applyIkButton.disabled = ik === null;
    deleteIkButton.disabled = ik === null;

    hairGroup.disabled = skeleton === null;
    syncSelectOptions(hairSelect, skeleton === null || skeleton.hair.length === 0
      ? [{ value: '', label: 'No hair chains yet' }]
      : skeleton.hair.map(entry => ({ value: entry.id, label: `${entry.bones[0]} → ${entry.bones[entry.bones.length - 1]}` })));
    if (hairSelect.value !== (selectedHairId ?? '')) hairSelect.value = selectedHairId ?? '';
    setText(hairId, hair?.id ?? '—');
    syncSelectOptions(hairRootSelect, blankBones);
    syncSelectOptions(hairTipSelect, blankBones);
    if (hair !== null) {
      if (hairRootSelect.value !== hair.bones[0]) hairRootSelect.value = hair.bones[0];
      if (hairTipSelect.value !== hair.bones[hair.bones.length - 1]) hairTipSelect.value = hair.bones[hair.bones.length - 1];
      setNumberInputValue(hairStiffnessInput, hair.stiffness, force);
      setNumberInputValue(hairDampingInput, hair.damping, force);
      setNumberInputValue(hairGravityInput, hair.gravity, force);
      setNumberInputValue(hairRadiusInput, hair.radius, force);
      setText(hairSummary, `${hair.bones.length} contiguous bone${hair.bones.length === 1 ? '' : 's'} in this chain.`);
    } else {
      if (force && selectedBoneId !== null) {
        hairRootSelect.value = selectedBoneId;
        hairTipSelect.value = selectedBoneId;
      }
      setNumberInputValue(hairStiffnessInput, 0.7, force);
      setNumberInputValue(hairDampingInput, 0.2, force);
      setNumberInputValue(hairGravityInput, DEFAULT_HAIR_GRAVITY, force);
      setNumberInputValue(hairRadiusInput, 0.12, force);
      setText(hairSummary, 'Choose a root and tip. The chain follows parent links between them.');
    }
    addHairButton.disabled = skeleton === null || skeleton.hair.length >= SKELETON_LIMITS.hair;
    applyHairButton.disabled = hair === null;
    deleteHairButton.disabled = hair === null;

    colliderGroup.disabled = skeleton === null;
    syncSelectOptions(colliderSelect, skeleton === null || skeleton.colliders.length === 0
      ? [{ value: '', label: 'No colliders yet' }]
      : skeleton.colliders.map(entry => ({ value: entry.id, label: `${entry.bone} (${entry.radius.toFixed(2)})` })));
    if (colliderSelect.value !== (selectedColliderId ?? '')) colliderSelect.value = selectedColliderId ?? '';
    setText(colliderId, collider?.id ?? '—');
    syncSelectOptions(colliderBoneSelect, blankBones);
    if (collider !== null) {
      if (colliderBoneSelect.value !== collider.bone) colliderBoneSelect.value = collider.bone;
      setNumberInputValue(colliderRadiusInput, collider.radius, force);
      setNumberInputValue(colliderXInput, collider.x, force);
      setNumberInputValue(colliderYInput, collider.y, force);
    } else {
      if (force && selectedBoneId !== null) colliderBoneSelect.value = selectedBoneId;
      setNumberInputValue(colliderRadiusInput, 0.18, force);
      setNumberInputValue(colliderXInput, 0, force);
      setNumberInputValue(colliderYInput, 0, force);
    }
    addColliderButton.disabled = skeleton === null || skeleton.colliders.length >= SKELETON_LIMITS.colliders;
    applyColliderButton.disabled = collider === null;
    deleteColliderButton.disabled = collider === null;
  }

  createButton.addEventListener('click', () => withUiErrors(() => {
    const id = 'bone-1';
    const anchor = anchorSelect.value;
    clearMessage();
    if (!state.apply(commands.skeleton((current) => {
      if (current !== null) throw new SpriteError('The character already has a skeleton.');
      return {
        anchor,
        bones: [{ id, name: 'Bone 1', parent: null, x: 0, y: 0, rotation: 0, length: DEFAULT_BONE_LENGTH }],
        poses: [],
        clips: [],
        animation: null,
        ik: [],
        hair: [],
        colliders: [],
      };
    }, info('Create skeleton', 'sprites-skeleton-rig', adding('bone', id))))) return;
    previewMode = 'live';
    render(true);
  }), listen);

  deleteSkeletonButton.addEventListener('click', () => withUiErrors(() => {
    const problem = skeletonDeleteProblem(state.snapshot());
    if (problem !== null) throw new UiError(problem);
    clearMessage();
    if (!state.apply(commands.skeleton(() => null,
      info('Delete skeleton', 'sprites-skeleton-rig', { before: selection('bone'), after: [] })))) return;
    previewMode = 'live';
    render(true);
  }), listen);

  anchorSelect.addEventListener('change', () => withUiErrors(() => {
    const anchor = anchorSelect.value;
    updateSkeleton('Set skeleton anchor', 'sprites-skeleton-rig', null, (draft) => { draft.anchor = anchor; });
  }), listen);

  boneSelect.addEventListener('change', () => {
    selectedBoneId = boneSelect.value || null;
    clearMessage();
    render(true);
  }, listen);

  addRootBoneButton.addEventListener('click', () => withUiErrors(() => {
    const id = nextId('bone', expectSkeleton().bones.map(item => item.id));
    updateSkeleton('Add root bone', 'sprites-skeleton-bones', adding('bone', id), (draft) => {
      draft.bones.push({ id, name: `Bone ${draft.bones.length + 1}`, parent: null, x: 0, y: 0, rotation: 0, length: DEFAULT_BONE_LENGTH });
    });
  }), listen);

  addChildBoneButton.addEventListener('click', () => withUiErrors(() => {
    const parentId = selectedBoneId;
    if (parentId === null) throw new UiError('Select a parent bone first.');
    const id = nextId('bone', expectSkeleton().bones.map(item => item.id));
    updateSkeleton('Add child bone', 'sprites-skeleton-bones', adding('bone', id), (draft) => {
      const parent = draft.bones.find(item => item.id === parentId);
      if (!parent) throw new SpriteError('The selected parent bone is missing.');
      draft.bones.push({
        id,
        name: `Bone ${draft.bones.length + 1}`,
        parent: parent.id,
        x: parent.length,
        y: 0,
        rotation: 0,
        length: Math.max(0.1, Math.min(SKELETON_LIMITS.length, parent.length * 0.75)),
      });
    });
  }), listen);

  applyBoneButton.addEventListener('click', () => withUiErrors(() => {
    const boneId = selectedBoneId;
    if (boneId === null) throw new UiError('Select a bone first.');
    const name = readText(boneNameInput, 'Bone name');
    const parent = boneParentSelect.value || null;
    const x = readNumber(boneXInput, 'Bone X');
    const y = readNumber(boneYInput, 'Bone Y');
    const length = readNumber(boneLengthInput, 'Bone length');
    const rotation = readNumber(boneRotationInput, 'Bone rotation');
    updateSkeleton(`Apply bone ${name}`, 'sprites-skeleton-bones', keeping('bone'), (draft) => {
      const index = draft.bones.findIndex(item => item.id === boneId);
      if (index < 0) throw new SpriteError('The selected bone is missing.');
      const current = draft.bones[index];
      draft.bones[index] = { ...current, name, parent, x, y, length, rotation };
      draft.bones = draft.bones.map(item => isTipAttached(item, current)
        ? { ...item, x: length, y: 0 }
        : item);
    });
  }), listen);

  deleteBoneButton.addEventListener('click', () => withUiErrors(() => {
    const snapshot = state.snapshot();
    const skeleton = expectSkeleton();
    const boneId = selectedBoneId;
    if (boneId === null) throw new UiError('Select a bone first.');
    const problem = boneDeleteProblem(snapshot, skeleton, boneId);
    if (problem !== null) throw new UiError(problem);
    const name = skeleton.bones.find(item => item.id === boneId)?.name ?? boneId;
    updateSkeleton(`Delete bone ${name}`, 'sprites-skeleton-bones', deleting('bone', skeleton.bones, boneId), (draft) => {
      draft.bones = draft.bones.filter(item => item.id !== boneId);
    });
  }), listen);

  diagram.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const group = target.closest<SVGGElement>('g[data-bone-id]');
    if (!group) return;
    selectedBoneId = group.dataset.boneId ?? null;
    clearMessage();
    render(true);
  }, listen);

  // The selected layer, and a skeleton when its rigging needs one.
  function rigLayer(needsSkeleton: string | null): SpriteLayer {
    const snapshot = state.snapshot();
    const layer = selectedLayer(snapshot);
    if (layer === null) throw new UiError('Select a sprite layer first.');
    if (needsSkeleton !== null && snapshot.document.skeleton === null) throw new UiError(needsSkeleton);
    return layer;
  }

  function editLayer(layer: SpriteLayer, label: string, edit: SpriteLayerEdit, select?: Selection): void {
    clearMessage();
    if (state.apply(commands.layer(layer.id, edit, layerInfo(label, layer.id, select)))) applied();
  }

  applyRigidButton.addEventListener('click', () => withUiErrors(() => {
    const layer = rigLayer('Create a skeleton before binding a bone.');
    editLayer(layer, 'Bind layer to bone', { bone: layerBoneSelect.value || null, skin: null });
  }), listen);

  tileToggle.addEventListener('change', () => {
    tileLengthInput.disabled = !tileToggle.checked || layerGroup.disabled;
  }, listen);

  applyTileButton.addEventListener('click', () => withUiErrors(() => {
    const layer = rigLayer(null);
    if (layer.skin !== null) throw new UiError('Turn off mesh binding before using tile mode.');
    editLayer(layer, 'Apply tile', { tileLength: tileToggle.checked ? readNumber(tileLengthInput, 'Tile length') : null });
  }), listen);

  for (const direction of FACING_DIRECTIONS) {
    directionInputs.get(direction)?.addEventListener('change', () => {
      const layer = selectedLayer(state.snapshot());
      if (layer === null) return;
      const directions = FACING_DIRECTIONS.filter(entry => directionInputs.get(entry)?.checked === true);
      if (directions.length === 0) {
        directionInputs.get(direction)!.checked = true;
        setMessage('Each layer must stay visible in at least one facing direction.');
        render();
        return;
      }
      editLayer(layer, 'Set visible directions', { directions });
    }, listen);
  }

  meshBonesSelect.addEventListener('change', () => {
    meshBoneSelection = new Set(Array.from(meshBonesSelect.selectedOptions, option => option.value));
    clearMessage();
  }, listen);

  bindMeshButton.addEventListener('click', () => withUiErrors(() => {
    const layer = rigLayer('Create a skeleton before binding a mesh.');
    if (meshBoneSelection === null || meshBoneSelection.size === 0) throw new UiError('Choose at least one influencing bone.');
    const columns = readInteger(meshColumnsInput, 'Mesh columns');
    const rows = readInteger(meshRowsInput, 'Mesh rows');
    clearMessage();
    const select = { before: selection('vertex'), after: [selectionEntry('vertex', '0')] };
    const bind = { columns, rows, bones: [...meshBoneSelection] };
    if (!state.apply(commands.bindMesh(layer.id, bind, layerInfo('Bind mesh', layer.id, select)))) return;
    applied();
  }), listen);

  switchRigidButton.addEventListener('click', () => withUiErrors(() => {
    const layer = rigLayer('Create a skeleton before switching bindings.');
    editLayer(layer, 'Switch back to rigid', { skin: null, bone: layerBoneSelect.value || null });
  }), listen);

  weightVertexSelect.addEventListener('change', () => {
    selectedVertexIndex = Number.parseInt(weightVertexSelect.value, 10) || 0;
    clearMessage();
    render(true);
  }, listen);

  applyWeightsButton.addEventListener('click', () => withUiErrors(() => {
    const layer = rigLayer(null);
    if (layer.skin === null) throw new UiError('Bind a mesh before editing weights.');
    const influences = weightRows.flatMap(row => {
      if (row.bone.value === '') return [];
      return [{ bone: row.bone.value, weight: readNumber(row.weight, 'Weight value') }];
    });
    const weights = layer.skin.weights.map(entry => entry.map(weight => ({ ...weight })));
    weights[selectedVertexIndex] = influences;
    const skin: SpriteSkin = validateSkin({ ...layer.skin, weights });
    editLayer(layer, 'Apply vertex weights', { skin, bone: null, tileLength: null }, keeping('vertex'));
  }), listen);

  directionSelect.addEventListener('change', () => {
    selectedDirection = validateDirection(directionSelect.value);
    clearMessage();
    render(true);
    if (previewMode !== 'live') applyPreview();
  }, listen);

  // Offsets this bone may hold; tip-attached IK and hair bones only rotate.
  function offset(draft: MutableSkeleton, boneId: string, x: number, y: number, rotation: number, where: string): BonePose | null {
    if (fixedJointIds(draft).has(boneId) && (Math.abs(x) > JOINT_EPSILON || Math.abs(y) > JOINT_EPSILON)) {
      throw new SpriteError(`Tip-attached IK and hair bones may rotate, but cannot translate in ${where}.`);
    }
    return Math.abs(x) <= JOINT_EPSILON && Math.abs(y) <= JOINT_EPSILON && Math.abs(rotation) <= JOINT_EPSILON
      ? null
      : { bone: boneId, x, y, rotation };
  }

  // The selected clip of the draft, as the step runs.
  function draftClip(draft: MutableSkeleton, clipId: string | null): MutableSkeleton['clips'][number] {
    const clip = draft.clips.find(entry => entry.id === clipId);
    if (!clip) throw new SpriteError('The selected clip is missing.');
    return clip;
  }

  applyPoseButton.addEventListener('click', () => withUiErrors(() => {
    const boneId = selectedBoneId;
    if (boneId === null) throw new UiError('Select a bone first.');
    const direction = selectedDirection;
    const x = readNumber(poseXInput, 'Directional offset X');
    const y = readNumber(poseYInput, 'Directional offset Y');
    const rotation = readNumber(poseRotationInput, 'Directional rotation');
    updateSkeleton('Apply directional offset', 'sprites-skeleton-pose', keeping('bone', 'direction'), (draft) => {
      const value = offset(draft, boneId, x, y, rotation, 'saved poses');
      const index = draft.poses.findIndex(entry => entry.direction === direction);
      if (index < 0) {
        if (value !== null) draft.poses = [...draft.poses, { direction, pose: [value] }];
      } else {
        const pose = upsertPose(draft.poses[index].pose, boneId, value);
        if (pose.length === 0) draft.poses = draft.poses.filter((_, entryIndex) => entryIndex !== index);
        else draft.poses[index] = { direction, pose };
      }
      draft.poses = sortDirectionalPoses(draft.poses);
    });
  }), listen);

  clearPoseButton.addEventListener('click', () => withUiErrors(() => {
    const boneId = selectedBoneId;
    if (boneId === null) throw new UiError('Select a bone first.');
    const direction = selectedDirection;
    updateSkeleton('Clear directional offset', 'sprites-skeleton-pose', keeping('bone', 'direction'), (draft) => {
      const index = draft.poses.findIndex(entry => entry.direction === direction);
      if (index < 0) return;
      const pose = upsertPose(draft.poses[index].pose, boneId, null);
      if (pose.length === 0) draft.poses = draft.poses.filter((_, entryIndex) => entryIndex !== index);
      else draft.poses[index] = { direction, pose };
    });
  }), listen);

  defaultClipSelect.addEventListener('change', () => withUiErrors(() => {
    const animation = defaultClipSelect.value || null;
    updateSkeleton('Set default clip', 'sprites-skeleton-animation', null, (draft) => { draft.animation = animation; });
  }), listen);

  clipSelect.addEventListener('change', () => {
    selectedClipId = clipSelect.value || null;
    clearMessage();
    if (previewMode === 'clip' || previewMode === 'frame') applyPreview();
    render(true);
  }, listen);

  addClipButton.addEventListener('click', () => withUiErrors(() => {
    const duration = readNumber(clipDurationInput, 'Clip duration');
    const name = readText(clipNameInput, 'Clip name');
    const loop = clipLoopInput.checked;
    const id = nextId('clip', expectSkeleton().clips.map(item => item.id));
    updateSkeleton(`Add clip ${name}`, 'sprites-skeleton-animation', framing(id, 0), (draft) => {
      draft.clips.push({ id, name, duration, loop, frames: [{ time: 0, pose: [] }] });
    }, () => { previewTimeControl.setValue(0, { disabled: previewMode !== 'clip' }); });
  }), listen);

  applyClipButton.addEventListener('click', () => withUiErrors(() => {
    const clipId = selectedClipId;
    if (clipId === null) throw new UiError('Select a clip first.');
    const duration = readNumber(clipDurationInput, 'Clip duration');
    const name = readText(clipNameInput, 'Clip name');
    const loop = clipLoopInput.checked;
    updateSkeleton(`Apply clip ${name}`, 'sprites-skeleton-animation', keeping('clip'), (draft) => {
      const clip = draftClip(draft, clipId);
      if (clip.frames.some(frame => frame.time > duration)) {
        throw new SpriteError('Existing keyframe times must stay within the clip duration.');
      }
      clip.name = name;
      clip.duration = duration;
      clip.loop = loop;
    });
  }), listen);

  deleteClipButton.addEventListener('click', () => withUiErrors(() => {
    const clipId = selectedClipId;
    if (clipId === null) throw new UiError('Select a clip first.');
    const skeleton = expectSkeleton();
    const name = skeleton.clips.find(entry => entry.id === clipId)?.name ?? clipId;
    // Undo selects the clip's keyframe again as well.
    const select = { ...deleting('clip', skeleton.clips, clipId), before: selection('clip', 'keyframe') };
    updateSkeleton(`Delete clip ${name}`, 'sprites-skeleton-animation', select, (draft) => {
      draftClip(draft, clipId);
      draft.clips = draft.clips.filter(entry => entry.id !== clipId);
      if (draft.animation === clipId) draft.animation = null;
    }, () => { if (previewMode === 'clip' || previewMode === 'frame') previewMode = 'live'; });
  }), listen);

  frameSelect.addEventListener('change', () => {
    if (selectedClipId !== null) selectedFrameIndexByClip.set(selectedClipId, Number.parseInt(frameSelect.value, 10) || 0);
    clearMessage();
    render(true);
    if (previewMode === 'frame') applyPreview();
  }, listen);

  // The keyframe times of clip `clipId`, in order; none when the clip has gone, which its step then refuses.
  function frameTimes(clipId: string): number[] {
    return expectSkeleton().clips.find(entry => entry.id === clipId)?.frames.map(entry => entry.time) ?? [];
  }

  // A keyframe step's selection: the clip's keyframe selected now, then the one at `index`.
  function framing(clipId: string, index: number): Selection {
    const after = [selectionEntry('clip', clipId), selectionEntry('keyframe', String(index))];
    return { before: selection('clip', 'keyframe'), after };
  }

  addFrameButton.addEventListener('click', () => withUiErrors(() => {
    const clipId = selectedClipId;
    if (clipId === null) throw new UiError('Select a clip first.');
    const time = readNumber(frameTimeInput, 'Keyframe time');
    const sourceIndex = selectedFrameIndexByClip.get(clipId) ?? 0;
    const index = [...frameTimes(clipId), time].sort((left, right) => left - right)
      .findIndex(entry => Math.abs(entry - time) <= JOINT_EPSILON);
    updateSkeleton('Add keyframe', 'sprites-skeleton-animation', framing(clipId, index), (draft) => {
      const clip = draftClip(draft, clipId);
      if (clip.frames.some(entry => Math.abs(entry.time - time) <= JOINT_EPSILON)) {
        throw new SpriteError('This clip already has a keyframe at that time. Use Replace keyframe instead.');
      }
      const source = clip.frames[sourceIndex] ?? clip.frames[0];
      clip.frames = [...clip.frames, { time, pose: source ? clonePose(source.pose) : [] }].sort((left, right) => left.time - right.time);
    });
  }), listen);

  replaceFrameButton.addEventListener('click', () => withUiErrors(() => {
    const clipId = selectedClipId;
    if (clipId === null) throw new UiError('Select a clip first.');
    const time = readNumber(frameTimeInput, 'Keyframe time');
    const at = selectedFrameIndexByClip.get(clipId) ?? 0;
    const index = frameTimes(clipId).map((entry, entryIndex) => entryIndex === at ? time : entry).sort((left, right) => left - right)
      .findIndex(entry => Math.abs(entry - time) <= JOINT_EPSILON);
    updateSkeleton('Replace keyframe', 'sprites-skeleton-animation', framing(clipId, index), (draft) => {
      const clip = draftClip(draft, clipId);
      const current = clip.frames[at];
      if (!current) throw new SpriteError('The selected keyframe is missing.');
      if (clip.frames.some((entry, entryIndex) => entryIndex !== at && Math.abs(entry.time - time) <= JOINT_EPSILON)) {
        throw new SpriteError('Another keyframe already uses that time.');
      }
      current.time = time;
      clip.frames = [...clip.frames].sort((left, right) => left.time - right.time);
    });
  }), listen);

  deleteFrameButton.addEventListener('click', () => withUiErrors(() => {
    const clipId = selectedClipId;
    if (clipId === null) throw new UiError('Select a clip first.');
    const at = selectedFrameIndexByClip.get(clipId) ?? 0;
    const index = Math.max(0, Math.min(at, frameTimes(clipId).length - 2));
    updateSkeleton('Delete keyframe', 'sprites-skeleton-animation', framing(clipId, index), (draft) => {
      const clip = draftClip(draft, clipId);
      if (clip.frames.length <= 1) throw new SpriteError('A clip must keep at least one keyframe.');
      clip.frames = clip.frames.filter((_, frameIndex) => frameIndex !== at);
    });
  }), listen);

  applyFramePoseButton.addEventListener('click', () => withUiErrors(() => {
    const boneId = selectedBoneId;
    if (boneId === null) throw new UiError('Select a bone first.');
    const clipId = selectedClipId;
    if (clipId === null) throw new UiError('Select a clip first.');
    const at = selectedFrameIndexByClip.get(clipId) ?? 0;
    const x = readNumber(frameXInput, 'Keyframe offset X');
    const y = readNumber(frameYInput, 'Keyframe offset Y');
    const rotation = readNumber(frameRotationInput, 'Bone rotation');
    updateSkeleton('Apply keyframe offset', 'sprites-skeleton-animation', keeping('bone', 'clip', 'keyframe'), (draft) => {
      const frame = draftClip(draft, clipId).frames[at];
      if (!frame) throw new SpriteError('The selected keyframe is missing.');
      frame.pose = upsertPose(frame.pose, boneId, offset(draft, boneId, x, y, rotation, 'keyframes'));
    });
  }), listen);

  clearFramePoseButton.addEventListener('click', () => withUiErrors(() => {
    const boneId = selectedBoneId;
    if (boneId === null) throw new UiError('Select a bone first.');
    const clipId = selectedClipId;
    if (clipId === null) throw new UiError('Select a clip first.');
    const at = selectedFrameIndexByClip.get(clipId) ?? 0;
    updateSkeleton('Clear keyframe offset', 'sprites-skeleton-animation', keeping('bone', 'clip', 'keyframe'), (draft) => {
      const frame = draftClip(draft, clipId).frames[at];
      if (!frame) throw new SpriteError('The selected keyframe is missing.');
      frame.pose = upsertPose(frame.pose, boneId, null);
    });
  }), listen);

  previewModeSelect.addEventListener('change', () => withUiErrors(() => {
    const value = previewModeSelect.value;
    if (value !== 'live' && value !== 'direction' && value !== 'clip' && value !== 'frame') throw new UiError('Choose a valid preview mode.');
    previewMode = value;
    clearMessage();
    if (previewMode === 'live') state.setPreview(null);
    else applyPreview();
    render();
  }), listen);

  previewConstraintsSelect.addEventListener('change', () => {
    const value = previewConstraintsSelect.value;
    if (value !== 'disabled' && value !== 'enabled') throw new Error('Unknown constraint preview mode.');
    previewConstraints = value;
    clearMessage();
    if (previewMode !== 'live') applyPreview();
  }, listen);

  previewLiveButton.addEventListener('click', () => {
    clearMessage();
    previewMode = 'live';
    state.setPreview(null);
    render();
  }, listen);

  ikSelect.addEventListener('change', () => {
    selectedIkId = ikSelect.value || null;
    clearMessage();
    render(true);
  }, listen);

  const readIk = (): Omit<MutableSkeleton['ik'][number], 'id'> => ({
    upper: ikUpperSelect.value,
    lower: ikLowerSelect.value,
    hand: ikHandSelect.value,
    target: ikTargetSelect.value,
    bend: ikBendSelect.value === '-1' ? -1 : 1,
    mix: readNumber(ikMixInput, 'IK mix'),
    offsetX: readNumber(ikOffsetXInput, 'Grip offset X'),
    offsetY: readNumber(ikOffsetYInput, 'Grip offset Y'),
    handRotation: readNumber(ikRotationInput, 'Wrist rotation'),
  });

  addIkButton.addEventListener('click', () => withUiErrors(() => {
    const value = readIk();
    const id = nextId('ik', expectSkeleton().ik.map(entry => entry.id));
    updateSkeleton('Add IK', 'sprites-skeleton-ik', adding('ik', id), (draft) => {
      draft.ik.push({ ...value, id });
    });
  }), listen);

  applyIkButton.addEventListener('click', () => withUiErrors(() => {
    const ikId = selectedIkId;
    if (ikId === null) throw new UiError('Select an IK constraint first.');
    const value = readIk();
    updateSkeleton('Apply IK', 'sprites-skeleton-ik', keeping('ik'), (draft) => {
      const index = draft.ik.findIndex(entry => entry.id === ikId);
      if (index < 0) throw new SpriteError('The selected IK constraint is missing.');
      draft.ik[index] = { ...draft.ik[index], ...value };
    });
  }), listen);

  deleteIkButton.addEventListener('click', () => withUiErrors(() => {
    const ikId = selectedIkId;
    updateSkeleton('Delete IK', 'sprites-skeleton-ik', deleting('ik', expectSkeleton().ik, ikId), (draft) => {
      draft.ik = draft.ik.filter(entry => entry.id !== ikId);
    });
  }), listen);

  hairSelect.addEventListener('change', () => {
    selectedHairId = hairSelect.value || null;
    clearMessage();
    render(true);
  }, listen);

  // The chain from the chosen root to the chosen tip, through the bones' parent links as the step finds them.
  const readHairChain = (): ((draft: MutableSkeleton) => Omit<MutableSkeleton['hair'][number], 'id'>) => {
    const rootBone = hairRootSelect.value;
    const tipBone = hairTipSelect.value;
    const stiffness = readNumber(hairStiffnessInput, 'Hair stiffness');
    const damping = readNumber(hairDampingInput, 'Hair damping');
    const gravity = readNumber(hairGravityInput, 'Hair gravity');
    const radius = readNumber(hairRadiusInput, 'Collision radius');
    return (draft) => {
      const bones = pathFromRootToTip(draft, rootBone, tipBone);
      if (bones === null) throw new SpriteError('Hair tip must descend from the chosen hair root through parent links.');
      return { bones: [...bones], stiffness, damping, gravity, radius };
    };
  };

  addHairButton.addEventListener('click', () => withUiErrors(() => {
    const chain = readHairChain();
    const id = nextId('hair', expectSkeleton().hair.map(entry => entry.id));
    updateSkeleton('Add hair', 'sprites-skeleton-hair', adding('hair', id), (draft) => {
      draft.hair.push({ ...chain(draft), id });
    });
  }), listen);

  applyHairButton.addEventListener('click', () => withUiErrors(() => {
    const hairId = selectedHairId;
    if (hairId === null) throw new UiError('Select a hair chain first.');
    const chain = readHairChain();
    updateSkeleton('Apply hair', 'sprites-skeleton-hair', keeping('hair'), (draft) => {
      const index = draft.hair.findIndex(entry => entry.id === hairId);
      if (index < 0) throw new SpriteError('The selected hair chain is missing.');
      draft.hair[index] = { ...chain(draft), id: hairId };
    });
  }), listen);

  deleteHairButton.addEventListener('click', () => withUiErrors(() => {
    const hairId = selectedHairId;
    updateSkeleton('Delete hair', 'sprites-skeleton-hair', deleting('hair', expectSkeleton().hair, hairId), (draft) => {
      draft.hair = draft.hair.filter(entry => entry.id !== hairId);
    });
  }), listen);

  colliderSelect.addEventListener('change', () => {
    selectedColliderId = colliderSelect.value || null;
    clearMessage();
    render(true);
  }, listen);

  const readCollider = (): Omit<MutableSkeleton['colliders'][number], 'id'> => ({
    bone: colliderBoneSelect.value,
    x: readNumber(colliderXInput, 'Collider offset X'),
    y: readNumber(colliderYInput, 'Collider offset Y'),
    radius: readNumber(colliderRadiusInput, 'Collider radius'),
  });

  addColliderButton.addEventListener('click', () => withUiErrors(() => {
    const value = readCollider();
    const id = nextId('collider', expectSkeleton().colliders.map(entry => entry.id));
    updateSkeleton('Add collider', 'sprites-skeleton-colliders', adding('collider', id), (draft) => {
      draft.colliders.push({ ...value, id });
    });
  }), listen);

  applyColliderButton.addEventListener('click', () => withUiErrors(() => {
    const colliderId = selectedColliderId;
    if (colliderId === null) throw new UiError('Select a collider first.');
    const value = readCollider();
    updateSkeleton('Apply collider', 'sprites-skeleton-colliders', keeping('collider'), (draft) => {
      const index = draft.colliders.findIndex(entry => entry.id === colliderId);
      if (index < 0) throw new SpriteError('The selected collider is missing.');
      draft.colliders[index] = { ...value, id: colliderId };
    });
  }), listen);

  deleteColliderButton.addEventListener('click', () => withUiErrors(() => {
    const colliderId = selectedColliderId;
    updateSkeleton('Delete collider', 'sprites-skeleton-colliders', deleting('collider', expectSkeleton().colliders, colliderId), (draft) => {
      draft.colliders = draft.colliders.filter(entry => entry.id !== colliderId);
    });
  }), listen);

  // Each Sprites step's event carries the selection it recorded: Undo takes up the one before it, Redo and the step
  // itself the one after.
  const unsubscribe = state.subscribe((event) => {
    const select = event.step?.place.tab === 'sprites' ? event.step.place.select : null;
    if (select !== null && event.cause !== null) restore(event.cause === 'undo' ? select.before : select.after);
    render(false);
  });
  options.signal.addEventListener('abort', () => dispose(), { once: true, signal: events.signal });
  options.mount.append(root);
  render(true);

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    unsubscribe();
    events.abort();
    root.remove();
  }

  return { dispose };
}
