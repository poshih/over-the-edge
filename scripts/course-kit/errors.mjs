/**
 * @typedef {'CONTACT_ART_UNUSABLE' | 'LEVEL_DATA_INVALID' | 'QUERY_CAPABILITY_UNSUPPORTED' |
 * 'QUERY_WORK_LIMIT' | 'QUERY_NO_STAND_POINT' | 'REACH_MODEL_INVALID' | 'MAP_OPTIONS_INVALID' |
 * 'SCENERY_CAMERA_INVALID'} CourseErrorCode
 * @typedef {{counter: import('../../src/collision-queries.ts').QueryCounter, requested: number, limit: number}} WorkLimitCause
 * @typedef {{field: string, value: unknown}} FieldCause
 * @typedef {{x: number, y: number, radius: number}} StandPointCause
 * @typedef {{capability: string, detail?: unknown, failure?: unknown}} CapabilityCause
 * @typedef {WorkLimitCause | StandPointCause | CapabilityCause | import('../../src/collision-queries.ts').CollisionQueryError} QueryCause
 */

/** @template {CourseErrorCode} Code @template Cause */
export class CourseError extends Error {
  /**
   * @param {Code} code
   * @param {string} message
   * @param {Cause} cause
   * @param {string} repair
   */
  constructor(code, message, cause, repair) {
    super(message, { cause });
    this.name = new.target.name;
    this.code = code;
    /** @type {Cause} */
    this.cause = cause;
    this.repair = repair;
  }
}

/** @extends {CourseError<'CONTACT_ART_UNUSABLE', import('../../src/art-types.ts').ArtError>} */
export class CourseArtError extends CourseError {
  /** @param {string} assetId @param {import('../../src/art-types.ts').ArtError} cause */
  constructor(assetId, cause) {
    super('CONTACT_ART_UNUSABLE', `Cannot derive terrain collision for ${assetId}: ${cause.message}`, cause,
      'Close or simplify the GLB middle section, or deliberately declare supported simple collision; derive it again.');
    this.assetId = assetId;
  }
}

/** @extends {CourseError<'LEVEL_DATA_INVALID', import('../../src/level.ts').LevelError | FieldCause>} */
export class CourseLevelError extends CourseError {
  /** @param {import('../../src/level.ts').LevelError | FieldCause} cause @param {string | null} [objectId] */
  constructor(cause, objectId = null) {
    const detail = cause instanceof Error ? cause.message : `Invalid ${cause.field}: ${String(cause.value)}.`;
    super('LEVEL_DATA_INVALID', `${objectId === null ? '' : `${objectId}: `}${detail}`, cause,
      'Correct the named fields, topology, circle dimensions or level limits, then prepare the level again.');
    this.objectId = objectId;
  }
}

/** @extends {CourseError<'QUERY_CAPABILITY_UNSUPPORTED' | 'QUERY_WORK_LIMIT' | 'QUERY_NO_STAND_POINT', QueryCause>} */
export class CourseQueryError extends CourseError {
  /**
   * @param {'QUERY_CAPABILITY_UNSUPPORTED' | 'QUERY_WORK_LIMIT' | 'QUERY_NO_STAND_POINT'} code
   * @param {QueryCause} cause
   * @param {string} message
   */
  constructor(code, cause, message) {
    const repair = code === 'QUERY_WORK_LIMIT'
      ? 'Simplify or partition the authoring job, or explicitly raise its work budget; no candidates were silently omitted.'
      : code === 'QUERY_NO_STAND_POINT'
        ? 'Move the anchor to an eligible resting surface, or revise the explicitly supplied reach model or anchor radius.'
        : 'Load matching engine modules and supply the named supported capability or valid query options; never substitute bounds for collision.';
    super(code, message, cause, repair);
  }
}

/** @extends {CourseError<'REACH_MODEL_INVALID', FieldCause>} */
export class ReachModelError extends CourseError {
  /** @param {string} field @param {unknown} value @param {string} message */
  constructor(field, value, message) {
    super('REACH_MODEL_INVALID', message, { field, value },
      'Supply the complete finite reach model, with every field and array documented in docs/course-kit.md.');
  }
}

/** @extends {CourseError<'MAP_OPTIONS_INVALID', FieldCause>} */
export class CourseMapError extends CourseError {
  /** @param {string} field @param {unknown} value @param {string} message */
  constructor(field, value, message) {
    super('MAP_OPTIONS_INVALID', message, { field, value },
      'Correct the map options; empty terrain needs an explicit finite, positive viewport.');
  }
}

/** @extends {CourseError<'SCENERY_CAMERA_INVALID', FieldCause>} */
export class SceneryCameraError extends CourseError {
  /** @param {string} field @param {unknown} value @param {string} message */
  constructor(field, value, message) {
    super('SCENERY_CAMERA_INVALID', message, { field, value },
      'Use a perspective theme camera with a finite fieldOfView between 0 and 180 degrees.');
  }
}
