import { createDirectionalPresentation } from './directional-data';
import type { DirectionalPresentation } from './directional-data';
import type { SkeletonDefinition } from './skeleton-data';
import type { SpriteLayer } from './sprite-data';

export interface SpriteHeadTracking {
  readonly anchor: string;
  readonly pivot: { readonly anchor: string; readonly x: number; readonly y: number };
}

export interface SpriteHeadTrackingPlan {
  readonly status: 'unconfigured' | 'no-head' | 'authored' | 'automatic' | 'partial' | 'unsupported';
  readonly reason: string;
  readonly layers: readonly string[];
  readonly bones: readonly string[];
  readonly issues: readonly { readonly layer: string; readonly reason: string }[];
  readonly presentation: DirectionalPresentation | null;
}

const HEAD_UPRIGHT_DEGREES = 90;
const HEAD_TILT_LIMIT_DEGREES = 25;
const HEAD_RESPONSE_SECONDS = 0.12;

function inactive(status: SpriteHeadTrackingPlan['status'], reason: string): SpriteHeadTrackingPlan {
  return { status, reason, layers: Object.freeze([]), bones: Object.freeze([]), issues: Object.freeze([]), presentation: null };
}

function influenceBones(layer: SpriteLayer): readonly string[] {
  const bones = new Set<string>();
  if (layer.bone !== null) bones.add(layer.bone);
  if (layer.skin !== null) {
    for (const vertex of layer.skin.weights) {
      for (const influence of vertex) if (influence.weight > 0) bones.add(influence.bone);
    }
  }
  return [...bones];
}

// Compile only when the authored layout changes. No IDs or weights are inspected per frame.
export function compileSpriteHeadTracking(
  tracking: SpriteHeadTracking | null,
  layers: readonly SpriteLayer[],
  skeleton: SkeletonDefinition | null,
  presentation: DirectionalPresentation | null,
): SpriteHeadTrackingPlan {
  if (tracking === null) return inactive('unconfigured', 'This host has not configured sprite head tracking.');
  if (presentation !== null) {
    return inactive('authored', 'Authored Directional Presentation replaces automatic head tilt. Only its selected layers/bones move; disabled rotation and limits are preserved.');
  }
  const headLayers = layers.filter(layer => layer.anchor === tracking.anchor);
  if (headLayers.length === 0) return inactive('no-head', `No artwork uses the head anchor "${tracking.anchor}".`);
  const unbound = Object.freeze(headLayers.filter(layer => layer.bone === null && layer.skin === null).map(layer => layer.id));
  const ownership = layers.map(layer => ({ layer, bones: influenceBones(layer) }));
  const byId = new Map(skeleton?.bones.map(bone => [bone.id, bone]));
  const ancestors = new Map<string, ReadonlySet<string>>();
  for (const bone of byId.values()) {
    const path = new Set<string>();
    let current: string | null = bone.id;
    while (current !== null) {
      path.add(current);
      current = byId.get(current)!.parent;
    }
    ancestors.set(bone.id, path);
  }
  const within = (bone: string, root: string): boolean => ancestors.get(bone)!.has(root);
  const headOwnership = ownership.filter(entry => entry.layer.anchor === tracking.anchor && entry.bones.length > 0)
    .map(entry => {
      const owner = [...ancestors.get(entry.bones[0])!].find(root => entry.bones.every(bone => within(bone, root)));
      return { ...entry, owner: owner ?? null };
    });
  const ikBones = [...new Set(skeleton?.ik.flatMap(chain => [chain.upper, chain.lower, chain.hand]))];
  const hairBones = [...new Set(skeleton?.hair.flatMap(chain => chain.bones))];
  const candidates = new Map<string, string | null>();
  for (const { owner: root } of headOwnership) {
    if (root === null || candidates.has(root)) continue;
    let reason: string | null = null;
    if (hairBones.some(bone => within(root, bone))) {
      reason = `Bone "${root}" is simulated hair or descends from it. Select an attachment owner above the hair chain.`;
    } else if (ikBones.some(bone => within(bone, root) || within(root, bone))) {
      reason = `Bone "${root}" overlaps an IK chain; automatic head motion cannot move IK bones.`;
    } else {
      for (const entry of ownership) {
        const influences = entry.bones;
        if (!influences.some(bone => within(bone, root))) continue;
        if (entry.layer.anchor !== tracking.anchor) {
          reason = `Bone "${root}" also moves "${entry.layer.name}" on anchor "${entry.layer.anchor}". Give the head a dedicated subtree.`;
          break;
        }
        if (influences.some(bone => !within(bone, root))) {
          reason = `Skin "${entry.layer.name}" shares weights outside "${root}". Give head weights a dedicated subtree.`;
          break;
        }
      }
    }
    candidates.set(root, reason);
  }
  const safe = [...candidates].filter(([, reason]) => reason === null).map(([root]) => root);
  const bones = Object.freeze(safe.filter(root => !safe.some(other => other !== root && within(root, other))));
  const issues: Array<{ layer: string; reason: string }> = [];
  for (const entry of headOwnership) {
    if (bones.some(root => entry.bones.every(bone => within(bone, root)))) continue;
    const owner = entry.owner;
    issues.push(Object.freeze({
      layer: entry.layer.id,
      reason: owner === null ? `Skin "${entry.layer.name}" spans separate skeleton roots. Map a dedicated head owner explicitly.` :
        candidates.get(owner)!,
    }));
  }
  const automatic = unbound.length > 0 || bones.length > 0;
  const status = issues.length === 0 ? 'automatic' : automatic ? 'partial' : 'unsupported';
  const reason = issues.length === 0 ?
    'Automatic head tracking uses a bounded neck tilt and the shared facing choice. A single image can tilt, but cannot invent missing face views.' :
    `${automatic ? 'Partial' : 'Unsupported'} automatic head tracking: ${issues[0].reason} ` +
    'Use a dedicated head binding or explicit Directional Presentation outside IK.' +
    (issues.length > 1 ? ` ${issues.length - 1} more head layer(s) need attention.` : '');
  const defaults = createDirectionalPresentation(tracking.pivot.anchor);
  return {
    status, reason, layers: unbound, bones, issues: Object.freeze(issues),
    presentation: !automatic ? null : {
      ...defaults,
      rotation: true,
      pivot: tracking.pivot,
      layers: unbound,
      bones,
      // Lean toward aim from upright, rather than resetting to zero at every facing-sector center.
      directions: defaults.directions.map(rule => ({
        ...rule,
        neutralAngle: HEAD_UPRIGHT_DEGREES,
        minimumRotation: -HEAD_TILT_LIMIT_DEGREES,
        maximumRotation: HEAD_TILT_LIMIT_DEGREES,
        responseTime: HEAD_RESPONSE_SECONDS,
      })),
    },
  };
}
