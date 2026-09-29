// Trigger messages as toasts. An arcane seal gathers where the words will stand and draws a rule of
// light outward; the words materialise as its beams pass them. Once the player has had time to read,
// the words burn away into embers from the ends inward and the seal collapses into a last flash.
// The magic is procedural: closed-form curves, easing and a curl flow field, drawn on one small canvas
// with a fixed particle pool, all on one clock that pauses with the toasts. Toasts never pause the
// game or take input, show one at a time, and cost nothing while none is showing.
import './message-toast.css';
import type { MessageAction } from './trigger-events';

// Seconds, except where noted.
export const MESSAGE_TOAST = {
  // How long a toast stays readable once its words have appeared: a base plus time per character.
  hold: { base: 1.4, perCharacter: 0.058, min: 3.2, max: 14 },
  // While another message waits, a toast leaves once it has been readable this long.
  hurried: { perCharacter: 1 / 24, min: 2.6 },
  // Messages kept waiting behind the one showing; another distinct message reports an event failure.
  waiting: 3,
} as const;

export interface MessageToastStatus {
  readonly showing: {
    readonly title: string;
    readonly message: string;
    readonly phase: 'appearing' | 'showing' | 'leaving';
  } | null;
  readonly waiting: number;
}

// CSS pixels of canvas beyond the toast on every side, room for the magic to spill out.
const MARGIN = 60;
// The longest step one frame may advance a toast; a longer gap, such as a hidden tab, holds it.
const MAX_FRAME = 0.05;
const SEAL = { radius: 20, draw: [0.12, 0.78], contract: [0.95, 1.5] } as const;
const BEAMS = { start: 0.42, duration: 0.85, sparksPerSecond: 70 } as const;
const REVEAL = { title: 0.6, text: 0.55, textLag: 0.12, lineLag: 0.28 } as const;
// A toast leaving in its own time, and one dismissed because the run restarted.
const LEAVE = { spread: 0.75, title: 0.65, text: 0.55, implode: 0.8, veil: [0.3, 1.25], end: 1.35 } as const;
const QUICK = { spread: 0.18, title: 0.3, text: 0.3, implode: 0.22, veil: [0, 0.4], end: 0.45 } as const;
// With reduced motion, a toast only fades in and out.
const STILL = { appear: 0.45, leave: 0.5, quick: 0.25 } as const;
// Embers from the words: at most this many for the message text, however long it is.
const TEXT_EMBERS = 70;
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
const TAU = Math.PI * 2;

const clamp01 = (value: number): number => value < 0 ? 0 : value > 1 ? 1 : value;
const smoothstep = (from: number, to: number, value: number): number => {
  const u = clamp01((value - from) / (to - from));
  return u * u * (3 - 2 * u);
};
const easeOutCubic = (u: number): number => 1 - (1 - u) ** 3;
const easeOutQuad = (u: number): number => 1 - (1 - u) * (1 - u);
const easeInOutCubic = (u: number): number => u < 0.5 ? 4 * u * u * u : 1 - (-2 * u + 2) ** 3 / 2;
const decimal = (value: number): string => value.toFixed(2);

// FNV-1a, so a message always gathers and burns the same way.
function hashText(text: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

// Mulberry32: small, fast and uniform enough for sparks.
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), state | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
function graphemes(text: string): string[] {
  return Array.from(segmenter.segment(text), (part) => part.segment);
}

// A swirl with no sources or sinks, so embers eddy without bunching: the curl of
// ψ(x, y, t) = sin(ax + 0.6t)·cos(by − 0.4t) + c·sin(d(x + y) + 0.9t), in CSS pixels per second.
const FLOW = { a: 0.021, b: 0.017, c: 0.6, d: 0.013, strength: 900 } as const;
function flowX(x: number, y: number, time: number): number {
  return FLOW.strength * (-FLOW.b * Math.sin(FLOW.a * x + 0.6 * time) * Math.sin(FLOW.b * y - 0.4 * time) +
    FLOW.c * FLOW.d * Math.cos(FLOW.d * (x + y) + 0.9 * time));
}
function flowY(x: number, y: number, time: number): number {
  return -FLOW.strength * (FLOW.a * Math.cos(FLOW.a * x + 0.6 * time) * Math.cos(FLOW.b * y - 0.4 * time) +
    FLOW.c * FLOW.d * Math.cos(FLOW.d * (x + y) + 0.9 * time));
}

// The seal's two figures, sampled once at unit radius: a five-lobed hypotrochoid (the spirograph of a
// circle of radius 3 rolling inside one of radius 5, pen 5 from its centre) and an eight-petalled rose.
function sampleCurve(points: number, turn: number, at: (angle: number) => readonly [number, number]): Float32Array {
  const samples = new Float32Array((points + 1) * 2);
  for (let index = 0; index <= points; index++) {
    const [x, y] = at(turn * index / points);
    samples[index * 2] = x;
    samples[index * 2 + 1] = y;
  }
  return samples;
}
const RUNE = sampleCurve(240, 6 * Math.PI, (angle) =>
  [(2 * Math.cos(angle) + 5 * Math.cos(2 * angle / 3)) / 7, (2 * Math.sin(angle) - 5 * Math.sin(2 * angle / 3)) / 7]);
const ROSE = sampleCurve(160, TAU, (angle) => [Math.cos(4 * angle) * Math.cos(angle), Math.cos(4 * angle) * Math.sin(angle)]);

const HOT = 0;
const GOLD = 1;
const EMBER = 2;
const ARCANE = 3;
const GOLD_STROKE = 'rgb(255, 208, 128)';
const ARCANE_STROKE = 'rgb(188, 206, 255)';
const GEM_FILL = 'rgb(255, 238, 200)';

