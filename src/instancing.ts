import type { InstancedBufferAttribute } from 'three';

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
