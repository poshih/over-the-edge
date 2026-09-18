import type { InstancedBufferAttribute } from 'three';

export class InstanceSlots<T extends { readonly id: string }> {
  private readonly entries: T[] = [];
  private readonly slots = new Map<string, number>();
  private readonly capacity: number;
  private readonly label: string;

  constructor(options: { capacity: number; label: string }) {
    this.capacity = options.capacity;
    this.label = options.label;
  }

  get size(): number {
    return this.entries.length;
  }

  ids(): IterableIterator<string> {
    return this.slots.keys();
  }

  values(): readonly T[] {
    return this.entries;
  }

  upsert(entry: T): number {
    const existing = this.slots.get(entry.id);
    if (existing !== undefined) {
      this.entries[existing] = entry;
      return existing;
    }
    if (this.entries.length >= this.capacity) throw new Error(`${this.label} capacity exceeded.`);
    const slot = this.entries.length;
    this.entries.push(entry);
    this.slots.set(entry.id, slot);
    return slot;
  }

  remove(id: string): { slot: number; moved: T | undefined } | undefined {
    const slot = this.slots.get(id);
    if (slot === undefined) return undefined;
    const last = this.entries.pop();
    if (last === undefined) throw new Error(`${this.label} slots and instances are inconsistent.`);
    this.slots.delete(id);
    if (slot < this.entries.length) {
      this.entries[slot] = last;
      this.slots.set(last.id, slot);
      return { slot, moved: last };
    }
    return { slot, moved: undefined };
  }

  clear(): void {
    this.entries.length = 0;
    this.slots.clear();
  }
}

export function markInstanceSlot(attribute: InstancedBufferAttribute, slot: number): void {
  let start = slot * attribute.itemSize;
  let end = start + attribute.itemSize;
  const ranges = attribute.updateRanges;
  // Culled meshes can go many frames without uploading. Keep their pending ranges bounded.
  for (let index = ranges.length - 1; index >= 0; index--) {
    const range = ranges[index];
    if (range.start <= end && range.start + range.count >= start) {
      start = Math.min(start, range.start);
      end = Math.max(end, range.start + range.count);
      ranges.splice(index, 1);
    }
  }
  attribute.addUpdateRange(start, end - start);
  attribute.needsUpdate = true;
}
