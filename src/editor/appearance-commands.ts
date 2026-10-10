import { isVisualPartId } from '../appearance-profile';
import type { VisualPartId } from '../character';
import { ModelError as AppearanceError } from '../model-data';
import type { FileStore } from './document/files';
import type { Command } from './document/history';
import type { ProjectCommandInfo } from './document/project-commands';
import type {
  DocumentAppearancePart, ProjectDocument, SectionValue, SomeSectionChange,
} from './document/project-document';
import { adapterFor } from './document/sections';
import type { AppearanceCommands } from './document/visual-contract';
import { alignmentValue, appearanceValue, armIkValue } from './document/visual-values';

function partId(part: VisualPartId): void {
  if (!isVisualPartId(part)) throw new AppearanceError(`Unknown appearance part "${String(part)}".`);
}

function whole<S extends 'appearance' | 'arm-ik'>(document: ProjectDocument, section: S,
  after: SectionValue<S>): SomeSectionChange[] {
  const before = document.get(section);
  return before === after ? [] : [adapterFor(section).change(before, after) as SomeSectionChange];
}

export function createAppearanceCommands(options: {
  readonly document: ProjectDocument;
  readonly files: FileStore;
}): AppearanceCommands {
  const { files } = options;

  function command(info: ProjectCommandInfo, build: Command['run']): Command {
    return Object.freeze({
      label: info.label, place: info.place, coalesce: info.coalesce,
      run(document: ProjectDocument): readonly SomeSectionChange[] {
        if (document !== options.document) throw new Error('Appearance commands belong to their document.');
        return Object.freeze(build(document));
      },
    });
  }

  const commands: AppearanceCommands = {
    checkParts: (value, current) => appearanceValue(value, current, files),
    armIk(build, info) {
      return command(info, (document) => {
        const before = document.get('arm-ik');
        return whole(document, 'arm-ik', armIkValue(build(before), before));
      });
    },
    alignment(part, build, info) {
      return command(info, (document) => {
        partId(part);
        const before = document.get('appearance');
        const entry = before.find((entry) => entry.part === part);
        if (entry === undefined) throw new AppearanceError(`Import a model for ${part} before aligning it.`);
        const alignment = alignmentValue(build(entry.alignment), entry.alignment);
        if (alignment === entry.alignment) return [];
        const value = Object.freeze({ ...entry, alignment });
        return whole(document, 'appearance', appearanceValue(before.map((entry) => entry.part === part ? value : entry), before, files));
      });
    },
    replacePart(part, expected, value, info) {
      return command(info, (document) => {
        partId(part);
        const before = document.get('appearance');
        const current = before.find((entry) => entry.part === part) ?? null;
        if (current !== expected) throw new AppearanceError(`The ${part} model changed while its import was read; try again.`);
        if (value !== null && value.part !== part) throw new AppearanceError(`The replacement must be for ${part}.`);
        const entries: DocumentAppearancePart[] = before.filter((entry) => entry.part !== part);
        if (value !== null) entries.push(value);
        return whole(document, 'appearance', appearanceValue(entries, before, files));
      });
    },
    parts(value, expected, info) {
      return command(info, (document) => {
        const before = document.get('appearance');
        if (before !== expected) throw new AppearanceError('The appearance changed while its models were read; try again.');
        return whole(document, 'appearance', appearanceValue(value, before, files));
      });
    },
  };
  return Object.freeze(commands);
}
