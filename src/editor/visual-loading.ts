import { Disposal } from '../disposal';
import { setText } from '../dom';
import type { Appearance } from './appearance';
import { VISUAL_PARTS } from './appearance-types';
import type { SpriteEditorState } from './sprite-state';
import './visual-loading.css';

// Projection progress beside the canvas, even when its tab is closed. No frame work.
export function createVisualLoading(options: {
  readonly canvas: HTMLCanvasElement;
  readonly character: SpriteEditorState;
  readonly appearance: Appearance;
}): { setRestoring(restoring: boolean): void; dispose(): void } {
  const mount = options.canvas.parentElement;
  if (mount === null) throw new Error('Visual loading status requires the game canvas mount.');
  const root = document.createElement('div');
  root.className = 'visual-loading';
  root.dataset.kind = 'idle';
  root.setAttribute('role', 'status');
  root.setAttribute('aria-live', 'polite');
  root.setAttribute('aria-atomic', 'true');
  const restoration = document.createElement('p');
  const character = document.createElement('p');
  const appearance = document.createElement('p');
  root.append(restoration, character, appearance);
  mount.insertBefore(root, options.canvas.nextSibling);
  let restoring = false;
  let disposed = false;

  function visibility(): void {
    root.dataset.kind = character.dataset.kind === 'error' || appearance.dataset.kind === 'error' ? 'error'
      : restoring || character.textContent !== '' || appearance.textContent !== '' ? 'busy' : 'idle';
  }

  function renderCharacter(): void {
    const rendering = options.character.renderingState();
    character.dataset.kind = rendering.kind === 'failed' ? 'error' : 'busy';
    setText(character, rendering.kind === 'loading'
      ? 'Character loading… Previous rendering may remain.'
      : rendering.kind === 'failed' ? 'Character rendering failed. See Character for details and Retry loading.' : '');
    visibility();
  }

  function renderAppearance(): void {
    const loading: string[] = [];
    const failed: string[] = [];
    for (const { id, label } of VISUAL_PARTS) {
      const rendering = options.appearance.renderingState(id);
      if (rendering.kind === 'loading') loading.push(label);
      else if (rendering.kind === 'failed') failed.push(label);
    }
    const messages: string[] = [];
    if (loading.length > 0) {
      messages.push(loading.length === 1 ? `Loading appearance: ${loading[0]}.` : `Loading ${loading.length} appearance models.`);
      messages.push('Previous models may remain.');
    }
    if (failed.length > 0) {
      messages.push(failed.length === 1 ? `Appearance rendering failed: ${failed[0]}.`
        : `${failed.length} appearance models could not be shown.`);
      messages.push('See Appearance for details.');
    }
    appearance.dataset.kind = failed.length > 0 ? 'error' : 'busy';
    setText(appearance, messages.join(' '));
    visibility();
  }

  let unsubscribeCharacter = (): void => {};
  let unsubscribeAppearance = (): void => {};
  try {
    unsubscribeCharacter = options.character.subscribe(renderCharacter);
    unsubscribeAppearance = options.appearance.subscribe(renderAppearance);
  } catch (error) {
    const disposal = new Disposal();
    disposal.run(() => { throw error; });
    disposal.run(unsubscribeAppearance);
    disposal.run(unsubscribeCharacter);
    disposal.run(() => root.remove());
    disposal.finish();
    throw error;
  }
  return {
    setRestoring(value: boolean): void {
      if (disposed || restoring === value) return;
      restoring = value;
      setText(restoration, value ? 'Restoring this browser’s character and appearance… Authoring waits until the read finishes.' : '');
      visibility();
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      const disposal = new Disposal();
      disposal.run(unsubscribeAppearance);
      disposal.run(unsubscribeCharacter);
      disposal.run(() => root.remove());
      disposal.finish();
    },
  };
}
