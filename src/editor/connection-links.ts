import { LevelError } from '../level';
import type { LevelObject, PlatformObject, ShooterObject, TriggerObject } from '../level';
import type { PlatformDestination, TriggerAction } from '../trigger-events';

export type ConnectionAction = Extract<TriggerAction, { readonly type: 'fire-trap' | 'move-platform' }>;
export type ConnectionTarget = ShooterObject | PlatformObject;
const PLATFORM_LABELS: Readonly<Record<PlatformDestination, string>> = {
  toggle: 'toggle', start: '→ start', end: '→ end',
};

export interface ConnectionLink {
  readonly trigger: TriggerObject;
  readonly target: ConnectionTarget;
  readonly events: readonly ConnectionAction[];
  readonly label: string;
}

export interface ConnectionLinks {
  readonly all: readonly ConnectionLink[];
  readonly outgoing: ReadonlyMap<string, readonly ConnectionLink[]>;
  readonly incoming: ReadonlyMap<string, readonly ConnectionLink[]>;
  readonly targets: readonly ConnectionTarget[];
}

export function connectionTargetId(action: ConnectionAction): string;
export function connectionTargetId(action: TriggerAction): string | null;
export function connectionTargetId(action: TriggerAction): string | null {
  if (action.type === 'fire-trap') return action.trap;
  if (action.type === 'move-platform') return action.platform;
  return null;
}

export function deriveConnectionLinks(objects: readonly LevelObject[]): ConnectionLinks {
  const triggers: TriggerObject[] = [];
  const targets = new Map<string, ConnectionTarget>();
  for (const object of objects) {
    if (object.kind === 'trigger') triggers.push(object);
    else if (object.kind === 'shooter' || object.kind === 'platform') targets.set(object.id, object);
  }
  const all: ConnectionLink[] = [];
  const outgoing = new Map<string, ConnectionLink[]>();
  const incoming = new Map<string, ConnectionLink[]>();
  for (const trigger of triggers) {
    const groups = new Map<string, ConnectionAction[]>();
    for (const event of trigger.events) {
      if (event.type !== 'fire-trap' && event.type !== 'move-platform') continue;
      const id = connectionTargetId(event);
      const target = targets.get(id);
      if (target === undefined || target.kind !== (event.type === 'fire-trap' ? 'shooter' : 'platform')) {
        throw new LevelError(`Trigger "${trigger.id}" has an invalid connection to "${id}".`);
      }
      const events = groups.get(id);
      if (events === undefined) groups.set(id, [event]);
      else events.push(event);
    }
    const links: ConnectionLink[] = [];
    for (const [id, events] of groups) {
      const link: ConnectionLink = {
        trigger, target: targets.get(id)!, events,
        label: events.map((event) => event.type === 'fire-trap' ? `×${event.shots}` : PLATFORM_LABELS[event.to]).join(' · '),
      };
      links.push(link);
      all.push(link);
      const reverse = incoming.get(id);
      if (reverse === undefined) incoming.set(id, [link]);
      else reverse.push(link);
    }
    if (links.length > 0) outgoing.set(trigger.id, links);
  }
  return { all, outgoing, incoming, targets: [...targets.values()] };
}