// Glow sprites per tint, the rule's beam, drawn once and shared by every toast.
interface ToastArt {
  readonly glows: readonly HTMLCanvasElement[];
  readonly rule: HTMLCanvasElement;
}

function sprite(width: number, height: number, paint: (context: CanvasRenderingContext2D) => void): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (context !== null) paint(context);
  return canvas;
}

function glow(core: string, rgb: string): HTMLCanvasElement {
  return sprite(64, 64, (context) => {
    const gradient = context.createRadialGradient(32, 32, 0, 32, 32, 32);
    gradient.addColorStop(0, `rgb(${core} / 100%)`);
    gradient.addColorStop(0.16, `rgb(${rgb} / 90%)`);
    gradient.addColorStop(0.45, `rgb(${rgb} / 28%)`);
    gradient.addColorStop(1, `rgb(${rgb} / 0%)`);
    context.fillStyle = gradient;
    context.fillRect(0, 0, 64, 64);
  });
}

function createArt(): ToastArt {
  return {
    glows: [
      glow('255 253 247', '255 244 222'), glow('255 246 222', '255 200 116'),
      glow('255 214 170', '255 112 48'), glow('246 248 255', '176 198 255'),
    ],
    // Brightest at the centre and fading toward both ends, with a soft halo around a fine core.
    rule: sprite(512, 16, (context) => {
      const along = context.createLinearGradient(0, 0, 512, 0);
      along.addColorStop(0, 'rgb(255 200 116 / 0%)');
      along.addColorStop(0.14, 'rgb(255 200 116 / 55%)');
      along.addColorStop(0.5, 'rgb(255 246 226 / 100%)');
      along.addColorStop(0.86, 'rgb(255 200 116 / 55%)');
      along.addColorStop(1, 'rgb(255 200 116 / 0%)');
      context.fillStyle = along;
      context.globalAlpha = 0.16;
      context.fillRect(0, 2, 512, 12);
      context.globalAlpha = 0.38;
      context.fillRect(0, 6, 512, 4);
      context.globalAlpha = 1;
      context.fillRect(0, 7.25, 512, 1.5);
    }),
  };
}

const SPARK_CAPACITY = 320;
// Drifts with the flow field and rises, like an ember; otherwise it coasts to a stop.
const FLOWS = 1;
// Cools from white through gold to ember red over its life, flickering.
const COOLS = 2;

// A fixed pool of glowing particles in parallel arrays: nothing is allocated per frame, and a dead
// particle's slot is filled from the end so live ones stay packed.
class Sparks {
  private readonly x = new Float32Array(SPARK_CAPACITY);
  private readonly y = new Float32Array(SPARK_CAPACITY);
  private readonly vx = new Float32Array(SPARK_CAPACITY);
  private readonly vy = new Float32Array(SPARK_CAPACITY);
  private readonly age = new Float32Array(SPARK_CAPACITY);
  private readonly life = new Float32Array(SPARK_CAPACITY);
  private readonly size = new Float32Array(SPARK_CAPACITY);
  private readonly tint = new Uint8Array(SPARK_CAPACITY);
  private readonly flags = new Uint8Array(SPARK_CAPACITY);
  count = 0;

  add(x: number, y: number, vx: number, vy: number, life: number, size: number, tint: number, flags: number): void {
    if (this.count === SPARK_CAPACITY) return;
    const index = this.count++;
    this.x[index] = x;
    this.y[index] = y;
    this.vx[index] = vx;
    this.vy[index] = vy;
    this.age[index] = 0;
    this.life[index] = life;
    this.size[index] = size;
    this.tint[index] = tint;
    this.flags[index] = flags;
  }

  clear(): void {
    this.count = 0;
  }

  step(dt: number, time: number): void {
    const coast = Math.exp(-3 * dt);
    const drift = Math.exp(-1.2 * dt);
    for (let index = 0; index < this.count;) {
      const age = this.age[index]! + dt;
      if (age >= this.life[index]!) {
        this.remove(index);
        continue;
      }
      this.age[index] = age;
      const x = this.x[index]!;
      const y = this.y[index]!;
      if ((this.flags[index]! & FLOWS) !== 0) {
        // Heat rises: embers gain a little lift as the flow carries them.
        const vx = this.vx[index]! * drift;
        const vy = this.vy[index]! * drift - 22 * dt;
        this.vx[index] = vx;
        this.vy[index] = vy;
        this.x[index] = x + (vx + flowX(x, y, time)) * dt;
        this.y[index] = y + (vy + flowY(x, y, time)) * dt;
      } else {
        const vx = this.vx[index]! * coast;
        const vy = this.vy[index]! * coast;
        this.vx[index] = vx;
        this.vy[index] = vy;
        this.x[index] = x + vx * dt;
        this.y[index] = y + vy * dt;
      }
      index++;
    }
  }

  draw(context: CanvasRenderingContext2D, art: ToastArt): void {
    for (let index = 0; index < this.count; index++) {
      const progress = this.age[index]! / this.life[index]!;
      let alpha = Math.min(1, progress / 0.12) * Math.min(1, (1 - progress) / 0.45);
      let tint = this.tint[index]!;
      if ((this.flags[index]! & COOLS) !== 0) {
        tint = progress < 0.22 ? HOT : progress < 0.58 ? GOLD : EMBER;
        alpha *= 0.78 + 0.22 * Math.sin(this.age[index]! * 23 + index * 1.7);
      }
      if (alpha <= 0.01) continue;
      const size = this.size[index]! * (1 - 0.35 * progress);
      context.globalAlpha = alpha;
      context.drawImage(art.glows[tint]!, this.x[index]! - size / 2, this.y[index]! - size / 2, size, size);
    }
  }

