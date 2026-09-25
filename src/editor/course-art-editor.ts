import { ART_LIMITS, ArtError, artId, artRecord, validateArtCatalog } from '../art-types';
import type { ArtCatalog, ArtResource, ArtVariant, TerrainArt } from '../art-types';
import { embeddedGlb, validateCoursePackage } from '../course-package';
import type { CoursePackage } from '../course-package';
import type { CourseArtView } from '../course-art-view';
import { validateCourseModel } from '../course-art-model';
import { element } from '../dom';
import { LevelError } from '../level';
import type { LevelDefinition, LevelObject, TerrainObject } from '../level';
import { fetchModelBlob, modelAssetId, ModelError } from '../model-data';
import { artRequest } from './art-client';
import { ArtPreview, terrainGuide } from './art-preview';
import { createJsonDownload } from './json-download';
import type { LevelState } from './level-state';
import type { SetPiece } from './set-pieces';

interface Job {
  id: string; name: string; status: string; task_id: string | null; progress: number; asset_id: string | null; error: string | null;
}

function jobsFrom(value: unknown): Job[] {
  if (!Array.isArray(value) || value.length > 40) throw new ArtError('The shared job list is invalid.');
  return value.map((entry) => {
    const job = artRecord(entry, 'Generation job');
    if (typeof job.id !== 'string' || typeof job.name !== 'string' || typeof job.status !== 'string' ||
      typeof job.progress !== 'number' || !Number.isFinite(job.progress) ||
      !(job.task_id === null || typeof job.task_id === 'string') ||
      !(job.asset_id === null || typeof job.asset_id === 'string') ||
      !(job.error === null || typeof job.error === 'string')) throw new ArtError('Invalid generation job.');
    return {
      id: job.id, name: job.name, status: job.status, progress: job.progress, task_id: job.task_id,
      asset_id: job.asset_id === null ? null : artId(job.asset_id), error: job.error,
    };
  });
}

function options(select: HTMLSelectElement, choices: readonly { value: string; label: string }[], selected: string): void {
  select.replaceChildren(...choices.map((choice) => new Option(choice.label, choice.value)));
  select.value = choices.some((choice) => choice.value === selected) ? selected : choices[0]?.value ?? '';
}

function assign(object: TerrainObject, assetId: string | null, mirror: TerrainArt['mirror'] = 'none'): TerrainObject {
  const { art: _previous, ...shape } = object;
  return assetId === null ? shape : { ...shape, art: { assetId, mirror } };
}

