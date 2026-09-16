import { geometryKey, LEVEL_LIMITS, LevelError, levelStart, TRIGGER_LIMITS, validateLevel, validateLevelMetadata, validateLevelObject } from '../level';
import type { LevelChange, LevelDefinition, LevelObject, StartObject } from '../level';

export class LevelState {
  private current: LevelDefinition;
  private objects: Map<string, LevelObject>;
  private startObject: StartObject;
  private terrainCount = 0;
  private triggerCount = 0;
  private readonly geometryUse = new Map<string, number>();
  private readonly listeners = new Set<(change: LevelChange) => void>();

  constructor(level: LevelDefinition) {
    this.current = validateLevel(level);
    this.objects = new Map(this.current.objects.map((object) => [object.id, object]));
    this.startObject = levelStart(this.current);
    this.indexObjects();
  }

  definition(): LevelDefinition {
    return this.current;
  }

  object(id: string): LevelObject {
    const object = this.objects.get(id);
    if (!object) throw new LevelError(`Object "${id}" no longer exists.`);
    return object;
  }

  start(): StartObject { return this.startObject; }

  counts() {
    return { terrain: this.terrainCount, triggers: this.triggerCount, total: this.objects.size };
  }

  upsert(value: unknown): void {
    const object = validateLevelObject(value);
    const previous = this.objects.get(object.id);
    if (previous && JSON.stringify(previous) === JSON.stringify(object)) return;
    if ((object.kind === 'start') !== (previous?.kind === 'start')) {
      throw new LevelError('A level needs one start location. Move the existing start instead of replacing or duplicating it.');
    }
    const terrains = this.terrainCount + Number(object.kind === 'terrain') - Number(previous?.kind === 'terrain');
    const triggers = this.triggerCount + Number(object.kind === 'trigger') - Number(previous?.kind === 'trigger');
    if (terrains > LEVEL_LIMITS.objects) throw new LevelError(`A level supports up to ${LEVEL_LIMITS.objects} terrain objects.`);
    if (triggers > TRIGGER_LIMITS.objects) throw new LevelError(`A level supports up to ${TRIGGER_LIMITS.objects} triggers.`);
    const nextKey = object.kind === 'terrain' ? geometryKey(object.shape) : null;
    const previousKey = previous?.kind === 'terrain' ? geometryKey(previous.shape) : null;
    const freed = previousKey !== null && previousKey !== nextKey && this.geometryUse.get(previousKey) === 1;
    const kinds = this.geometryUse.size + (nextKey !== null && !this.geometryUse.has(nextKey) ? 1 : 0) - (freed ? 1 : 0);
    if (kinds > LEVEL_LIMITS.geometryKinds) {
      throw new LevelError(`A level supports up to ${LEVEL_LIMITS.geometryKinds} distinct geometry templates.`);
    }
    if (previousKey !== null) this.removeGeometry(previousKey);
    if (nextKey !== null) this.addGeometry(nextKey);
    if (object.kind === 'start') this.startObject = object;
    this.terrainCount = terrains;
    this.triggerCount = triggers;
    this.objects.set(object.id, object);
    this.publish({ ...this.current, objects: Object.freeze([...this.objects.values()]) }, [object], []);
  }

  remove(id: string): void {
    const object = this.object(id);
    if (object.kind === 'start') throw new LevelError('A level needs its start location. Move it instead of deleting it.');
    if (object.kind === 'terrain') {
      this.removeGeometry(geometryKey(object.shape));
      this.terrainCount--;
    } else this.triggerCount--;
    this.objects.delete(id);
    this.publish({ ...this.current, objects: Object.freeze([...this.objects.values()]) }, [], [id]);
  }

  metadata(value: Pick<LevelDefinition, 'labels'>): void {
    const metadata = validateLevelMetadata(value);
    if (JSON.stringify(metadata.labels) === JSON.stringify(this.current.labels)) return;
    this.publish({ ...this.current, ...metadata }, [], []);
  }

  replace(value: unknown): void {
    const level = validateLevel(value);
    const next = new Map(level.objects.map((object) => [object.id, object]));
    const remove = [...this.objects.keys()].filter((id) => !next.has(id));
    const upsert = level.objects.filter((object) => JSON.stringify(this.objects.get(object.id)) !== JSON.stringify(object));
    this.objects = next;
    this.current = level;
    this.startObject = levelStart(level);
    this.indexObjects();
    this.emit({ kind: 'replace', level, upsert, remove });
  }

  subscribe(listener: (change: LevelChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private publish(level: LevelDefinition, upsert: readonly LevelObject[], remove: readonly string[]): void {
    this.current = Object.freeze(level);
    this.emit({ kind: 'edit', level: this.current, upsert, remove });
  }

  private emit(change: LevelChange): void {
    for (const listener of this.listeners) listener(change);
  }

  private addGeometry(key: string): void {
    const count = this.geometryUse.get(key);
    this.geometryUse.set(key, count === undefined ? 1 : count + 1);
  }

  private indexObjects(): void {
    this.geometryUse.clear();
    this.terrainCount = 0;
    this.triggerCount = 0;
    for (const object of this.objects.values()) {
      if (object.kind === 'terrain') {
        this.terrainCount++;
        this.addGeometry(geometryKey(object.shape));
      } else if (object.kind === 'trigger') this.triggerCount++;
    }
  }

  private removeGeometry(key: string): void {
    const count = this.geometryUse.get(key);
    if (count === undefined) throw new Error('Level geometry reference counts are inconsistent.');
    if (count === 1) this.geometryUse.delete(key);
    else this.geometryUse.set(key, count - 1);
  }
}