  private remove(index: number): void {
    const last = --this.count;
    if (index === last) return;
    this.x[index] = this.x[last]!;
    this.y[index] = this.y[last]!;
    this.vx[index] = this.vx[last]!;
    this.vy[index] = this.vy[last]!;
    this.age[index] = this.age[last]!;
    this.life[index] = this.life[last]!;
    this.size[index] = this.size[last]!;
    this.tint[index] = this.tint[last]!;
    this.flags[index] = this.flags[last]!;
  }
}

const HIDDEN = 0;
const REVEALING = 1;
const SHOWN = 2;
const LEAVING = 3;
const GONE = 4;
const WISPS = 8;
const MOTES = 26;

// A letter of the title or a word of the text, animated as one.
interface Glyph {
  readonly element: HTMLElement;
  readonly title: boolean;
  readonly seed: number;
  // Centre in canvas CSS pixels.
  x: number;
  y: number;
  reveal: number;
  leave: number;
  // How far the flow carries it sideways as it burns away.
  drift: number;
  // Its opacity when it began to leave.
  presence: number;
  state: number;
}

function part<K extends keyof HTMLElementTagNameMap>(tag: K, className: string): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  element.className = className;
  return element;
}

// One message, from the seal gathering to the last ember. Its clock starts once it has been laid out.
class Toast {
  readonly message: MessageAction;
  private readonly root: HTMLElement;
  private readonly veil: HTMLElement;
  private readonly title: HTMLElement;
  private readonly rule: HTMLElement;
  private readonly text: HTMLElement;
  private readonly canvas: HTMLCanvasElement | null;
  private readonly context: CanvasRenderingContext2D | null;
  // Reduced motion: the toast fades in and out, without magic.
  private readonly still: boolean;
  private readonly glyphs: Glyph[] = [];
  private readonly textWords: number;
  private readonly random: () => number;
  private readonly art: ToastArt;
  private readonly sparks: Sparks;
  private readonly observer: ResizeObserver;
  private readonly hold: number;
  private readonly hurriedHold: number;
  private readonly wisps: Float32Array;
  private readonly motes: Float32Array;
  private hurried: boolean;
  private time = 0;
  private dirty = true;
  private scheduled = false;
  private discarded = false;
  private shownAt = Infinity;
  private leavingAt: number | null = null;
  private quick = false;
  private imploded = false;
  private beamSparks = 0;
  private rootOpacity = -1;
  private veilOpacity = -1;
  // Geometry, in canvas CSS pixels.
  private scale = 1;
  private width = 0;
  private height = 0;
  private centre = 0;
  private middle = 0;
  private ruleY = 0;
  private ruleHalf = 48;
  private ruleAtLeave = 0;
  private textTop = 0;
  private textHeight = 1;
  private titleLeft = 0;
  private titleRight = 0;
  private titleTop = 0;
  private titleBottom = 0;

  constructor(layer: HTMLElement, message: MessageAction, options: {
    readonly hurried: boolean;
    readonly still: boolean;
    readonly art: ToastArt;
    readonly sparks: Sparks;
  }) {
    this.message = message;
    this.hurried = options.hurried;
    this.art = options.art;
    this.sparks = options.sparks;
    this.random = seededRandom(hashText(`${message.title}\n${message.message}`));
    this.root = part('section', 'message-toast');
    // The layer's announcer speaks for the toast; split into letters, it would be read out one by one.
    this.root.setAttribute('aria-hidden', 'true');
    this.veil = part('div', 'message-toast-veil');
    this.title = part('h2', 'message-toast-title');
    this.rule = part('div', 'message-toast-rule');
    this.text = part('p', 'message-toast-text');
    this.fillTitle(message.title);
    this.textWords = this.fillText(message.message);
    this.root.append(this.veil, this.title, this.rule, this.text);
    const canvas = options.still ? null : part('canvas', 'message-toast-magic');
    this.context = canvas?.getContext('2d') ?? null;
    this.canvas = this.context === null ? null : canvas;
    this.still = this.canvas === null;
    if (this.canvas !== null) this.root.append(this.canvas);
    else this.root.classList.add('message-toast--still');
    const characters = graphemes(message.title).length + graphemes(message.message).length;
    const { hold, hurried } = MESSAGE_TOAST;
    this.hold = Math.min(hold.max, Math.max(hold.min, hold.base + characters * hold.perCharacter));
    this.hurriedHold = Math.min(this.hold, Math.max(hurried.min, characters * hurried.perCharacter));
    this.wisps = new Float32Array(WISPS * 8).map(() => this.random());
    this.motes = new Float32Array(MOTES * 3).map(() => this.random());
    layer.append(this.root);
    this.observer = new ResizeObserver(() => { this.dirty = true; });
    this.observer.observe(this.root);
  }

  get phase(): 'appearing' | 'showing' | 'leaving' {
    return this.leavingAt !== null ? 'leaving' : this.time < this.shownAt ? 'appearing' : 'showing';
  }

  get done(): boolean {
    if (this.discarded) return true;
    if (this.leavingAt === null) return false;
    const elapsed = this.time - this.leavingAt;
    if (this.still) return elapsed >= (this.quick ? STILL.quick : STILL.leave);
    const end = (this.quick ? QUICK : LEAVE).end;
    // The last embers may drift a little longer, but never hold up the next message for long.
    return elapsed >= end && (this.sparks.count === 0 || elapsed >= end + 2.5);
  }