export function createCourseArtEditor(settings: {
  mount: HTMLElement;
  prefabMount: HTMLElement;
  objectMount: HTMLElement;
  level: LevelState;
  view: CourseArtView;
  onNotice: (message: string, kind: 'info' | 'error') => void;
  onImport: (definition: LevelDefinition) => boolean;
  onDebug: () => void;
  prepareExport: () => boolean;
}) {
  const { level, view, onNotice } = settings;
  const lifetime = new AbortController();
  const listen = { signal: lifetime.signal };
  const download = createJsonDownload({ mount: settings.mount, signal: lifetime.signal });
  const root = settings.mount;
  root.innerHTML = `
    <fieldset class="tuning-group course-art">
      <legend>Shared course artwork</legend>
      <p class="level-help">Everyone signed in to this editor can reuse the shared library. Your Tripo key and jobs are private.
        Generation never changes collision geometry. Unassigned objects keep their editor shapes.</p>
      <button type="button" class="button art-refresh">Connect / refresh shared library</button>
      <p class="level-help art-status" role="status" aria-live="polite">Library not connected.</p>
      <details class="art-connection">
        <summary>My Tripo API connection</summary>
        <p class="level-help">Studio subscription credits do not include API credits. The host encrypts your API key.
          Never put it in a level, prompt, or exported file.</p>
        <label class="level-field">Tripo API key<input class="art-key" type="password" autocomplete="off" maxlength="256" /></label>
        <div class="level-action-row">
          <button type="button" class="button art-connect">Connect Tripo key</button>
          <button type="button" class="button art-disconnect">Disconnect my key</button>
        </div>
      </details>
      <label class="level-field">Saved shared asset<select class="art-assets" aria-label="Saved shared asset"></select></label>
      <div class="level-action-row">
        <button type="button" class="button art-preview">Preview saved asset</button>
        <button type="button" class="button art-upload">Share an existing GLB</button>
      </div>
      <input type="file" class="art-glb-file" accept=".glb,model/gltf-binary" hidden />
      <canvas class="art-preview-canvas" width="320" height="200" aria-label="Selected artwork preview" hidden></canvas>
      <p class="level-help">Assets are immutable and reused by reference. Sharing the same GLB again reuses the existing asset.
        Static GLBs only: 20 MiB, 16 meshes, 50,000 triangles, embedded PNG/JPEG/WebP textures up to 4096 pixels.</p>
      <details class="art-generation">
        <summary>Generate a new asset with Tripo</summary>
        <label class="level-field">Generation target<select class="art-target">
          <option value="object">Selected terrain object</option><option value="prefab">Chosen prefab part</option>
        </select></label>
        <label class="level-field art-part-field">Prefab terrain part<select class="art-target-part"></select></label>
        <p class="level-help art-target-description"></p>
        <label class="level-field">Asset name<input class="art-name" maxlength="80" /></label>
        <label class="level-field">Generation method<select class="art-kind">
          <option value="texture">Texture the exact editor shape (recommended)</option>
          <option value="mesh">Generate a new low-poly 3D mesh</option>
        </select></label>
        <label class="level-field">Art prompt<textarea class="art-prompt" rows="4" maxlength="1024"></textarea></label>
        <details><summary>Exact prompt sent to Tripo</summary><pre class="art-request-prompt"></pre></details>
        <div class="level-field-grid">
          <label class="level-field">Seed<input class="art-seed" type="number" min="0" max="2147483647" step="1" value="1" /></label>
          <label class="level-field art-faces-field">Mesh polygon limit<input class="art-faces" type="number" min="150" max="20000" step="1" value="3000" /></label>
        </div>
        <p class="level-help">Only this target is submitted, never the whole course. New meshes are fitted to the object's bounds
          but may not match its gripping edges. Inspect the collision overlay before using them.
          Tripo sets the credit price; this editor does not promise a fixed cost.</p>
        <label class="level-checkbox"><input class="art-consent" type="checkbox" />
          I approve spending my API credits and sending this prompt/shape to Tripo. The result will be shared here.</label>
        <button type="button" class="button button-primary art-generate">Generate this asset</button>
      </details>
      <div class="art-jobs" aria-label="My generation jobs" aria-live="polite"></div>
      <label class="level-field">Editor preview<select class="art-mode">
        <option value="shapes">Editor shapes</option><option value="meshes">Saved meshes (2.5D)</option>
      </select></label>
      <button type="button" class="button art-debug">Toggle collision overlay</button>
      <label class="level-field">Built game artwork<select class="art-release-mode">
        <option value="shapes">Editor shapes</option><option value="meshes">Saved meshes (2.5D)</option>
      </select></label>
      <div class="level-action-row">
        <button type="button" class="button art-export">Export course + artwork</button>
        <button type="button" class="button art-import">Import course + share artwork</button>
      </div>
      <input type="file" class="art-package-file" accept=".json,application/json" hidden />
      <p class="level-help">Course packages embed referenced GLBs and the chosen release look. Build with
        GAME_LEVEL=course.json. The playable game needs no account, editor, Tripo, or shared-library connection.</p>
    </fieldset>`;
  settings.prefabMount.innerHTML = `
    <label class="level-field">Ready-made artwork<select class="art-prefab-variant" aria-label="Ready-made artwork"></select></label>
    <p class="level-help">Choose editor shapes or a saved variant before placing. Choosing artwork never generates or charges anything.</p>
    <details class="art-prefab-edit"><summary>Choose artwork for individual parts / save a variant</summary>
      <div class="art-prefab-parts"></div>
      <label class="level-field">New variant name<input class="art-variant-name" maxlength="80" /></label>
      <button type="button" class="button art-save-variant">Publish prefab variant</button>
    </details>`;
  settings.objectMount.innerHTML = `
    <label class="level-field">Object artwork<select class="art-object-asset" aria-label="Object artwork"></select></label>
    <button type="button" class="button art-assign">Apply artwork to this object</button>
    <p class="level-help">Uses a saved asset without generating. Width, height and depth fit the mesh; physics stays unchanged.</p>`;
  const control = <T extends HTMLElement = HTMLElement>(selector: string) => element<T>(root, selector);
  const select = (selector: string) => control<HTMLSelectElement>(selector);
  const input = (selector: string) => control<HTMLInputElement>(selector);
  const prefabSelect = element<HTMLSelectElement>(settings.prefabMount, '.art-prefab-variant');
  const objectSelect = element<HTMLSelectElement>(settings.objectMount, '.art-object-asset');
  const preview = new ArtPreview(control<HTMLCanvasElement>('.art-preview-canvas'));
  let catalog: ArtCatalog = { assets: [], variants: [] };
  let owner: string | null = null;
  let connected = false;
  let busy = false;
  let disposed = false;
  let active = false;
  let polling = false;
  let selected: TerrainObject | null = null;
  let selectionKey = '';
  let objectAsset = '';
  let prefab: SetPiece | null = null;
  let variantId = '';
  let partAssets = new Map<number, string>();
  let targetKey = '';
  let jobs: Job[] = [];
  let pollTimer = 0;

  function report(error: unknown): void {
    if (disposed && error instanceof DOMException && error.name === 'AbortError') return;
    if (!(error instanceof ArtError || error instanceof ModelError || error instanceof LevelError || error instanceof DOMException)) throw error;
    control('.art-status').textContent = error.message;
    onNotice(error.message, 'error');
  }
  async function run(action: () => Promise<void>): Promise<void> {
    if (busy) return;
    busy = true; render();
    try { await action(); }
    catch (error) { report(error); }
    finally { busy = false; if (!disposed) render(); }
  }
  function click(mount: HTMLElement, selector: string, action: () => Promise<void>): void {
    element(mount, selector).addEventListener('click', () => { void run(action); }, listen);
  }
  function assetOptions() {
    return [{ value: '', label: 'Editor shape (no mesh)' }, ...catalog.assets.map((asset) => ({ value: asset.id, label: asset.name }))];
  }
  function resources(ids: Iterable<string>): ArtResource[] {
    return [...new Set(ids)].map((id) => {
      const asset = catalog.assets.find((entry) => entry.id === id);
      if (!asset) throw new ArtError(`Asset "${id}" is not in this shared library. Import its course package first.`);
      return { id, name: asset.name, source: `/api/art/assets/${id}/model` };
    });
  }
  function usedIds(): string[] {
    return level.definition().objects.flatMap((object) => object.kind === 'terrain' && object.art ? [object.art.assetId] : []);
  }
  async function loadAssigned(): Promise<void> { await view.load(resources(usedIds()), lifetime.signal); }
  function target(): TerrainObject | null {
    if (select('.art-target').value === 'object') return selected;
    const index = Number(select('.art-target-part').value);
    const part = prefab?.parts[index];
    return part?.kind === 'terrain' ? { ...part, id: 'prefab-guide' } : null;
  }
  function describeTarget(): void {
    const object = target();
    const key = select('.art-target').value === 'object' ? `object:${selected?.id ?? ''}` : `prefab:${prefab?.id ?? ''}:${select('.art-target-part').value}`;
    control('.art-part-field').hidden = select('.art-target').value !== 'prefab';
    control('.art-faces-field').hidden = select('.art-kind').value !== 'mesh';
    control('.art-target-description').textContent = object === null
      ? 'Select a terrain object on the course, or choose a ready-made obstacle and one of its terrain parts.'
      : `${object.shape.type}: ${object.width} m wide, ${object.height} m high, ${object.depth} m deep. ${
        object.illusion ? 'Illusion artwork will fade with this part.' : 'Permanent terrain.'}`;
    if (key !== targetKey) {
      targetKey = key;
      input('.art-name').value = select('.art-target').value === 'object' ? selected?.id ?? '' :
        prefab ? `${prefab.name} - part ${Number(select('.art-target-part').value) + 1}` : '';
      control<HTMLTextAreaElement>('.art-prompt').value = 'Stylized weathered stone, readable edges, subtle surface detail, cohesive hand-painted game art.';
      input('.art-consent').checked = false;
    }
    control('.art-request-prompt').textContent = requestPrompt();
  }
  function requestPrompt(): string {
    const text = control<HTMLTextAreaElement>('.art-prompt').value.trim();
    const object = target();
    if (select('.art-kind').value !== 'mesh' || object === null) return text;
    return `${text}\nSingle static terrain prop with a ${object.shape.type} front silhouette. ` +
      `Target bounds: ${object.width} m wide, ${object.height} m high, ${object.depth} m deep. ` +
      'Front view in the XY plane, Y up, depth behind the front face. No ground plane, characters, or surrounding scene.';
  }
  function render(): void {
    const assetId = select('.art-assets').value;
    options(select('.art-assets'), [{ value: '', label: 'Choose a saved asset' }, ...assetOptions().slice(1)], assetId);
    const assigned = selected?.art?.assetId ?? '';
    const available = assetOptions();
    if (assigned && !available.some((option) => option.value === assigned)) available.push({ value: assigned, label: 'Assigned mesh (connect library to load)' });
    options(objectSelect, available, objectAsset);
    const chosen = prefab;
    options(prefabSelect, [{ value: '', label: 'Editor shapes' },
      ...(variantId === 'custom' ? [{ value: 'custom', label: 'Custom part selection (not yet published)' }] : []),
      ...catalog.variants.filter((variant) => variant.prefab === chosen?.id).map((variant) => ({ value: variant.id, label: variant.name }))], variantId);
    prefabSelect.disabled = busy || chosen === null;
    element<HTMLButtonElement>(settings.prefabMount, '.art-save-variant').disabled = busy || owner === null || chosen === null || partAssets.size === 0;
    element<HTMLButtonElement>(settings.objectMount, '.art-assign').disabled = busy || selected === null || owner === null;
    objectSelect.disabled = busy || selected === null;
    for (const field of settings.prefabMount.querySelectorAll<HTMLSelectElement>('[data-art-part]')) field.disabled = busy;
    options(select('.art-target-part'), chosen?.parts.flatMap((part, index) => part.kind === 'terrain'
      ? [{ value: String(index), label: `Part ${index + 1}: ${part.shape.type}${part.illusion ? ' (illusion)' : ''}` }] : []) ?? [], select('.art-target-part').value);
    describeTarget();
    for (const name of ['.art-refresh', '.art-connect', '.art-import', '.art-debug']) control<HTMLButtonElement>(name).disabled = busy;
    control<HTMLButtonElement>('.art-upload').disabled = busy || owner === null;
    control<HTMLButtonElement>('.art-export').disabled = busy || (owner === null && usedIds().length > 0);
    control<HTMLButtonElement>('.art-preview').disabled = busy || !select('.art-assets').value;
    control<HTMLButtonElement>('.art-disconnect').disabled = busy || !connected;
    control<HTMLButtonElement>('.art-generate').disabled = busy || !connected || target() === null || !input('.art-consent').checked;
    select('.art-mode').disabled = busy;
    select('.art-mode').value = view.inspect().mode;
  }
  function renderParts(): void {
    const mount = element(settings.prefabMount, '.art-prefab-parts');
    mount.replaceChildren();
    prefab?.parts.forEach((part, index) => {
      if (part.kind !== 'terrain') return;
      const label = document.createElement('label');
      label.className = 'level-field';
      label.append(`Part ${index + 1}: ${part.shape.type}${part.illusion ? ' (illusion)' : ''}`);
      const field = document.createElement('select');
      field.disabled = busy;
      field.dataset.artPart = String(index);
      options(field, assetOptions(), partAssets.get(index) ?? '');
      field.addEventListener('change', () => {
        if (field.value) partAssets.set(index, field.value); else partAssets.delete(index);
        variantId = partAssets.size > 0 ? 'custom' : '';
        render();
        element<HTMLButtonElement>(settings.prefabMount, '.art-save-variant').disabled = busy || owner === null || partAssets.size === 0;
        if (view.inspect().mode === 'meshes' && field.value) {
          void run(async () => { await view.load(resources(partAssets.values()), lifetime.signal); });
        }
      }, listen);
      label.append(field); mount.append(label);
    });
  }
  function renderJobs(): void {
    const mount = control('.art-jobs');
    mount.replaceChildren();
    for (const job of jobs) {
      const row = document.createElement('div'); row.className = 'art-job'; row.dataset.job = job.id;
      const text = document.createElement('p'); text.className = 'level-help';
      text.textContent = `${job.name}: ${job.status}${['queued', 'running', 'saving'].includes(job.status) ? ` (${job.progress}%)` : ''}${job.error ? ` - ${job.error}` : ''}`;
      row.append(text);
      if (job.asset_id) {
        const button = document.createElement('button'); button.className = 'button'; button.type = 'button'; button.textContent = 'Select saved result';
        button.addEventListener('click', () => {
          select('.art-assets').value = job.asset_id!;
          void run(() => showAsset(job.asset_id!));
        }, listen);
        row.append(button);
      } else if (job.status === 'attention' && job.task_id) {
        const button = document.createElement('button'); button.className = 'button'; button.type = 'button'; button.textContent = 'Resume retrieval (no regeneration)';
        button.addEventListener('click', () => { void run(async () => {
          await artRequest(`jobs/${job.id}/resume`, { method: 'POST', body: {}, signal: lifetime.signal });
          await refresh();
        }); }, listen);
        row.append(button);
      }
      mount.append(row);
    }
  }
  async function refresh(): Promise<void> {
    const session = artRecord(await artRequest('session', { signal: lifetime.signal }), 'Editor session');
    if (typeof session.owner !== 'string' || typeof session.connected !== 'boolean') throw new ArtError('Invalid shared editor session.');
    const rawJobs = await artRequest('jobs', { signal: lifetime.signal });
    // A ready job must have its newly published asset available in the same UI refresh.
    const rawCatalog = await artRequest('catalog', { signal: lifetime.signal });
    catalog = validateArtCatalog(rawCatalog); jobs = jobsFrom(rawJobs);
    owner = session.owner; connected = session.connected;
    control('.art-status').textContent = `${catalog.assets.length} shared assets, ${catalog.variants.length} prefab variants. ${
      connected ? 'Your Tripo API key is connected.' : 'Reuse existing assets, or connect your own Tripo API key to generate.'}`;
    render(); renderParts(); renderJobs(); schedulePoll();
  }
  function schedulePoll(): void {
    window.clearTimeout(pollTimer);
    if (disposed || !active || !owner || !jobs.some((job) => ['submitting', 'queued', 'running', 'saving'].includes(job.status))) return;
    pollTimer = window.setTimeout(() => {
      if (busy || polling) { schedulePoll(); return; }
      polling = true;
      void refresh().catch(report).finally(() => { polling = false; });
    }, 3000);
  }
  async function assetBlob(id: string): Promise<Blob> {
    return fetchModelBlob(`/api/art/assets/${artId(id)}/model`, lifetime.signal);
  }
  async function showAsset(id: string): Promise<void> { await preview.show(await assetBlob(id)); }
  async function share(blob: Blob, name: string): Promise<string> {
    const data = new FormData(); data.set('name', name); data.set('file', blob, 'asset.glb');
    const result = artRecord(await artRequest('assets', { method: 'POST', body: data, signal: lifetime.signal }), 'Shared asset');
    return artId(result.id);
  }
  click(root, '.art-refresh', refresh);
  click(root, '.art-connect', async () => {
    const key = input('.art-key').value.trim();
    input('.art-key').value = '';
    const result = artRecord(await artRequest('connection', { method: 'PUT', body: { apiKey: key }, signal: lifetime.signal }), 'Tripo connection');
    await refresh();
    onNotice(`Tripo connected. Available API credits: ${String(result.balance)}. Studio credits are separate.`, 'info');
  });
  click(root, '.art-disconnect', async () => {
    await artRequest('connection', { method: 'DELETE', signal: lifetime.signal }); await refresh();
  });
  click(root, '.art-preview', async () => { const id = select('.art-assets').value; if (id) await showAsset(id); });
  click(root, '.art-debug', async () => settings.onDebug());
  click(root, '.art-upload', async () => input('.art-glb-file').click());
  input('.art-glb-file').addEventListener('change', () => {
    const file = input('.art-glb-file').files?.[0]; input('.art-glb-file').value = '';
    if (!file) return;
    void run(async () => {
      if (file.size > ART_LIMITS.bytes) throw new ArtError('Choose a GLB no larger than 20 MiB.');
      validateCourseModel(await file.arrayBuffer());
      await preview.show(file);
      const id = await share(file, file.name.replace(/\.glb$/i, '').slice(0, 80));
      await refresh(); select('.art-assets').value = id;
      onNotice('Saved to the shared asset library. Assign it to an object or a prefab part to use it.', 'info');
    });
  }, listen);
  click(settings.objectMount, '.art-assign', async () => {
    const object = selected;
    if (!object) throw new ArtError('Select an existing terrain object first.');
    const id = objectSelect.value;
    if (id) await view.load(resources([id]), lifetime.signal);
    if (selected?.id !== object.id) throw new ArtError('Selection changed while loading. Choose the target object again.');
    const current = level.object(object.id);
    if (current.kind !== 'terrain') throw new ArtError('The selected object is no longer terrain.');
    level.upsert(assign(current, id || null, current.art?.mirror));
    onNotice(id ? 'Assigned the saved mesh. Choose Saved meshes in Editor preview to see it.' : 'Restored the editor shape for this object.', 'info');
  });
  objectSelect.addEventListener('change', () => { objectAsset = objectSelect.value; }, listen);
  click(settings.prefabMount, '.art-save-variant', async () => {
    if (!prefab || !owner) throw new ArtError('Choose a prefab and connect the shared library first.');
    const variant: ArtVariant = {
      id: `variant-${crypto.randomUUID()}`, prefab: prefab.id, owner,
      name: element<HTMLInputElement>(settings.prefabMount, '.art-variant-name').value,
      parts: [...partAssets].map(([index, assetId]) => ({ index, assetId })),
    };
    await artRequest('variants', { method: 'POST', body: variant, signal: lifetime.signal });
    variantId = variant.id; await refresh();
    onNotice('Published a reusable prefab artwork variant. Existing placed obstacles were not changed.', 'info');
  });
  prefabSelect.addEventListener('change', () => {
    variantId = prefabSelect.value;
    if (variantId === 'custom') return;
    const variant = catalog.variants.find((entry) => entry.id === variantId);
    partAssets = new Map(variant?.parts.map((part) => [part.index, part.assetId]) ?? []);
    renderParts(); render();
    if (view.inspect().mode === 'meshes') void run(async () => { await view.load(resources(partAssets.values()), lifetime.signal); });
  }, listen);
  for (const selector of ['.art-target', '.art-target-part', '.art-kind', '.art-consent', '.art-assets']) {
    control(selector).addEventListener('change', render, listen);
  }
  control('.art-prompt').addEventListener('input', () => {
    control('.art-request-prompt').textContent = requestPrompt();
  }, listen);
  select('.art-mode').addEventListener('change', () => {
    const next = select('.art-mode').value;
    void run(async () => {
      if (next !== 'shapes' && next !== 'meshes') throw new ArtError('Choose shapes or saved meshes.');
      if (next === 'meshes') {
        await loadAssigned();
        await view.load(resources(partAssets.values()), lifetime.signal);
      }
      view.setMode(next);
    });
  }, listen);
  click(root, '.art-generate', async () => {
    const object = target();
    if (!object || !input('.art-consent').checked) throw new ArtError('Choose a target and approve the API credit spend.');
    const data = new FormData();
    const prompt = requestPrompt();
    if (!prompt || prompt.length > ART_LIMITS.prompt) {
      throw new ArtError('The prompt, including the displayed mesh geometry context, needs 1-1024 characters. Shorten the art prompt.');
    }
    data.set('requestId', crypto.randomUUID()); data.set('consent', 'true');
    data.set('name', input('.art-name').value); data.set('prompt', prompt);
    data.set('kind', select('.art-kind').value); data.set('seed', input('.art-seed').value); data.set('faces', input('.art-faces').value);
    if (select('.art-kind').value === 'texture') data.set('guide', await terrainGuide(object), 'terrain-guide.glb');
    input('.art-consent').checked = false;
    await artRequest('jobs', { method: 'POST', body: data, signal: lifetime.signal });
    await refresh();
    onNotice('Generation submitted. The hosted cron retrieves results even when the editor is closed. Select its saved result when ready; nothing is assigned automatically.', 'info');
  });
  click(root, '.art-export', async () => {
    if (!settings.prepareExport()) return;
    const ids = new Set(usedIds());
    if (ids.size > ART_LIMITS.assets) throw new ArtError('A course can use at most 64 distinct artwork assets.');
    const assets: ArtResource[] = [];
    let total = 0;
    for (const resource of resources(ids)) {
      const blob = await assetBlob(resource.id);
      total += blob.size;
      if (total > ART_LIMITS.totalBytes) throw new ArtError('Course artwork exceeds 64 MiB.');
      const source = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result) : reject(new ArtError('Could not encode the GLB.'));
        reader.onerror = () => reject(new ArtError('Could not read the shared asset for export.'));
        reader.readAsDataURL(new Blob([blob], { type: 'model/gltf-binary' }));
      });
      assets.push({ id: resource.id, name: resource.name, source });
    }
    const mode = select('.art-release-mode').value;
    if (mode !== 'shapes' && mode !== 'meshes') throw new ArtError('Choose a built-game artwork mode.');
    const pack: CoursePackage = {
      format: 'over-the-edge-course', schemaVersion: 1, mode, level: level.definition(), assets,
      variants: catalog.variants.filter((variant) => variant.parts.every((part) => ids.has(part.assetId))),
    };
    download('course.json', JSON.stringify(pack));
    onNotice('Exported course.json with saved GLBs and the selected release look. No API keys, jobs, or editor code are included.', 'info');
  });
  click(root, '.art-import', async () => input('.art-package-file').click());
  input('.art-package-file').addEventListener('change', () => {
    const file = input('.art-package-file').files?.[0]; input('.art-package-file').value = '';
    if (!file) return;
    void run(async () => {
      if (file.size > ART_LIMITS.packageBytes) throw new ArtError('Course packages must be at most 96 MiB.');
      let raw: unknown;
      try { raw = JSON.parse(await file.text()); }
      catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        throw new ArtError('The course package is not valid JSON.');
      }
      const pack = validateCoursePackage(raw);
      for (const asset of pack.assets) {
        const bytes = embeddedGlb(asset.source);
        validateCourseModel(bytes.buffer);
        if (await modelAssetId(bytes.buffer) !== asset.id) {
          throw new ArtError('A packaged asset ID does not match its GLB. No files were shared and the current course was not changed.');
        }
      }
      if (!owner) await refresh();
      if (!window.confirm(`Share ${pack.assets.length} packaged assets with this editor's library and import the course? Existing shared assets are retained.`)) return;
      for (const asset of pack.assets) {
        const data = embeddedGlb(asset.source);
        const id = await share(new Blob([data], { type: 'model/gltf-binary' }), asset.name);
        if (id !== asset.id) throw new ArtError('A packaged asset ID does not match its GLB content. The current course was not changed.');
      }
      for (const variant of pack.variants) {
        await artRequest('variants', { method: 'POST', body: { ...variant, id: `variant-${crypto.randomUUID()}`, owner }, signal: lifetime.signal });
      }
      await refresh();
      view.setMode('shapes');
      view.clearLoaded();
      await view.load(resources(pack.assets.map((asset) => asset.id)), lifetime.signal);
      if (!settings.onImport(pack.level)) return;
      select('.art-release-mode').value = pack.mode;
      onNotice('Imported the course in shapes preview and shared its reusable artwork. Choose Saved meshes to inspect it. Named snapshots were kept.', 'info');
    });
  }, listen);
  const unsubscribe = level.subscribe(() => {
    if (selected) {
      const current = level.definition().objects.find((object) => object.id === selected!.id);
      selected = current?.kind === 'terrain' ? current : null;
    }
  });
  render(); renderParts();
  return {
    setSelection(object: TerrainObject | null): void {
      const changed = selected?.id !== object?.id;
      selected = object;
      const key = `${object?.id ?? ''}:${object?.art?.assetId ?? ''}`;
      if (key !== selectionKey) { selectionKey = key; objectAsset = object?.art?.assetId ?? ''; }
      if (changed && object) select('.art-target').value = 'object';
      render();
    },
    setPrefab(piece: SetPiece | null): void {
      if (piece?.id === prefab?.id) return;
      prefab = piece; partAssets.clear(); variantId = '';
      if (piece) select('.art-target').value = 'prefab';
      render(); renderParts();
    },
    decorate(objects: readonly LevelObject[], piece: SetPiece, mirror: boolean): readonly LevelObject[] {
      if (piece.id !== prefab?.id) return objects;
      const parts = new Map(piece.parts.flatMap((part, index) => part.kind !== 'label' ? [[index, part] as const] : []));
      return objects.map((object) => {
        if (object.kind !== 'terrain') return object;
        const index = Number(object.id.slice(object.id.lastIndexOf('-') + 1));
        const id = partAssets.get(index);
        if (!id) return object;
        const original = parts.get(index);
        return assign(object, id, mirror ? original?.kind === 'terrain' && original.shape.type === 'ramp' ? 'diagonal' : 'x' : 'none');
      });
    },
    readyForPlacement(): boolean {
      if (view.inspect().mode !== 'meshes' || view.hasAssets(partAssets.values())) return true;
      onNotice('Load the chosen prefab artwork before placing it. Waiting does not spend generation credits.', 'info');
      void run(async () => { await view.load(resources(partAssets.values()), lifetime.signal); });
      return false;
    },
    setActive(value: boolean): void { active = value; schedulePoll(); },
    snapshot: () => ({
      connected, shared: owner !== null, busy, assetCount: catalog.assets.length, variantCount: catalog.variants.length,
      variant: variantId, parts: [...partAssets], jobs, rendering: view.inspect(),
      releaseMode: select('.art-release-mode').value,
    }),
    dispose(): void {
      disposed = true; lifetime.abort(); window.clearTimeout(pollTimer);
      unsubscribe(); preview.dispose();
    },
  };
}
