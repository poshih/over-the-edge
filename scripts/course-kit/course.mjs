// The level builder of a generated course (see docs/course-kit.md). Set pieces come from the Workshop's
// library through placeSetPiece, so a course uses the library's own prefabs; everything else is
// ordinary terrain, triggers, enemies and labels, grouped so the checks can tell them apart.
import { CourseLevelError, CourseQueryError } from './errors.mjs';

/** @typedef {import('../../src/level.ts').TerrainMesh} TerrainMesh */
/** @typedef {import('./job.mjs').CourseJob} CourseJob */
/**
 * @typedef {object} TerrainOptions
 * @property {number} [angle]
 * @property {number} [depth]
 * @property {boolean} [mirror]
 * @property {string} [tone]
 * @property {number} [color]
 * @property {boolean} [illusion]
 * @property {import('../../src/surfaces.ts').Surface} [surface]
 * @property {string} [group]
 * @property {string} [allowIn]
 * @property {boolean} [support]
 */

// A small deterministic generator, so a seed always builds the same course.
export function random(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

const tidy = (value, digits = 4) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new CourseLevelError({ field: 'coordinate or dimension', value });
  return Number(value.toFixed(digits)) + 0;
};

export class CourseBuilder {
  /** @param {Pick<typeof import('../../src/editor/set-pieces.ts'), 'setPieceById' | 'placeSetPiece'>} library @param {CourseJob} job */
  constructor(library, job) {
    if (typeof library?.setPieceById !== 'function' || typeof library?.placeSetPiece !== 'function' ||
      typeof job?.validateObject !== 'function' || typeof job?.worldBounds !== 'function' ||
      typeof job?.engine?.level?.shapeMesh !== 'function') {
      throw new CourseQueryError('QUERY_CAPABILITY_UNSUPPORTED', { capability: 'CourseBuilder(library, job)' },
        'CourseBuilder needs the engine set-piece library and a course job.');
    }
    this.library = library;
    this.job = job;
    this.objects = [];
    this.labels = [];
    // Every object's group: a placed piece, or a named connector group of a zone.
    this.groups = new Map();
    this.pieces = [];
    this.counters = new Map();
    this.zone = null;
    this.zones = [];
    // Designed moves the conservative reach check cannot see, such as a fling or a hidden vent.
    this.links = [];
    // Objects deliberately built inside a set piece's bounds, as `<object>|<piece>`.
    this.allowed = new Set();
    // The ground built under set pieces: it may merge with neighbouring connectors.
    this.supports = new Set();
    // How often each piece has been placed in each zone, as `<zone>:<piece>`.
    this.placements = new Map();
  }

  beginZone(zone) {
    this.zone = zone;
    this.zones.push(zone);
  }

  id(name) {
    const key = `${this.zone.code}-${name}`;
    const count = (this.counters.get(key) ?? 0) + 1;
    this.counters.set(key, count);
    return `${key}-${count}`;
  }

  add(object, group) {
    if (this.groups.has(object.id)) throw new CourseLevelError({ field: 'duplicate object ID', value: object.id }, object.id);
    this.job.validateObject(object);
    this.objects.push(object);
    this.groups.set(object.id, { group, zone: this.zone.code });
    return object;
  }

  color(tone, explicit) {
    if (explicit !== undefined) return explicit;
    const color = this.zone.palette[tone];
    if (color === undefined) throw new CourseLevelError({ field: `zone ${this.zone.code} palette tone`, value: tone });
    return color;
  }

