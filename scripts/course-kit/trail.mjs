// A cursor that walks the course: floors, stairs and set pieces are added where the last element
// ended, so the route stays continuous. `dir` is +1 travelling right and -1 travelling left.
import { PIECE_PATHS } from './pieces.mjs';

const tidy = (value) => Number(value.toFixed(4)) + 0;

export class Trail {
  constructor(builder, rng, x, y, dir = 1) {
    this.b = builder;
    this.rng = rng;
    this.x = x;
    this.y = y;
    this.dir = dir;
  }

  between(range) {
    return Array.isArray(range) ? range[0] + this.rng() * (range[1] - range[0]) : range;
  }

  at(x, y) {
    this.x = x;
    this.y = y;
    return this;
  }

  go(dx) {
    this.x += this.dir * dx;
    return this;
  }

  // To a set piece's far side, keeping the height.
  edge(record) {
    this.x = this.dir > 0 ? record.bounds.right : record.bounds.left;
    return this;
  }

  turn() {
    this.dir = -this.dir;
    return this;
  }

  point(dx = 0, dy = 0) {
    return { x: tidy(this.x + this.dir * dx), y: tidy(this.y + dy) };
  }

  // A flat platform from the cursor, `length` metres ahead, its top at the cursor's height.
  floor(length, options = {}) {
    const thickness = options.thickness ?? 1;
    const back = options.back ?? 0;
    const left = this.dir > 0 ? this.x - back : this.x - length;
    this.b.block(options.name ?? 'floor', left, this.y - thickness, length + back, thickness, options);
    this.x += this.dir * length;
    return this;
  }

  // One step up or down to a platform `dx` ahead whose top is `dy` above the cursor.
  step(dx, dy, width, options = {}) {
    const thickness = options.thickness ?? this.between([0.5, 0.9]);
    const near = this.x + this.dir * dx;
    const left = this.dir > 0 ? near : near - width;
    this.b.block(options.name ?? 'step', left, this.y + dy - thickness, width, thickness, options);
    this.x = near + this.dir * width;
    this.y += dy;
    return this;
  }

  /**
   * Steps that climb `rise` metres while advancing `run` metres, each within connector reach. The run
   * is covered by steps in a row, each clear of the one below it; any rise they cannot cover comes
   * first from a switchback, whose steps alternate sides so none roofs the step beneath it. The motif
   * chooses shapes: shelves, slabs, crates, rocks or columns standing on `floor`.
   */
  stairs(run, rise, motif = {}) {
    const maxRise = motif.rise ?? 1.55;
    let inline = run < 1.45 ? 0 : Math.max(1, Math.ceil(run / 3.2));
    while (inline > 1 && run / inline < 1.45) inline--;
    const inlineRise = Math.min(rise, inline * maxRise);
    let switchback = Math.ceil((rise - inlineRise) / maxRise - 1e-9);
    if (switchback % 2 === 0 && switchback > 0) switchback += 1;
    const switchRise = rise - inlineRise;
    const shapes = motif.shapes ?? ['shelf'];
    const shape = (final) => final && motif.last ? motif.last : shapes[Math.floor(this.rng() * shapes.length)];
    // Switchback: ahead steps start past the divider, back steps end before it; the divider wanders.
    let divider = this.x + this.dir * this.between([0.3, 0.7]);
    let y = this.y;
    let exit = null;
    for (let index = 1; index <= switchback; index++) {
      const ahead = index % 2 === 1;
      const width = this.between(motif.width ?? [1.5, 2.2]);
      y = this.y + switchRise * index / switchback + (index === switchback ? 0 : this.between([-0.15, 0.15]));
      const near = ahead ? divider : divider - this.dir * this.between([0.4, 0.85]);
      const center = ahead ? near + this.dir * width / 2 : near - this.dir * width / 2;
      this.stepShape(shape(inline === 0 && index === switchback), center, y, width, motif, 'switchback');
      if (ahead) exit = { x: center + this.dir * width / 2, y };
      else divider = near + this.dir * this.between([0.4, 0.85]);
    }
    if (exit !== null) {
      this.x = exit.x;
      this.y = exit.y;
    }
    const along = inline === 0 ? 0 : run / inline;
    const base = this.y;
    for (let index = 1; index <= inline; index++) {
      const gap = this.between([0.25, Math.min(1.1, Math.max(0.3, along - 1.3))]);
      const width = Math.min(2.8, Math.max(1.2, along - gap));
      const top = base + inlineRise * index / inline + (index === inline ? 0 : this.between([-0.15, 0.15]));
      const center = this.x + this.dir * (gap + width / 2);
      this.stepShape(shape(index === inline), center, top, width, motif, 'inline');
      this.x = center + this.dir * width / 2;
      this.y = top;
    }
    return this;
  }

