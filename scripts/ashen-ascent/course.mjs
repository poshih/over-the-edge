// The level builder behind scripts/ashen-ascent/generate.mjs. Set pieces come from the Workshop's
// library through placeSetPiece, so the example uses the library's own prefabs; everything else is
// ordinary terrain, triggers, enemies and labels, grouped so the checks can tell them apart.

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

const tidy = (value, digits = 4) => Number(value.toFixed(digits)) + 0;

export class CourseBuilder {
  constructor(library) {
    this.library = library;
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
    if (this.groups.has(object.id)) throw new Error(`Duplicate object ID ${object.id}.`);
    this.objects.push(object);
    this.groups.set(object.id, { group, zone: this.zone.code });
    return object;
  }

  color(tone, explicit) {
    if (explicit !== undefined) return explicit;
    const color = this.zone.palette[tone];
    if (color === undefined) throw new Error(`Zone ${this.zone.code} has no "${tone}" colour.`);
    return color;
  }

  // Terrain in the zone's palette: `tone` names one of its colours.
  terrain(name, type, x, y, width, height, options = {}) {
    const object = {
      kind: 'terrain', id: this.id(name), shape: { type }, x: tidy(x), y: tidy(y), width: tidy(width), height: tidy(height),
      angle: Math.max(-Math.PI, Math.min(Math.PI, tidy(options.angle ?? 0, 6))), depth: options.depth ?? 1.5,
      color: this.color(options.tone ?? 'rock', options.color),
      illusion: options.illusion ?? false,
    };
    if (options.allowIn) this.allowed.add(`${object.id}|${options.allowIn}`);
    if (options.support) this.supports.add(object.id);
    return this.add(object, options.group ?? `${this.zone.code}:${name}`);
  }

  block(name, left, bottom, width, height, options) {
    return this.terrain(name, 'box', left + width / 2, bottom + height / 2, width, height, options);
  }

  // A right triangle whose vertical side is on the right (rising to the right), or on the left when mirrored.
  ramp(name, left, bottom, width, height, options = {}) {
    if (options.mirror) {
      return this.terrain(name, 'ramp', left + width / 2, bottom + height / 2, height, width, { ...options, angle: -Math.PI / 2 });
    }
    return this.terrain(name, 'ramp', left + width / 2, bottom + height / 2, width, height, options);
  }

  peak(name, left, bottom, width, height, options) {
    return this.terrain(name, 'triangle', left + width / 2, bottom + height / 2, width, height, options);
  }

  // A triangle hanging point-down from `top`, such as an icicle or a stalactite.
  fang(name, centerX, top, width, height, options = {}) {
    return this.terrain(name, 'triangle', centerX, top - height / 2, width, height, { ...options, angle: Math.PI });
  }

  hex(name, centerX, bottom, width, height, options) {
    return this.terrain(name, 'hexagon', centerX, bottom + height / 2, width, height, options);
  }

  // A rotated board whose underside runs from (x1, y1) to (x2, y2); its thickness extends upward.
  plank(name, x1, y1, x2, y2, thickness, options = {}) {
    const length = Math.hypot(x2 - x1, y2 - y1);
    const flip = x2 < x1 || (x2 === x1 && y2 < y1) ? -1 : 1;
    const ux = (x2 - x1) / length * flip;
    const uy = (y2 - y1) / length * flip;
    return this.terrain(name, 'box', (x1 + x2) / 2 - uy * thickness / 2, (y1 + y2) / 2 + ux * thickness / 2, length, thickness,
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

  enemy(species, x, base, facing, patrolDistance, speed, options = {}) {
    const height = species === 'bird' ? 0.8 : 1.4;
    return this.add({
      kind: 'enemy', id: this.id(species === 'bird' ? 'crow' : 'hollow'), species, x: tidy(x), y: tidy(base + height / 2),
      facing, patrolDistance, speed,
    }, options.group ?? `${this.zone.code}:enemies`);
  }

  label(x, y, text) {
    if (text.length > 34) throw new Error(`Label "${text}" is longer than a label sprite shows.`);
    this.labels.push({ x: tidy(x), y: tidy(y), text });
  }

  // A designed move from one point to another that the conservative reach check would miss.
  link(from, to, why) {
    this.links.push({ from, to, why });
  }

  /**
   * Places a library set piece with its base centre at (x, y). `recolor` maps the piece's own colours
   * to tones of the zone's palette, or `tone` recolours every part; `retune` edits a placed part, such
   * as a message's words. `direction: 'down'` marks a piece that is only traversed downward.
   */
  piece(id, x, y, options = {}) {
    const { setPieceById, placeSetPiece } = this.library;
    const piece = setPieceById(id);
    const placement = placeSetPiece(piece, { x, y }, { mirror: options.mirror ?? false, stamp: this.zone.code });
    const group = `piece:${id}`;
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
      id, zone: this.zone.code, anchor: { x, y }, mirror: options.mirror ?? false, objects: placed,
      bounds: worldBounds(placed.filter((object) => object.kind === 'terrain')), direction: options.direction ?? 'any',
    };
    this.pieces.push(record);
    return record;
  }

  level() {
    return { schemaVersion: 4, labels: this.labels, objects: this.objects };
  }
}

// Unit outlines, as src/level.ts defines them.
export const UNIT = {
  box: [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]],
  ramp: [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5]],
  triangle: [[-0.5, -0.5], [0.5, -0.5], [0, 0.5]],
  hexagon: [[0.5, 0], [0.25, 0.5], [-0.25, 0.5], [-0.5, 0], [-0.25, -0.5], [0.25, -0.5]],
  circle: Array.from({ length: 32 }, (_, index) => [Math.cos(index * Math.PI / 16) / 2, Math.sin(index * Math.PI / 16) / 2]),
};

export function outline(object) {
  const cosine = Math.cos(object.angle);
  const sine = Math.sin(object.angle);
  return UNIT[object.shape.type].map(([unitX, unitY]) => {
    const x = unitX * object.width;
    const y = unitY * object.height;
    return { x: object.x + x * cosine - y * sine, y: object.y + x * sine + y * cosine };
  });
}

export function worldBounds(objects) {
  const points = objects.flatMap(outline);
  return {
    left: Math.min(...points.map((point) => point.x)), right: Math.max(...points.map((point) => point.x)),
    bottom: Math.min(...points.map((point) => point.y)), top: Math.max(...points.map((point) => point.y)),
  };
}