  // Another message is waiting: leave once the words have been readable for the hurried time.
  hurry(): void {
    this.hurried = true;
  }

  // The run restarted: leave now, quickly. A toast that never appeared is simply dropped.
  dismiss(): void {
    if (!this.scheduled) this.discarded = true;
    else if (this.leavingAt === null) this.leave(true);
    else if (!this.quick) {
      this.quick = true;
      for (const glyph of this.glyphs) {
        const from = clamp01(Math.abs(glyph.x - this.centre) / this.ruleHalf);
        const leave = this.time + QUICK.spread * (0.85 * (1 - from) + 0.15 * glyph.seed) + (glyph.title ? 0 : 0.06);
        glyph.leave = Math.min(glyph.leave, leave);
      }
    }
  }

  remove(): void {
    this.observer.disconnect();
    this.root.remove();
  }

  private fillTitle(title: string): void {
    for (const [index, word] of title.split(/\s+/).filter((value) => value !== '').entries()) {
      if (index > 0) this.title.append(' ');
      // Letters animate on their own, but a word only wraps as a whole.
      const wrapper = part('span', 'message-toast-word');
      for (const letter of graphemes(word)) wrapper.append(this.glyph(letter, true));
      this.title.append(wrapper);
    }
  }

  private fillText(message: string): number {
    let words = 0;
    for (const [index, line] of message.split(/\r?\n/).entries()) {
      if (index > 0) this.text.append(document.createElement('br'));
      for (const [position, word] of line.split(/\s+/).filter((value) => value !== '').entries()) {
        if (position > 0) this.text.append(' ');
        this.text.append(this.glyph(word, false));
        words++;
      }
    }
    return words;
  }

  private glyph(content: string, title: boolean): HTMLElement {
    const element = part('span', 'message-toast-glyph');
    element.textContent = content;
    this.glyphs.push({
      element, title, seed: this.random(), x: 0, y: 0, reveal: Infinity, leave: Infinity, drift: 0, presence: 0, state: HIDDEN,
    });
    return element;
  }

  // Reads the layout once, and again whenever the toast changes size; offsets ignore the glyphs' transforms.
  private measure(): void {
    const width = this.root.offsetWidth;
    const height = this.root.offsetHeight;
    // Not laid out, as in a hidden view: the toast waits until it is.
    if (width === 0 || height === 0) return;
    this.dirty = false;
    this.width = width + 2 * MARGIN;
    this.height = height + 2 * MARGIN;
    this.centre = MARGIN + width / 2;
    this.middle = MARGIN + height / 2;
    this.ruleY = MARGIN + this.rule.offsetTop + this.rule.offsetHeight / 2;
    this.textTop = MARGIN + this.text.offsetTop;
    this.textHeight = Math.max(1, this.text.offsetHeight);
    this.titleTop = MARGIN + this.title.offsetTop;
    this.titleBottom = this.titleTop + this.title.offsetHeight;
    let extent = 0;
    let titleLeft = Infinity;
    let titleRight = -Infinity;
    for (const glyph of this.glyphs) {
      const { element } = glyph;
      const parent = glyph.title ? this.title : this.text;
      const half = element.offsetWidth / 2;
      glyph.x = MARGIN + parent.offsetLeft + element.offsetLeft + half;
      glyph.y = MARGIN + parent.offsetTop + element.offsetTop + element.offsetHeight / 2;
      extent = Math.max(extent, Math.abs(glyph.x - this.centre) + half);
      if (!glyph.title) continue;
      titleLeft = Math.min(titleLeft, glyph.x - half);
      titleRight = Math.max(titleRight, glyph.x + half);
    }
    this.titleLeft = Number.isFinite(titleLeft) ? titleLeft : this.centre;
    this.titleRight = Number.isFinite(titleRight) ? titleRight : this.centre;
    this.ruleHalf = Math.min(width / 2 - 6, Math.max(48, extent + 20));
    if (this.canvas !== null) {
      this.scale = Math.min(window.devicePixelRatio || 1, 2);
      const { style } = this.canvas;
      style.left = `${-MARGIN}px`;
      style.top = `${-MARGIN}px`;
      style.width = `${this.width}px`;
      style.height = `${this.height}px`;
      this.canvas.width = Math.round(this.width * this.scale);
      this.canvas.height = Math.round(this.height * this.scale);
    }
    if (!this.scheduled) this.schedule();
  }

  // Each glyph appears as the beam's front, easing out from the centre, passes it; the text follows
  // a moment later, line by line.
  private schedule(): void {
    this.scheduled = true;
    if (this.still) {
      this.shownAt = STILL.appear;
      return;
    }
    let shown = BEAMS.start + BEAMS.duration + 0.2;
    for (const glyph of this.glyphs) {
      const from = clamp01(Math.abs(glyph.x - this.centre) / this.ruleHalf);
      const beam = BEAMS.start + BEAMS.duration * (1 - Math.cbrt(1 - from));
      glyph.reveal = glyph.title ? beam - 0.05 + glyph.seed * 0.06
        : beam + REVEAL.textLag + REVEAL.lineLag * clamp01((glyph.y - this.textTop) / this.textHeight) + glyph.seed * 0.05;
      shown = Math.max(shown, glyph.reveal + (glyph.title ? REVEAL.title : REVEAL.text));
    }
    this.shownAt = shown;
  }

