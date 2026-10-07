import type { ArtError } from '../../src/art-types.ts';
import type { CollisionQueryError, QueryCounter } from '../../src/collision-queries.ts';
import type { LevelError } from '../../src/level.ts';

export type CourseErrorCode = 'CONTACT_ART_UNUSABLE' | 'LEVEL_DATA_INVALID' | 'QUERY_CAPABILITY_UNSUPPORTED' |
  'QUERY_WORK_LIMIT' | 'QUERY_NO_STAND_POINT' | 'REACH_MODEL_INVALID' | 'MAP_OPTIONS_INVALID' | 'SCENERY_CAMERA_INVALID';
export interface WorkLimitCause { counter: QueryCounter; requested: number; limit: number }
export interface FieldCause { field: string; value: unknown }
export interface StandPointCause { x: number; y: number; radius: number }
export interface CapabilityCause { capability: string; detail?: unknown; failure?: unknown }
export type QueryCause = WorkLimitCause | StandPointCause | CapabilityCause | CollisionQueryError;

export class CourseError<Code extends CourseErrorCode, Cause> extends Error {
  declare readonly code: Code;
  declare readonly cause: Cause;
  declare readonly repair: string;

  constructor(code: Code, message: string, cause: Cause, repair: string) {
    super(message, { cause });
    this.name = new.target.name;
    this.code = code;
    this.cause = cause;
    this.repair = repair;
  }
}

export class CourseArtError extends CourseError<'CONTACT_ART_UNUSABLE', ArtError> {
  declare readonly assetId: string;

  constructor(assetId: string, cause: ArtError) {
    super('CONTACT_ART_UNUSABLE', `Cannot derive terrain collision for ${assetId}: ${cause.message}`, cause,
      'Close or simplify the GLB middle section, or deliberately declare supported simple collision; derive it again.');
    this.assetId = assetId;
  }
}

export class CourseLevelError extends CourseError<'LEVEL_DATA_INVALID', LevelError | FieldCause> {
  declare readonly objectId: string | null;

  constructor(cause: LevelError | FieldCause, objectId: string | null = null) {
    const detail = cause instanceof Error ? cause.message : `Invalid ${cause.field}: ${String(cause.value)}.`;
    super('LEVEL_DATA_INVALID', `${objectId === null ? '' : `${objectId}: `}${detail}`, cause,
      'Correct the named fields, topology, circle dimensions or level limits, then prepare the level again.');
    this.objectId = objectId;
  }
}

export class CourseQueryError extends CourseError<'QUERY_CAPABILITY_UNSUPPORTED' | 'QUERY_WORK_LIMIT' | 'QUERY_NO_STAND_POINT', QueryCause> {
  constructor(code: CourseQueryError['code'], cause: QueryCause, message: string) {
    const repair = code === 'QUERY_WORK_LIMIT'
      ? 'Simplify or partition the authoring job, or explicitly raise its work budget; no candidates were silently omitted.'
      : code === 'QUERY_NO_STAND_POINT'
        ? 'Move the anchor to an eligible resting surface, or revise the explicitly supplied reach model or anchor radius.'
        : 'Load matching engine modules and supply the named supported capability or valid query options; never substitute bounds for collision.';
    super(code, message, cause, repair);
  }
}

export class ReachModelError extends CourseError<'REACH_MODEL_INVALID', FieldCause> {
  constructor(field: string, value: unknown, message: string) {
    super('REACH_MODEL_INVALID', message, { field, value },
      'Supply the complete finite reach model, with every field and array documented in docs/course-kit.md.');
  }
}

export class CourseMapError extends CourseError<'MAP_OPTIONS_INVALID', FieldCause> {
  constructor(field: string, value: unknown, message: string) {
    super('MAP_OPTIONS_INVALID', message, { field, value },
      'Correct the map options; empty terrain needs an explicit finite, positive viewport.');
  }
}

export class SceneryCameraError extends CourseError<'SCENERY_CAMERA_INVALID', FieldCause> {
  constructor(field: string, value: unknown, message: string) {
    super('SCENERY_CAMERA_INVALID', message, { field, value },
      'Use a perspective theme camera with a finite fieldOfView between 0 and 180 degrees.');
  }
}