  stepShape(shape, center, top, width, motif, placement = 'inline') {
    const b = this.b;
    const name = motif.name ?? 'stair';
    const tone = motif.tones ? motif.tones[Math.floor(this.rng() * motif.tones.length)] : motif.tone;
    const style = { tone, depth: motif.depth ?? this.between([1.2, 2]), surface: motif.surface };
    if (shape === 'column' && placement === 'inline' && motif.floor !== undefined && top - motif.floor <= 12) {
      b.block(name, center - width / 2, motif.floor, width, top - motif.floor, style);
    } else if (shape === 'slab') {
      const tilt = this.between([0.08, 0.2]) * (this.rng() < 0.5 ? -1 : 1);
      const thickness = this.between([0.35, 0.55]);
      b.plank(name, center - width / 2, top - thickness - tilt, center + width / 2, top - thickness + tilt, thickness, style);
    } else if (shape === 'crate') {
      const height = this.between([0.9, 1.3]);
      b.block(name, center - width / 2, top - height, width, height, style);
    } else if (shape === 'rock' && placement === 'inline') {
      const height = this.between([1, 1.5]);
      // A hexagon's flat top is half its width.
      b.hex(name, center, top - height, width * 2, height, style);
    } else {
      const thickness = this.between(motif.thickness ?? [0.45, 0.85]);
      b.block(name, center - width / 2, top - thickness, width, thickness, style);
    }
  }

  /**
   * Places a set piece so that its designed entry is at the cursor, adds the ground it needs, and
   * moves the cursor to its designed exit. Travelling left mirrors the piece's orientation.
   */
  piece(id, options = {}) {
    const path = PIECE_PATHS[id];
    if (path === undefined) throw new Error(`No travel path for set piece ${id}.`);
    const mirror = (path.mirror ?? false) !== (this.dir < 0);
    const flip = this.dir;
    const x = this.x - flip * path.entry[0] + this.dir * (options.gap ?? 0);
    const y = this.y - path.entry[1] + (options.lift ?? 0);
    if (path.floor !== null && options.floor !== false) {
      const [from, to] = path.floor;
      const left = x + Math.min(from * flip, to * flip);
      const right = x + Math.max(from * flip, to * flip);
      // The ground a piece stands on is part of its design, so it shares the piece's group.
      this.b.block(options.floorName ?? 'ground', left, y - (options.floorThickness ?? 1), right - left, options.floorThickness ?? 1,
        { tone: options.floorTone ?? 'rock', depth: options.floorDepth ?? 1.6, surface: options.floorSurface, group: this.b.pieceGroup(id), support: true });
    }
    const record = this.b.piece(id, x, y, { ...options, mirror, direction: path.down ? 'down' : 'any' });
    const exit = options.exit ?? path.exit;
    this.x = x + flip * exit[0];
    this.y = y + exit[1];
    record.entry = { x: x + flip * path.entry[0], y: y + path.entry[1] };
    record.exit = { x: this.x, y: this.y };
    // The piece's designed approach leads through it to its designed exit, and on to any other way
    // off it; the keep-out check guards its space.
    const designed = { x: x + flip * path.exit[0], y: y + path.exit[1] };
    this.b.link(record.entry, designed, `enter ${id}`);
    if (options.exit) this.b.link(designed, record.exit, `leave ${id}`);
    return record;
  }
}