  advance(dt: number): void {
    if (this.dirty) this.measure();
    if (!this.scheduled) return;
    this.time += dt;
    if (this.leavingAt === null && this.time >= this.shownAt + (this.hurried ? this.hurriedHold : this.hold)) this.leave(false);
    if (this.still) {
      const leaving = this.leavingAt === null ? 0 : clamp01((this.time - this.leavingAt) / (this.quick ? STILL.quick : STILL.leave));
      this.rootOpacity = fade(this.root, clamp01(this.time / STILL.appear) * (1 - leaving), this.rootOpacity);
      return;
    }
    this.updateGlyphs();
    let veil = smoothstep(0, 0.6, this.time);
    if (this.leavingAt !== null) {
      const [from, to] = (this.quick ? QUICK : LEAVE).veil;
      veil *= 1 - smoothstep(from, to, this.time - this.leavingAt);
    }
    this.veilOpacity = fade(this.veil, veil, this.veilOpacity);
    this.emitBeams(dt);
    this.sparks.step(dt, this.time);
    this.draw();
  }

  // The words leave from the ends inward, the way the beams brought them, with the beams retracting ahead.
  private leave(quick: boolean): void {
    this.ruleAtLeave = this.ruleExtent();
    this.leavingAt = this.time;
    this.quick = quick;
    const { spread } = quick ? QUICK : LEAVE;
    for (const glyph of this.glyphs) {
      const from = clamp01(Math.abs(glyph.x - this.centre) / this.ruleHalf);
      glyph.leave = this.time + spread * (0.85 * (1 - from) + 0.15 * glyph.seed) + (glyph.title ? 0 : 0.06);
      glyph.drift = Math.max(-14, Math.min(14, flowX(glyph.x, glyph.y, this.time) * 0.6)) + (glyph.seed - 0.5) * 8;
    }
  }

  // How far each beam reaches from the centre: easing out as it is drawn, retracting as the words leave.
  private ruleExtent(): number {
    if (this.leavingAt === null) return this.ruleHalf * easeOutCubic(clamp01((this.time - BEAMS.start) / BEAMS.duration));
    const { spread } = this.quick ? QUICK : LEAVE;
    return this.ruleAtLeave * (1 - clamp01((this.time - this.leavingAt) / (0.85 * spread)));
  }

  // Only glyphs in motion are written to; a shown or gone glyph costs nothing per frame.
  private updateGlyphs(): void {
    const { time } = this;
    for (const glyph of this.glyphs) {
      if (glyph.state === GONE) continue;
      if (time >= glyph.leave) this.leaveGlyph(glyph, time);
      else if (glyph.state !== SHOWN && time >= glyph.reveal) this.revealGlyph(glyph, time);
    }
  }

  // A glyph condenses out of the beam: it rises from the rule's line into place, sharpening and settling.
  private revealGlyph(glyph: Glyph, time: number): void {
    const { style } = glyph.element;
    if (glyph.state === HIDDEN) {
      glyph.state = REVEALING;
      this.burst(glyph);
    }
    const progress = clamp01((time - glyph.reveal) / (glyph.title ? REVEAL.title : REVEAL.text));
    if (progress >= 1) {
      glyph.state = SHOWN;
      glyph.presence = 1;
      style.opacity = '1';
      style.transform = '';
      style.filter = '';
      return;
    }
    const rest = 1 - easeOutCubic(progress);
    glyph.presence = easeOutQuad(progress);
    style.opacity = decimal(glyph.presence);
    if (glyph.title) {
      const dx = (this.centre - glyph.x) * 0.08 * rest;
      const dy = Math.max(-14, Math.min(14, (this.ruleY - glyph.y) * 0.45)) * rest;
      style.transform = `translate(${decimal(dx)}px, ${decimal(dy)}px) rotate(${decimal((glyph.seed - 0.5) * 14 * rest)}deg) ` +
        `scale(${decimal(1 + 0.22 * rest)})`;
      style.filter = `blur(${decimal(7 * rest)}px)`;
    } else {
      const dy = Math.max(-12, Math.min(12, (this.ruleY - glyph.y) * 0.25)) * rest;
      style.transform = `translateY(${decimal(dy)}px) scale(${decimal(1 + 0.06 * rest)})`;
    }
  }

  // A glyph burns away: it lifts on the heat, drifts with the flow, blurs and fades, shedding embers.
  private leaveGlyph(glyph: Glyph, time: number): void {
    const { style } = glyph.element;
    if (glyph.state === HIDDEN) {
      glyph.state = GONE;
      return;
    }
    if (glyph.state !== LEAVING) {
      glyph.state = LEAVING;
      this.embers(glyph);
    }
    const timing = this.quick ? QUICK : LEAVE;
    const progress = clamp01((time - glyph.leave) / (glyph.title ? timing.title : timing.text));
    if (progress >= 1) {
      glyph.state = GONE;
      style.opacity = '0';
      style.filter = '';
      return;
    }
    const eased = progress * progress;
    style.opacity = decimal(glyph.presence * (1 - eased));
    if (glyph.title) {
      style.transform = `translate(${decimal(glyph.drift * eased)}px, ${decimal(-22 * eased)}px) ` +
        `rotate(${decimal((glyph.seed - 0.5) * 18 * eased)}deg) scale(${decimal(1 + 0.1 * eased)})`;
      style.filter = `blur(${decimal(6 * eased)}px)`;
    } else {
      style.transform = `translate(${decimal(glyph.drift * 0.5 * eased)}px, ${decimal(-12 * eased)}px)`;
    }
  }

