import { checkAppearanceModel } from '../appearance-model';
import { DEFAULT_ALIGNMENT, isVisualPartId, validateAppearanceParts } from '../appearance-profile';
import type { VisualAlignment } from '../appearance-profile';
import type { VisualPartId } from '../character';
import { ModelError as AppearanceError, MODEL_LIMITS } from '../model-data';
import { PluginError } from '../plugins/kernel';
import { checkFileBudget, isProjectDataError } from '../project';
import type { History } from './document/history';
import type { ImportRunner, PendingContext, PreparedImport } from './document/import-runner';
import type { ProjectRefusal } from './document/project-commands';
import type { DocumentAppearance, DocumentAppearancePart, DocumentArmIk } from './document/project-document';
import type { EditOutcome, FileInput, ImportOptions } from './document/project-imports';
import type { AppearanceCommands } from './document/visual-contract';
import { armIkValue } from './document/visual-values';
import { ProjectApiError } from './project-client';
import { ServerModelError } from './server-models';

export interface AppearancePartInput {
  readonly part: VisualPartId;
  readonly name: string;
  readonly blob: Blob;
  readonly alignment: Readonly<VisualAlignment>;
}

export interface AppearanceImports {
  part(part: VisualPartId, input: FileInput, options: ImportOptions): Promise<EditOutcome<DocumentAppearancePart>>;
  parts(value: readonly AppearancePartInput[], options: ImportOptions): Promise<EditOutcome<DocumentAppearance>>;
  armIk(read: (signal: AbortSignal) => Promise<unknown>, options: ImportOptions): Promise<EditOutcome<DocumentArmIk>>;
  dispose(): void;
}

function refusal(error: unknown): ProjectRefusal {
  if (error instanceof AppearanceError || error instanceof PluginError) return error;
  if (!(isProjectDataError(error) || error instanceof ProjectApiError || error instanceof ServerModelError ||
    error instanceof DOMException || error instanceof SyntaxError)) throw error;
  return new AppearanceError(error.message, { cause: error });
}

function size(blob: Blob): void {
  if (blob.size < 1 || blob.size > MODEL_LIMITS.bytes) {
    throw new AppearanceError(`Choose a GLB holding 1 byte to ${MODEL_LIMITS.bytes / 1024 ** 2} MiB.`);
  }
}

function fileName(name: string): void {
  if (!name.toLowerCase().endsWith('.glb')) throw new AppearanceError('Choose one binary glTF (.glb) file for this part.');
}

export function createAppearanceImports(options: {
  readonly history: History;
  readonly commands: AppearanceCommands;
  readonly runner: ImportRunner;
  // Report acceptance after finish, before the promise resolves or another deferred edit runs.
  readonly onPartAccepted?: (part: VisualPartId, value: DocumentAppearancePart) => void;
  readonly onPartsAccepted?: (value: DocumentAppearance) => void;
}): AppearanceImports {
  const { history, commands, runner } = options;
  const document = history.document;
  const lifecycle = new AbortController();

  function edit<T, P>(input: ImportOptions, start: (work: PendingContext) => P,
    build: (work: PendingContext, prepared: P) => Promise<PreparedImport<T>>): Promise<EditOutcome<T>> {
    return runner.edit({ info: input.info, signal: AbortSignal.any([input.signal, lifecycle.signal]) }, refusal, start, build);
  }

  function current(part: VisualPartId): DocumentAppearancePart | null {
    return document.get('appearance').find((entry) => entry.part === part) ?? null;
  }

  async function check(work: PendingContext, blob: Blob): Promise<void> {
    size(blob);
    const bytes = await work.wait(() => blob.arrayBuffer());
    work.check();
    checkAppearanceModel(bytes);
  }

  const imports: AppearanceImports = {
    part(part, input, inputOptions) {
      return edit(inputOptions, (work) => {
        if (!isVisualPartId(part)) throw new AppearanceError(`Unknown appearance part "${String(part)}".`);
        fileName(input.name);
        validateAppearanceParts([{ part, name: input.name, alignment: DEFAULT_ALIGNMENT }]);
        if (!('read' in input)) size(input);
        const expected = current(part);
        work.stopTargets('appearance/parts');
        work.target(`appearance/part/${part}`, ['appearance'], () => current(part) === expected);
        return expected;
      }, async (work, expected) => {
        const file = 'read' in input ? await work.wait(() => input.read(work.signal)) : input;
        work.check();
        fileName(file.name);
        size(file);
        const entry = validateAppearanceParts([{ part, name: file.name, alignment: DEFAULT_ALIGNMENT }])[0]!;
        checkFileBudget('appearance', document.get('appearance').reduce((sum, entry) => sum + entry.file.bytes, 0)
          - (expected?.file.bytes ?? 0) + file.size);
        await check(work, file);
        const handle = await work.stage(file);
        work.check();
        const value = Object.freeze({ ...entry, file: handle });
        return {
          command: () => commands.replacePart(part, expected, value, inputOptions.info),
          value: () => {
            const value = current(part);
            if (value === null) throw new Error('A completed part import must hold its model.');
            options.onPartAccepted?.(part, value);
            return value;
          },
        };
      });
    },
    parts(value, inputOptions) {
      return edit(inputOptions, (work) => {
        const parts = validateAppearanceParts(value.map(({ part, name, alignment }) => ({ part, name, alignment })));
        let bytes = 0;
        const entries = parts.map((part, index) => {
          const blob = value[index]!.blob;
          size(blob);
          bytes += blob.size;
          return Object.freeze({ ...part, blob });
        });
        checkFileBudget('appearance', bytes);
        const expected = document.get('appearance');
        work.stopTargets('appearance/');
        work.target('appearance/parts', ['appearance'], () => document.get('appearance') === expected);
        return { expected, entries };
      }, async (work, { expected, entries }) => {
        const parts: DocumentAppearancePart[] = [];
        for (const { part, name, alignment, blob } of entries) {
          await check(work, blob);
          const file = await work.stage(blob);
          work.check();
          parts.push(Object.freeze({ part, name, alignment, file }));
        }
        const value = commands.checkParts(Object.freeze(parts), expected);
        return {
          command: () => commands.parts(value, expected, inputOptions.info),
          value: () => {
            const value = document.get('appearance');
            options.onPartsAccepted?.(value);
            return value;
          },
        };
      });
    },
    armIk(read, inputOptions) {
      return edit(inputOptions, (work) => {
        const expected = document.get('arm-ik');
        work.target('arm-ik', ['arm-ik'], () => document.get('arm-ik') === expected);
        return expected;
      }, async (work, expected) => {
        const raw = await work.wait(() => read(work.signal));
        work.check();
        const value = armIkValue(raw, expected);
        return {
          command: () => commands.armIk((current) => {
            if (current !== expected) throw new AppearanceError('The elbow hints changed while the profile was read; try again.');
            return value;
          }, inputOptions.info),
          value: () => document.get('arm-ik'),
        };
      });
    },
    dispose: () => lifecycle.abort(),
  };
  return Object.freeze(imports);
}
