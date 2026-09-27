import { RIG } from './config';

// The configurable part of the hammer rig, set per game in its settings.
export interface RigSettings {
  // From the butt to the head's centre.
  readonly handleLength: number;
  // How far the butt can slide past the shoulder hinge.
  readonly maxExtension: number;
}

export const DEFAULT_RIG_SETTINGS: Readonly<RigSettings> = Object.freeze({ handleLength: 1.5, maxExtension: 1.15 });

export const RIG_LIMITS = {
  handleLength: { min: 0.75, max: 3 },
  maxExtension: { min: 0, max: 2 },
} as const;

// The longest reach any valid rig has.
export const MAX_RIG_REACH = RIG_LIMITS.handleLength.max + RIG_LIMITS.maxExtension.max;

// Everything the physics, rendering and input derive from the rig settings.
export interface RigGeometry extends RigSettings {
  // Fully retracted, the head sits on the shoulder hinge.
  readonly minExtension: number;
  readonly maxReach: number;
  readonly segmentLength: number;
}

export function rigGeometry(settings: Readonly<RigSettings>): RigGeometry {
  return Object.freeze({
    handleLength: settings.handleLength,
    maxExtension: settings.maxExtension,
    minExtension: -settings.handleLength,
    // Float sums such as 2.05 + 0.55 land just off their decimal; nanometres keep the reach equal to it.
    maxReach: Math.round((settings.handleLength + settings.maxExtension) * 1e9) / 1e9,
    segmentLength: settings.handleLength / RIG.handleSegments,
  });
}

export function sameRig(left: Readonly<RigSettings>, right: Readonly<RigSettings>): boolean {
  return left.handleLength === right.handleLength && left.maxExtension === right.maxExtension;
}