  // Sparks where a glyph condenses: a few from every title letter, fanned by the golden angle.
  private burst(glyph: Glyph): void {
    const { random } = this;
    if (glyph.title) {
      for (let spark = 0; spark < 4; spark++) {
        const angle = glyph.seed * TAU + spark * GOLDEN_ANGLE;
        const speed = 34 + 36 * random();
        this.sparks.add(glyph.x, glyph.y, Math.cos(angle) * speed, Math.sin(angle) * speed - 10,
          0.35 + 0.25 * random(), 6 + 4 * random(), GOLD, 0);
      }
    } else if (glyph.seed < TEXT_EMBERS / this.textWords) {
      this.sparks.add(glyph.x, glyph.y, (random() - 0.5) * 30, -12 - 18 * random(), 0.4 + 0.25 * random(), 5 + 3 * random(), GOLD, 0);
    }
  }

  private embers(glyph: Glyph): void {
    const { random } = this;
    const count = glyph.title ? (this.quick ? 1 : 3) : glyph.seed < TEXT_EMBERS / this.textWords ? 1 : 0;
    for (let ember = 0; ember < count; ember++) {
      this.sparks.add(glyph.x + (random() - 0.5) * 8, glyph.y + (random() - 0.5) * 10, (random() - 0.5) * 16, -26 - 26 * random(),
        0.9 + 0.6 * random(), 6 + 5 * random(), HOT, FLOWS | COOLS);
    }
  }

  // Sparks stream off the beams' heads while they travel, trailing behind them.
  private emitBeams(dt: number): void {
    const extending = this.leavingAt === null && this.time >= BEAMS.start && this.time < BEAMS.start + BEAMS.duration;
    const half = this.ruleExtent();
    if (!extending && (this.leavingAt === null || half <= 1)) {
      this.beamSparks = 0;
      return;
    }
    const { random } = this;
    for (this.beamSparks += dt * BEAMS.sparksPerSecond; this.beamSparks >= 1; this.beamSparks--) {
      for (let side = -1; side <= 1; side += 2) {
        const trail = extending ? -side : side;
        this.sparks.add(this.centre + side * half, this.ruleY + (random() - 0.5) * 3, trail * (20 + 50 * random()), (random() - 0.5) * 70,
          0.3 + 0.3 * random(), 5 + 4 * random(), HOT, COOLS);
      }
    }
  }

  private draw(): void {
    const context = this.context!;
    const { time } = this;
    const leaving = this.leavingAt === null ? -1 : time - this.leavingAt;
    context.setTransform(this.scale, 0, 0, this.scale, 0, 0);
    context.globalCompositeOperation = 'source-over';
    context.clearRect(0, 0, this.width, this.height);
    // Light adds up: overlapping glows brighten rather than cover each other.
    context.globalCompositeOperation = 'lighter';
    if (time < 0.8) this.drawMotes(context, time);
    this.drawRule(context, time, leaving);
    this.drawSeal(context, time, leaving);
    this.drawWisps(context, time, leaving);
    if (leaving < 0) this.drawGlint(context, time);
    this.sparks.draw(context, this.art);
    context.globalAlpha = 1;
  }

  // Motes spiral in from a golden-angle scatter, drawn into the seal as it forms.
  private drawMotes(context: CanvasRenderingContext2D, time: number): void {
    for (let mote = 0; mote < MOTES; mote++) {
      const progress = time / (0.35 + 0.3 * this.motes[mote * 3 + 2]!);
      if (progress >= 1) continue;
      const spread = this.motes[mote * 3 + 1]!;
      const radius = (70 + 80 * spread) * (1 - progress * progress * progress);
      const angle = mote * GOLDEN_ANGLE + this.motes[mote * 3]! * TAU + 2.4 * progress;
      const x = this.centre + Math.cos(angle) * radius * 1.7;
      const y = this.ruleY + Math.sin(angle) * radius * 0.75;
      const size = 4 + 4 * spread;
      context.globalAlpha = 0.85 * Math.sin(Math.PI * progress) ** 0.8;
      context.drawImage(this.art.glows[mote % 2 === 0 ? ARCANE : GOLD]!, x - size / 2, y - size / 2, size, size);
    }
  }

  private drawRule(context: CanvasRenderingContext2D, time: number, leaving: number): void {
    const half = this.ruleExtent();
    if (half < 0.5) return;
    const { centre, ruleY } = this;
    const drawnAt = BEAMS.start + BEAMS.duration;
    // Once drawn, the rule breathes gently while the words are read.
    const breath = leaving < 0 && time > drawnAt ? 0.88 + 0.12 * Math.sin(1.7 * time) : 1;
    context.globalAlpha = breath;
    context.drawImage(this.art.rule, centre - half, ruleY - 8, half * 2, 16);
    if (leaving >= 0 || time < drawnAt) {
      context.globalAlpha = 0.9;
      for (let side = -1; side <= 1; side += 2) {
        context.drawImage(this.art.glows[HOT]!, centre + side * half - 13, ruleY - 13, 26, 26);
      }
    }
    const ends = leaving < 0 ? smoothstep(drawnAt - 0.1, drawnAt + 0.3, time) : 0;
    if (ends <= 0.01) return;
    context.globalAlpha = ends * breath;
    context.fillStyle = GOLD_STROKE;
    for (let side = -1; side <= 1; side += 2) diamond(context, centre + side * (half + 8), ruleY, 3.2);
  }

