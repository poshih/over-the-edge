import { geometryKey, LEVEL_LIMITS, LevelError, validateLevel, validateLevelMetadata, validateLevelObject } from '../level';
import type { LevelChange, LevelDefinition, LevelObject } from '../level';

export class LevelState {
  private current: LevelDefinition;
  private objects: Map<string, LevelObject>;
  private readonly geometryUse = new Map<string, number>();
  private readonly listeners = new Set<(change: LevelChange) => void>();

  constructor(level: LevelDefinition) {
    this.current = validateLevel(level);
    this.objects = new Map(this.current.objects.map((object) => [object.id, object]));
    for (const object of this.objects.values()) this.addGeometry(geometryKey(object.shape));
  }

  definition(): LevelDefinition {
    return this.current;
  }

  object(id: string): LevelObject {
    const object = this.objects.get(id);
    if (!object) throw new LevelError(`Object "${id}" no longer exists.`);
    return object;
  }

  upsert(value: unknown): void {
    const object = validateLevelObject(value);
    if (!this.objects.has(object.id) && this.objects.size >= LEVEL_LIMITS.objects) {
      throw new LevelError(`A level supports up to ${LEVEL_LIMITS.objects} objects.`);
    }
    const previous = this.objects.get(object.id);
    if (previous && JSON.stringify(previous) === JSON.stringify(object)) return;
    const nextKey = geometryKey(object.shape);
    const previousKey = previous === undefined ? null : geometryKey(previous.shape);
    const freed = previousKey !== null && previousKey !== nextKey && this.geometryUse.get(previousKey) === 1;
    const kinds = this.geometryUse.size + (this.geometryUse.has(nextKey) ? 0 : 1) - (freed ? 1 : 0);
    if (kinds > LEVEL_LIMITS.geometryKinds) {
      throw new LevelError(`A level supports up to ${LEVEL_LIMITS.geometryKinds} distinct geometry templates.`);
    }
    if (previousKey !== null) this.removeGeometry(previousKey);
    this.addGeometry(nextKey);
    this.objects.set(object.id, object);
    this.publish({ ...this.current, objects: Object.freeze([...this.objects.values()]) }, [object], []);
  }

  remove(id: string): void {
    this.removeGeometry(geometryKey(this.object(id).shape));
    this.objects.delete(id);
    this.publish({ ...this.current, objects: Object.freeze([...this.objects.values()]) }, [], [id]);
  }

  metadata(value: Pick<LevelDefinition, 'spawn' | 'summit' | 'labels'>): void {
    const metadata = validateLevelMetadata(value);
    const labels = JSON.stringify(metadata.labels) === JSON.stringify(this.current.labels) ? this.current.labels : metadata.labels;
    const summit = JSON.stringify(metadata.summit) === JSON.stringify(this.current.summit) ? this.current.summit : metadata.summit;
    this.publish({ ...this.current, ...metadata, labels, summit }, [], []);
  }

  replace(value: unknown): void {
    const level = validateLevel(value);
    const next = new Map(level.objects.map((object) => [object.id, object]));
    const remove = [...this.objects.keys()].filter((id) => !next.has(id));
    const upsert = level.objects.filter((object) => JSON.stringify(this.objects.get(object.id)) !== JSON.stringify(object));
    this.objects = next;
    this.geometryUse.clear();
    for (const object of next.values()) this.addGeometry(geometryKey(object.shape));
    this.current = level;
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

  private removeGeometry(key: string): void {
    const count = this.geometryUse.get(key);
    if (count === undefined) throw new Error('Level geometry reference counts are inconsistent.');
    if (count === 1) this.geometryUse.delete(key);
    else this.geometryUse.set(key, count - 1);
  }
}
