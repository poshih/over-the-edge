import type { PartRole } from '../model-library';
import { downloadServerModel } from './server-models';
import type { ServerModel, ServerModels } from './server-models';

const PART_NAMES: Readonly<Record<PartRole, { readonly one: string; readonly many: string }>> = {
  avatar: { one: 'avatar', many: 'avatars' },
  hammer: { one: 'hammer', many: 'hammers' },
  pot: { one: 'pot', many: 'pots' },
};

export interface ServerModelPicker {
  readonly root: HTMLElement;
  // Blocks picking, for example while the model's destination is busy.
  setDisabled(disabled: boolean): void;
}

/**
 * Picks one of the server's models for a part. Its button hands the chosen model's download to `take`,
 * which keeps the model's destination consistent while it arrives, uses the GLB like one chosen from the
 * computer, with the model's own settings when it carries them, and reports failures.
 */
export function createServerModelPicker(options: {
  readonly role: PartRole;
  // Unique on the page; the picker's controls are named after it.
  readonly id: string;
  // What the button does with the model: "Use" or "Add".
  readonly action: string;
  readonly served: ServerModels;
  readonly take: (download: () => Promise<File>, model: ServerModel) => Promise<unknown>;
  readonly signal: AbortSignal;
}): ServerModelPicker {
  const { role, signal } = options;
  const names = PART_NAMES[role];
  const models = options.served.models.filter((model) => model.role === role);
  const root = document.createElement('div');
  root.className = 'server-model-picker';
  const label = document.createElement('label');
  label.className = 'appearance-label';
  label.htmlFor = `${options.id}-list`;
  label.textContent = `Server ${names.one}`;
  const select = document.createElement('select');
  select.id = `${options.id}-list`;
  select.replaceChildren(...(models.length === 0 ? [new Option(`No server ${names.many}`, '')]
    : models.map((model, index) => new Option(model.name, String(index)))));
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'button';
  button.textContent = `${options.action} server ${names.one}`;
  const row = document.createElement('div');
  row.className = 'tuning-profile-row';
  row.append(select, button);
  const help = document.createElement('p');
  help.className = 'appearance-format';
  help.textContent = models.length === 0
    ? `This Workshop serves no ${names.many}. Put GLB files in the models/${role} folder of its repository, then build and deploy it again.`
    : 'The same for everyone who opens this Workshop, downloaded from its content delivery network when chosen.';
  root.append(label, row, help);

  let busy = false;
  let blocked = false;
  const render = (): void => {
    select.disabled = busy || blocked || models.length === 0;
    button.disabled = select.disabled;
    button.setAttribute('aria-busy', String(busy));
  };
  async function pick(): Promise<void> {
    const model = models[Number(select.value)];
    if (model === undefined || busy || blocked) return;
    busy = true;
    render();
    try {
      await options.take(() => downloadServerModel(options.served, model, signal), model);
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'AbortError')) throw error;
    } finally {
      busy = false;
      if (!signal.aborted) render();
    }
  }
  button.addEventListener('click', () => { void pick(); }, { signal });
  render();
  return {
    root,
    setDisabled(disabled) {
      blocked = disabled;
      render();
    },
  };
}