  /**
   * Terrain brings its engine collision explicitly, including a GLB's compound slice.
   * @param {string} name @param {TerrainMesh} mesh
   * @param {number} x @param {number} y @param {number} width @param {number} height
   * @param {TerrainOptions} [options]
   */
  terrain(name, mesh, x, y, width, height, options = {}) {
    const angle = options.angle ?? 0;
    if (typeof angle !== 'number' || !Number.isFinite(angle) || angle < -Math.PI || angle > Math.PI) {
      throw new CourseLevelError({ field: 'terrain angle in [-π, π]', value: angle });
    }
    const object = {
      kind: 'terrain', id: this.id(name), mesh, x: tidy(x), y: tidy(y),
      width: tidy(width), height: tidy(height), angle: Math.max(-Math.PI, Math.min(Math.PI, tidy(angle, 6))),
      depth: options.depth ?? 1.5, mirror: options.mirror ?? false,
      color: this.color(options.tone ?? 'rock', options.color),
      illusion: options.illusion ?? false,
      surface: options.surface ?? 'rock',
    };
    if (options.allowIn) this.allowed.add(`${object.id}|${options.allowIn}`);
    if (options.support) this.supports.add(object.id);
    return this.add(object, options.group ?? `${this.zone.code}:${name}`);
  }

  block(name, left, bottom, width, height, options) {
    return this.terrain(name, this.job.engine.level.shapeMesh('box'), left + width / 2, bottom + height / 2, width, height, options);
  }

  // A right triangle whose vertical side is on the right (rising to the right), or on the left when mirrored.
  ramp(name, left, bottom, width, height, options = {}) {
    return this.terrain(name, this.job.engine.level.shapeMesh('ramp'), left + width / 2, bottom + height / 2, width, height, options);
  }

  peak(name, left, bottom, width, height, options) {
    return this.terrain(name, this.job.engine.level.shapeMesh('triangle'), left + width / 2, bottom + height / 2, width, height, options);
  }

  // A triangle hanging point-down from `top`, such as an icicle or a stalactite.
  fang(name, centerX, top, width, height, options = {}) {
    return this.terrain(name, this.job.engine.level.shapeMesh('triangle'), centerX, top - height / 2, width, height, { ...options, angle: Math.PI });
  }

  hex(name, centerX, bottom, width, height, options) {
    return this.terrain(name, this.job.engine.level.shapeMesh('hexagon'), centerX, bottom + height / 2, width, height, options);
  }

  // A rotated board whose underside runs from (x1, y1) to (x2, y2); its thickness extends upward.
  plank(name, x1, y1, x2, y2, thickness, options = {}) {
    const length = Math.hypot(x2 - x1, y2 - y1);
    const flip = x2 < x1 || (x2 === x1 && y2 < y1) ? -1 : 1;
    const ux = (x2 - x1) / length * flip;
    const uy = (y2 - y1) / length * flip;
    return this.terrain(name, this.job.engine.level.shapeMesh('box'), (x1 + x2) / 2 - uy * thickness / 2, (y1 + y2) / 2 + ux * thickness / 2, length, thickness,
      { ...options, angle: Math.atan2(uy, ux) });
  }

  trigger(name, x, y, region, events, options = {}) {
    return this.add({
      kind: 'trigger', id: this.id(name), name: options.title ?? name, x: tidy(x), y: tidy(y), region,
      activation: options.activation ?? 'once', marker: options.marker ?? 'none', events,
    }, options.group ?? `${this.zone.code}:${name}`);
  }

  // A message the player meets at (x, y), with an optional sound first.
  message(name, x, y, title, message, options = {}) {
    const events = [];
    if (options.sound) events.push({ type: 'play-sound', source: options.sound, volume: options.volume ?? 0.8 });
    events.push({ type: 'message', title, message });
    const region = options.region ?? { type: 'box', width: options.width ?? 3, height: options.height ?? 3 };
    return this.trigger(name, x, y, region, events, { title, marker: options.marker });
  }

  // An updraft whose base sits on `bottom`; the player rises `lift` metres above where it enters.
  vent(name, centerX, bottom, lift, options = {}) {
    const width = options.width ?? 2;
    const height = options.height ?? 1.4;
    return this.trigger(name, centerX, bottom + height / 2, { type: 'box', width, height },
      [{ type: 'launch-player', height: tidy(lift), strength: options.strength ?? 1 }],
      { activation: 'on-enter', marker: options.hidden ? 'none' : 'updraft', title: options.title ?? 'Updraft', group: options.group });
  }