  // The seal: a ring, a spirograph rune and a rose, traced as they appear and turning against each
  // other, then contracting into a gem that pulses until the words leave and it implodes.
  private drawSeal(context: CanvasRenderingContext2D, time: number, leaving: number): void {
    const { centre, ruleY } = this;
    const drawn = smoothstep(SEAL.draw[0], SEAL.draw[1], time);
    const contracted = smoothstep(SEAL.contract[0], SEAL.contract[1], time);
    const seal = smoothstep(0.02, 0.25, time) * (1 - contracted) * (leaving < 0 ? 1 : 1 - smoothstep(0, 0.2, leaving));
    if (seal > 0.01) {
      const radius = SEAL.radius * (1 - 0.55 * easeInOutCubic(contracted));
      const start = -Math.PI / 2 + 0.4 * time;
      context.lineCap = 'round';
      context.beginPath();
      context.arc(centre, ruleY, radius * 1.22, start, start + TAU * drawn);
      strokeGlowing(context, GOLD_STROKE, seal);
      trace(context, RUNE, Math.floor(drawn * (RUNE.length / 2 - 1)) + 1, centre, ruleY, radius, 0.7 * time);
      strokeGlowing(context, ARCANE_STROKE, seal);
      trace(context, ROSE, Math.floor(drawn * (ROSE.length / 2 - 1)) + 1, centre, ruleY, radius * 0.55, -1.1 * time);
      strokeGlowing(context, GOLD_STROKE, seal * 0.6);
      context.beginPath();
      for (let tick = 0; tick < 16 && tick < drawn * 16; tick++) {
        const angle = tick / 16 * TAU - 0.9 * time;
        const cos = Math.cos(angle);
        const sin = Math.sin(angle);
        const outer = radius * (tick % 2 === 0 ? 1.72 : 1.56);
        context.moveTo(centre + cos * radius * 1.42, ruleY + sin * radius * 1.42);
        context.lineTo(centre + cos * outer, ruleY + sin * outer);
      }
      strokeGlowing(context, GOLD_STROKE, seal * 0.8);
    }
    const { implode } = this.quick ? QUICK : LEAVE;
    let gem = smoothstep(1, 1.45, time);
    if (leaving >= 0) gem *= 1 - smoothstep(implode - 0.06, implode, leaving);
    if (gem > 0.01) {
      const pulse = 0.5 + 0.5 * Math.sin(2.4 * time);
      const size = 20 + 8 * pulse;
      context.globalAlpha = 0.55 * gem;
      context.drawImage(this.art.glows[GOLD]!, centre - size / 2, ruleY - size / 2, size, size);
      context.globalAlpha = gem;
      context.fillStyle = GEM_FILL;
      diamond(context, centre, ruleY, 3.6 + 1.1 * pulse);
    }
    if (leaving < implode) return;
    if (!this.imploded) {
      this.imploded = true;
      this.ring();
    }
    const flash = (leaving - implode) / 0.3;
    if (flash >= 1) return;
    const size = 24 + 70 * flash;
    context.globalAlpha = 0.9 * (1 - flash) ** 2;
    context.drawImage(this.art.glows[HOT]!, centre - size / 2, ruleY - size / 2, size, size);
  }

  private ring(): void {
    const { random } = this;
    const count = this.quick ? 10 : 18;
    for (let spark = 0; spark < count; spark++) {
      const angle = spark / count * TAU + random() * 0.2;
      const speed = 110 + 60 * random();
      this.sparks.add(this.centre, this.ruleY, Math.cos(angle) * speed, Math.sin(angle) * speed * 0.6,
        0.45 + 0.3 * random(), 7 + 4 * random(), HOT, COOLS);
    }
  }

  // Wisps orbit the words on Lissajous paths, twinkling, while they are read.
  private drawWisps(context: CanvasRenderingContext2D, time: number, leaving: number): void {
    let presence = smoothstep(this.shownAt - 0.5, this.shownAt + 0.5, time);
    if (leaving >= 0) presence *= 1 - smoothstep(0, 0.45, leaving);
    if (presence <= 0.01) return;
    const reachY = this.height / 2 - MARGIN + 10;
    const { wisps } = this;
    for (let wisp = 0; wisp < WISPS; wisp++) {
      const at = wisp * 8;
      const x = this.centre + this.ruleHalf * (0.55 + 0.4 * wisps[at]!) * Math.sin((0.35 + 0.45 * wisps[at + 2]!) * time + TAU * wisps[at + 4]!);
      const y = this.middle + reachY * (0.45 + 0.45 * wisps[at + 1]!) * Math.sin((0.5 + 0.6 * wisps[at + 3]!) * time + TAU * wisps[at + 5]!);
      const twinkle = 0.5 + 0.5 * Math.sin((1.6 + 1.4 * wisps[at + 6]!) * time + TAU * wisps[at + 7]!);
      const size = 5 + 4 * wisps[at + 6]!;
      context.globalAlpha = presence * (0.15 + 0.55 * twinkle * twinkle * twinkle);
      context.drawImage(this.art.glows[wisp % 2 === 0 ? GOLD : ARCANE]!, x - size / 2, y - size / 2, size, size);
    }
  }

  // Now and then a sheen passes over the title.
  private drawGlint(context: CanvasRenderingContext2D, time: number): void {
    const since = time - this.shownAt - 0.8;
    if (since < 0 || this.titleRight <= this.titleLeft) return;
    const cycle = since % 5.2;
    if (cycle >= 1.3) return;
    const progress = cycle / 1.3;
    const x = this.titleLeft - 40 + (this.titleRight - this.titleLeft + 80) * easeInOutCubic(progress);
    context.globalAlpha = 0.24 * Math.sin(Math.PI * progress);
    context.drawImage(this.art.glows[HOT]!, x - 28, this.titleTop - 7, 56, this.titleBottom - this.titleTop + 14);
  }
}

