import type { ProjectEvent, ProjectSectionName } from './project-session';

// Where an editor's Save to project goes: the open server project (ProjectSession).
export interface ProjectSaveTarget {
  // The open server project's ID, or null when none is open.
  openProject(): string | null;
  subscribe(listener: (event: ProjectEvent) => void): () => void;
  saveToProject(names: readonly ProjectSectionName[], label: string): Promise<boolean>;
}

/**
 * A Save to project button for one editor's sections, such as Level's level: writes them into the open server project
 * at once and says so, instead of waiting for its automatic save. Disabled until a server project is open.
 */
export function createProjectSaveButton(options: {
  readonly target: ProjectSaveTarget;
  readonly sections: readonly ProjectSectionName[];
  // Names the sections in notices and the button's tip, e.g. "the level".
  readonly label: string;
  readonly signal: AbortSignal;
}): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'button project-save';
  button.textContent = 'Save to project';
  let saving = false;
  const render = (): void => {
    const project = options.target.openProject();
    button.disabled = project === null || saving;
    button.title = project === null ? 'Open or save a server project in Workshop / Project to save into it.'
      : `Save ${options.label} into the server project "${project}" now; it also saves itself about a second after each change.`;
  };
  button.addEventListener('click', () => {
    saving = true;
    render();
    void options.target.saveToProject(options.sections, options.label).finally(() => {
      saving = false;
      if (!options.signal.aborted) render();
    });
  }, { signal: options.signal });
  const unsubscribe = options.target.subscribe(render);
  options.signal.addEventListener('abort', unsubscribe, { once: true });
  render();
  return button;
}