  // Scenery: a library model standing on (x, y) at depth z, `height` tall. It never collides.
  decoration(name, model, x, y, z, height, options = {}) {
    return this.add({
      kind: 'decoration', id: this.id(name), model, x: tidy(x), y: tidy(y), z: tidy(z), height: tidy(height),
      angle: Math.max(-Math.PI, Math.min(Math.PI, tidy(options.angle ?? 0, 6))), mirror: options.mirror ?? false, tint: options.tint ?? 0xffffff,
    }, `${this.zone.code}:scenery`);
  }

  // A bonfire whose base stands on (x, y): reached, it is where a fallen player comes back. It never collides.
  bonfire(name, x, y) {
    return this.add({ kind: 'bonfire', id: this.id(name), x: tidy(x), y: tidy(y) }, `${this.zone.code}:bonfires`);
  }

  enemy(species, x, base, facing, patrolDistance, speed, options = {}) {
    const height = species === 'bird' ? 0.8 : 1.4;
    return this.add({
      kind: 'enemy', id: this.id(species === 'bird' ? 'crow' : 'hollow'), species, x: tidy(x), y: tidy(base + height / 2),
      facing, patrolDistance, speed,
    }, options.group ?? `${this.zone.code}:enemies`);
  }

  label(x, y, text) {
    if (text.length > 34) throw new CourseLevelError({ field: 'label text (at most 34 characters)', value: text });
    this.labels.push({ x: tidy(x), y: tidy(y), text });
  }

  // A designed move from one point to another that the conservative reach check would miss.
  link(from, to, why) {
    this.links.push({ from, to, why });
  }

  /**
   * The stamp the next placement of piece `id` in this zone takes: the zone's code the first time, then
   * `<zone>-2`, `<zone>-3` and so on, so a piece placed again gets IDs of its own.
   */
  pieceStamp(id) {
    const count = (this.placements.get(`${this.zone.code}:${id}`) ?? 0) + 1;
    return count === 1 ? this.zone.code : `${this.zone.code}-${count}`;
  }

  /** The group of the next placement of piece `id`: every placement is checked as its own piece. */
  pieceGroup(id) {
    return `piece:${id}:${this.pieceStamp(id)}`;
  }

  /**
   * Places a library set piece with its base centre at (x, y). `recolor` maps the piece's own colours
   * to tones of the zone's palette, or `tone` recolours every part; `retune` edits a placed part, such
   * as a message's words. `direction: 'down'` marks a piece that is only traversed downward.
   */
  piece(id, x, y, options = {}) {
    const { setPieceById, placeSetPiece } = this.library;
    const piece = setPieceById(id);
    const stamp = this.pieceStamp(id);
    const group = this.pieceGroup(id);
    this.placements.set(`${this.zone.code}:${id}`, (this.placements.get(`${this.zone.code}:${id}`) ?? 0) + 1);
    const placement = placeSetPiece(piece, { x, y }, { mirror: options.mirror ?? false, stamp });
    const placed = [];
    for (const object of placement.objects) {
      let next = object;
      if (object.kind === 'terrain') {
        const tone = options.recolor?.[object.color] ?? options.tone;
        if (tone !== undefined) next = { ...next, color: this.color(tone) };
      }
      if (options.retune) next = options.retune(next) ?? next;
      placed.push(this.add(next, group));
    }
    for (const label of placement.labels) this.labels.push(options.retuneLabel ? options.retuneLabel(label) : label);
    const record = {
      id, zone: this.zone.code, stamp, group, anchor: { x, y }, mirror: options.mirror ?? false, objects: placed,
      bounds: this.job.worldBounds(placed.filter((object) => object.kind === 'terrain')), direction: options.direction ?? 'any',
    };
    this.pieces.push(record);
    return record;
  }

  // The level in the engine's current format, `schemaVersion` (src/level.ts LEVEL_SCHEMA_VERSION).
  level(schemaVersion) {
    return { schemaVersion, labels: this.labels, objects: this.objects };
  }
}