// Traces the first `count` points of a sampled curve, turned by `angle` and scaled to `radius`.
function trace(context: CanvasRenderingContext2D, curve: Float32Array, count: number, x: number, y: number,
  radius: number, angle: number): void {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  context.beginPath();
  for (let index = 0; index < count; index++) {
    const px = curve[index * 2]!;
    const py = curve[index * 2 + 1]!;
    const pointX = x + radius * (px * cos - py * sin);
    const pointY = y + radius * (px * sin + py * cos);
    if (index === 0) context.moveTo(pointX, pointY);
    else context.lineTo(pointX, pointY);
  }
}

// Strokes the current path twice: wide and faint for the glow, then fine and bright for the line.
function strokeGlowing(context: CanvasRenderingContext2D, color: string, alpha: number): void {
  context.strokeStyle = color;
  context.globalAlpha = alpha * 0.3;
  context.lineWidth = 3.2;
  context.stroke();
  context.globalAlpha = alpha;
  context.lineWidth = 1.1;
  context.stroke();
}

function diamond(context: CanvasRenderingContext2D, x: number, y: number, size: number): void {
  context.beginPath();
  context.moveTo(x, y - size);
  context.lineTo(x + size, y);
  context.lineTo(x, y + size);
  context.lineTo(x - size, y);
  context.closePath();
  context.fill();
}

// Writes an opacity only when it visibly changes; returns what the element now shows.
function fade(element: HTMLElement, opacity: number, shown: number): number {
  if (Math.abs(opacity - shown) < 0.004) return shown;
  element.style.opacity = decimal(opacity);
  return opacity;
}

/**
 * The message toasts of one game view. Messages show one at a time, each after the one before it has
 * gone; a waiting message hurries the one showing, and a message already showing or waiting is not
 * queued again. Animation frames drive them only while one is showing, and hold while a modal
 * presentation covers the game; a hidden page holds them too, since it gets no frames.
 */
export class MessageToasts {
  private readonly mount: HTMLElement;
  private readonly sparks = new Sparks();
  private readonly waiting: MessageAction[] = [];
  private art: ToastArt | null = null;
  private layer: HTMLElement | null = null;
  private announcer: HTMLElement | null = null;
  private announcement: string | null = null;
  private current: Toast | null = null;
  private held = false;
  private disposed = false;
  private frameRequest = 0;
  private previous: number | null = null;

  constructor(options: { readonly mount: HTMLElement }) {
    this.mount = options.mount;
  }

  show(message: MessageAction): boolean {
    if (this.disposed) return false;
    const same = (other: MessageAction): boolean => other.title === message.title && other.message === message.message;
    const current = this.current;
    if (current !== null && !current.done && current.phase !== 'leaving' && same(current.message)) return true;
    if (this.waiting.some(same)) return true;
    if (this.waiting.length >= MESSAGE_TOAST.waiting) return false;
    this.waiting.push(message);
    if (current === null) this.next();
    else current.hurry();
    this.request();
    return true;
  }

  // The run restarted: the toast showing leaves quickly, and waiting ones are dropped.
  clear(): void {
    this.waiting.length = 0;
    this.announcement = null;
    if (this.announcer !== null) this.announcer.textContent = '';
    this.current?.dismiss();
    this.request();
  }

  setHeld(held: boolean): void {
    if (held === this.held) return;
    this.held = held;
    if (!held) {
      this.request();
      return;
    }
    cancelAnimationFrame(this.frameRequest);
    this.frameRequest = 0;
    this.previous = null;
  }

  inspect(): MessageToastStatus {
    const current = this.current;
    return {
      showing: current === null ? null : { title: current.message.title, message: current.message.message, phase: current.phase },
      waiting: this.waiting.length,
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    cancelAnimationFrame(this.frameRequest);
    this.frameRequest = 0;
    this.current?.remove();
    this.current = null;
    this.waiting.length = 0;
    this.announcement = null;
    this.sparks.clear();
    this.layer?.remove();
    this.layer = null;
    this.announcer = null;
    this.art = null;
  }

  private next(): void {
    const message = this.waiting.shift();
    if (message === undefined) return;
    if (this.layer === null) {
      this.layer = part('div', 'message-toasts');
      this.announcer = part('p', 'visually-hidden');
      this.announcer.setAttribute('aria-live', 'polite');
      this.announcer.setAttribute('aria-atomic', 'true');
      this.layer.append(this.announcer);
      this.mount.append(this.layer);
    }
    this.art ??= createArt();
    this.sparks.clear();
    this.current = new Toast(this.layer, message, {
      hurried: this.waiting.length > 0, still: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
      art: this.art, sparks: this.sparks,
    });
    const announcer = this.announcer;
    if (announcer === null) throw new Error('The message toast announcer was not created.');
    // Clearing first makes the same message announce again when an on-enter trigger repeats.
    announcer.textContent = '';
    // Announced on the next frame, once the live region has been in the page for a moment.
    this.announcement = `${message.title}. ${message.message}`;
  }

  private request(): void {
    if (this.disposed || this.held || this.frameRequest !== 0 || this.current === null) return;
    this.frameRequest = requestAnimationFrame(this.frame);
  }

  private readonly frame = (now: number): void => {
    this.frameRequest = 0;
    const dt = this.previous === null ? 0 : Math.min((now - this.previous) / 1000, MAX_FRAME);
    this.previous = now;
    if (this.announcement !== null && this.announcer !== null) {
      this.announcer.textContent = this.announcement;
      this.announcement = null;
    }
    const toast = this.current;
    if (toast === null) return;
    toast.advance(dt);
    if (toast.done) {
      toast.remove();
      this.current = null;
      this.next();
    }
    if (this.current === null) this.previous = null;
    else this.request();
  };
}
