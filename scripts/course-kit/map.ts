// A map of exactly the prepared authored collision, with world coordinates under one SVG transform.
import { CourseMapError } from './errors.ts';
import type { CourseSnapshot } from './job.ts';
import type { ReachResult } from '../../src/course-checks.ts';
import type { Bounds } from '../../src/collision-queries.ts';
export { CourseMapError } from './errors.ts';

export interface MapOptions {
  sky: readonly string[];
  scale?: number;
  viewport?: Bounds;
  zones?: readonly { name: string; from: number }[];
  reach?: ReachResult;
}
export interface MapCrop extends Bounds { name: string; zoom?: number }

const hex = (color: number) => `#${color.toString(16).padStart(6, '0')}`;
const escape = (text: string) => text.replace(/[&<>"]/g, (character) => `&#${character.charCodeAt(0)};`);
const SKY_STOPS = [0, 0.7, 1];
const COLOR = /^#[0-9a-f]{6}$/i;

export function courseMap(snapshot: CourseSnapshot, options: MapOptions) {
  if (options === null || typeof options !== 'object' || Array.isArray(options) ||
    Object.keys(options).some((field) => !['sky', 'scale', 'viewport', 'zones', 'reach'].includes(field))) {
    throw new CourseMapError('options', options, 'Unknown or invalid course map options.');
  }
  const { sky } = options;
  if (!Array.isArray(sky) || sky.length !== SKY_STOPS.length || !sky.every((color) => typeof color === 'string' && COLOR.test(color))) {
    throw new CourseMapError('sky', sky, `A course map needs ${SKY_STOPS.length} colours such as "#1d1b1f", bottom to top.`);
  }
  const scale = options.scale === undefined ? 6 : options.scale;
  if (!Number.isFinite(scale) || scale <= 0) throw new CourseMapError('scale', scale, 'Map scale must be finite and positive.');
  const viewport = options.viewport === undefined ? (snapshot.bounds === null ? null : {
    left: snapshot.bounds.left - 4, right: snapshot.bounds.right + 4,
    bottom: snapshot.bounds.bottom - 4, top: snapshot.bounds.top + 12,
  }) : options.viewport;
  if (viewport === null || ![viewport.left, viewport.right, viewport.bottom, viewport.top].every(Number.isFinite) ||
    viewport.left >= viewport.right || viewport.bottom >= viewport.top) {
    throw new CourseMapError('viewport', viewport, 'A map needs terrain bounds or an explicit finite, positive viewport.');
  }
  const { left, right, bottom, top } = viewport, width = (right - left) * scale, height = (top - bottom) * scale;
  if (![width, height].every(Number.isFinite) || width <= 0 || height <= 0) {
    throw new CourseMapError('scale', scale, 'Map dimensions must be finite and positive.');
  }
  const zones = options.zones === undefined ? [] : options.zones;
  if (!Array.isArray(zones) || zones.some((zone) => typeof zone?.name !== 'string' || !Number.isFinite(zone.from))) {
    throw new CourseMapError('zones', zones, 'Map zones need a name and a finite from height.');
  }
  if (options.reach !== undefined && (options.reach === null || typeof options.reach !== 'object' || options.reach.snapshot !== snapshot)) {
    throw new CourseMapError('reach', options.reach, 'The reach overlay must come from this same course snapshot.');
  }
  const level = snapshot.level, X = (x: number) => (x - left) * scale, Y = (y: number) => (top - y) * scale;
  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" font-family="monospace" data-map="${escape(JSON.stringify({ left, top, scale }))}">`,
    `<defs><linearGradient id="sky" x1="0" y1="1" x2="0" y2="0">${SKY_STOPS.map((offset, index) =>
      `<stop offset="${offset}" stop-color="${sky[index]}"/>`).join('')}</linearGradient></defs>`,
    '<rect width="100%" height="100%" fill="url(#sky)"/>',
  ];
  for (const zone of zones) {
    parts.push(`<line x1="0" x2="${width}" y1="${Y(zone.from)}" y2="${Y(zone.from)}" stroke="#c9b28a" stroke-opacity="0.25" stroke-dasharray="6 6"/>`);
    parts.push(`<text x="6" y="${Y(zone.from) - 6}" fill="#e6d2a8" font-size="${Math.max(10, scale * 2.2)}" opacity="0.8">${escape(zone.name)} · ${Math.round(zone.from)} m</text>`);
  }
  parts.push(`<g transform="translate(${-left * scale} ${top * scale}) scale(${scale} ${-scale})">`);
  for (const { object, solid } of snapshot.solids) {
    const style = object.illusion
      ? `fill="${hex(object.color)}" fill-opacity="0.35" stroke="#f1e6c8" stroke-width="${1 / scale}" stroke-dasharray="${3 / scale} ${2 / scale}"`
      : `fill="${hex(object.color)}" stroke="#000" stroke-opacity="0.35" stroke-width="${0.6 / scale}"`;
    if (solid.type === 'circle') {
      parts.push(`<circle cx="${solid.center.x}" cy="${solid.center.y}" r="${solid.radius}" ${style}/>`);
    } else {
      const path = solid.loops.map((loop) => `${loop.map((p, index) => `${index === 0 ? 'M' : 'L'}${p.x} ${p.y}`).join(' ')} Z`).join(' ');
      parts.push(`<path d="${path}" fill-rule="evenodd" ${style}/>`);
    }
  }
  for (const object of level.objects.filter((candidate) => candidate.kind === 'trigger')) {
    const launch = object.events.find((event) => event.type === 'launch-player');
    const ending = object.events.some((event) => event.type === 'stop-timer');
    const color = launch ? '#6fd6e0' : ending ? '#ffd35a' : '#e8a446';
    const dash = object.marker === 'none' && launch ? ` stroke-dasharray="${2 / scale} ${3 / scale}"` : '';
    if (object.region.type === 'circle') {
      parts.push(`<circle cx="${object.x}" cy="${object.y}" r="${object.region.radius}" fill="${color}" fill-opacity="0.12" stroke="${color}" stroke-width="${1 / scale}"${dash}/>`);
    } else {
      const w = object.region.width, h = object.region.height;
      parts.push(`<rect x="${object.x - w / 2}" y="${object.y - h / 2}" width="${w}" height="${h}" fill="${color}" fill-opacity="0.15" stroke="${color}" stroke-width="${1 / scale}"${dash}/>`);
    }
    if (launch) {
      const base = snapshot.engine.level.triggerBounds(object).minY;
      parts.push(`<line x1="${object.x}" x2="${object.x}" y1="${base}" y2="${base + launch.height}" stroke="${color}" stroke-opacity="0.6" stroke-width="${1 / scale}" stroke-dasharray="${4 / scale} ${3 / scale}"/>`);
    }
  }
  for (const enemy of level.objects.filter((candidate) => candidate.kind === 'enemy')) {
    const x = enemy.x, y = enemy.y, size = 0.6;
    parts.push(enemy.species === 'bird'
      ? `<polygon points="${x - size},${y - size * 0.6} ${x + size},${y - size * 0.6} ${x},${y + size * 0.8}" fill="#e0443a"/>`
      : `<rect x="${x - size * 0.5}" y="${y - size}" width="${size}" height="${size * 2}" fill="#9d2a2a" stroke="#ffb0a0" stroke-width="${0.6 / scale}"/>`);
    parts.push(`<line x1="${enemy.x - enemy.patrolDistance}" x2="${enemy.x + enemy.patrolDistance}" y1="${y - size - 2 / scale}" y2="${y - size - 2 / scale}" stroke="#e0443a" stroke-opacity="0.5" stroke-width="${1 / scale}"/>`);
  }
  const start = level.objects.find((object) => object.kind === 'start');
  if (start) parts.push(`<circle cx="${start.x}" cy="${start.y}" r="0.8" fill="#6fe07f" stroke="#fff" stroke-width="${1 / scale}"/>`);
  if (options.reach) {
    for (const point of options.reach.points) {
      const seen = options.reach.seen[point.id];
      parts.push(`<circle cx="${point.x}" cy="${point.y}" r="${(seen ? 1.2 : 1.8) / scale}" fill="${seen ? '#7cff9a' : '#ff3df2'}" fill-opacity="${seen ? 0.5 : 0.9}"/>`);
    }
  }
  parts.push('</g>');
  // Text stays upright in pixel space; collision coordinates above are never rounded or re-derived.
  for (const label of level.labels) {
    parts.push(`<text x="${X(label.x)}" y="${Y(label.y)}" fill="#f5e7c4" font-size="${Math.max(8, scale * 0.9)}" text-anchor="middle">${escape(label.text)}</text>`);
  }
  parts.push('</svg>');
  return { svg: parts.join('\n'), left, right, bottom, top, scale };
}

/** Renders map crops to PNG files with Playwright, for reviewing a course without the game. */
export async function renderCrops(map: ReturnType<typeof courseMap>, crops: readonly MapCrop[], directory: string) {
  const { chromium } = await import('playwright');
  const { join } = await import('node:path');
  const body = map.svg.slice(map.svg.indexOf('>') + 1, map.svg.lastIndexOf('</svg>'));
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const files = [];
    for (const crop of crops) {
      const x = (crop.left - map.left) * map.scale;
      const y = (map.top - crop.top) * map.scale;
      const width = (crop.right - crop.left) * map.scale;
      const height = (crop.top - crop.bottom) * map.scale;
      const zoom = crop.zoom ?? 1;
      await page.setViewportSize({ width: Math.ceil(width * zoom), height: Math.ceil(height * zoom) });
      await page.setContent(`<html><body style="margin:0;background:#111"><svg xmlns="http://www.w3.org/2000/svg" viewBox="${x} ${y} ${width} ${height}" width="${width * zoom}" height="${height * zoom}" font-family="monospace">${body}</svg></body></html>`);
      const file = join(directory, `${crop.name}.png`);
      // Headless Chromium occasionally fails a capture of a large SVG; a second attempt succeeds.
      for (let attempt = 1; ; attempt++) {
        try {
          await page.screenshot({ path: file });
          break;
        } catch (error) {
          if (attempt === 3) throw error;
          await page.waitForTimeout(250);
        }
      }
      files.push(file);
    }
    return files;
  } finally {
    await browser.close();
  }
}
