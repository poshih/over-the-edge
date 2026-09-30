// An SVG map of a course, drawn from its geometry: terrain in its own colours (illusions dashed),
// updrafts with their lift, messages, the ending, enemies, labels and the start. `reach` overlays the
// reach check's stand points for debugging. `sky` gives the background gradient's three colours, from
// the bottom of the map to its top.
import { outline } from './course.mjs';

const hex = (color) => `#${color.toString(16).padStart(6, '0')}`;
const escape = (text) => text.replace(/[&<>"]/g, (character) => `&#${character.charCodeAt(0)};`);
// Where the sky's three colours sit, from the bottom of the map to its top.
const SKY_STOPS = [0, 0.7, 1];
const COLOR = /^#[0-9a-f]{6}$/i;

export class CourseMapError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CourseMapError';
  }
}

export function courseMap(level, options) {
  const { sky } = options;
  if (!Array.isArray(sky) || sky.length !== SKY_STOPS.length || !sky.every((color) => typeof color === 'string' && COLOR.test(color))) {
    throw new CourseMapError(`A course map needs options.sky: ${SKY_STOPS.length} colours such as "#1d1b1f", from the bottom of the map to its top.`);
  }
  const scale = options.scale ?? 6;
  const margin = 4;
  const terrain = level.objects.filter((object) => object.kind === 'terrain');
  const points = terrain.flatMap(outline);
  const left = Math.min(...points.map((point) => point.x)) - margin;
  const right = Math.max(...points.map((point) => point.x)) + margin;
  const bottom = Math.min(...points.map((point) => point.y)) - margin;
  const top = Math.max(...points.map((point) => point.y)) + margin + 8;
  const X = (x) => ((x - left) * scale).toFixed(1);
  const Y = (y) => ((top - y) * scale).toFixed(1);
  const width = (right - left) * scale;
  const height = (top - bottom) * scale;
  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width.toFixed(0)} ${height.toFixed(0)}" width="${width.toFixed(0)}" height="${height.toFixed(0)}" font-family="monospace" data-map="${escape(JSON.stringify({ left, top, scale }))}">`,
    `<defs><linearGradient id="sky" x1="0" y1="1" x2="0" y2="0">${SKY_STOPS.map((offset, index) =>
      `<stop offset="${offset}" stop-color="${sky[index]}"/>`).join('')}</linearGradient></defs>`,
    `<rect width="100%" height="100%" fill="url(#sky)"/>`,
  ];
  for (const zone of options.zones ?? []) {
    parts.push(`<line x1="0" x2="${width}" y1="${Y(zone.from)}" y2="${Y(zone.from)}" stroke="#c9b28a" stroke-opacity="0.25" stroke-dasharray="6 6"/>`);
    parts.push(`<text x="6" y="${(Number(Y(zone.from)) - 6).toFixed(1)}" fill="#e6d2a8" font-size="${Math.max(10, scale * 2.2)}" opacity="0.8">${escape(zone.name)} · ${Math.round(zone.from)} m</text>`);
  }
  for (const object of terrain) {
    const path = outline(object).map((point) => `${X(point.x)},${Y(point.y)}`).join(' ');
    parts.push(object.illusion
      ? `<polygon points="${path}" fill="${hex(object.color)}" fill-opacity="0.35" stroke="#f1e6c8" stroke-width="1" stroke-dasharray="3 2"/>`
      : `<polygon points="${path}" fill="${hex(object.color)}" stroke="#000" stroke-opacity="0.35" stroke-width="0.6"/>`);
  }
  for (const object of level.objects.filter((candidate) => candidate.kind === 'trigger')) {
    const launch = object.events.find((event) => event.type === 'launch-player');
    const ending = object.events.some((event) => event.type === 'stop-timer');
    const color = launch ? '#6fd6e0' : ending ? '#ffd35a' : '#e8a446';
    const dash = object.marker === 'none' && launch ? ' stroke-dasharray="2 3"' : '';
    if (object.region.type === 'circle') {
      parts.push(`<circle cx="${X(object.x)}" cy="${Y(object.y)}" r="${(object.region.radius * scale).toFixed(1)}" fill="${color}" fill-opacity="0.12" stroke="${color}"${dash}/>`);
    } else {
      const w = object.region.width;
      const h = object.region.height;
      parts.push(`<rect x="${X(object.x - w / 2)}" y="${Y(object.y + h / 2)}" width="${(w * scale).toFixed(1)}" height="${(h * scale).toFixed(1)}" fill="${color}" fill-opacity="0.15" stroke="${color}"${dash}/>`);
    }
    if (launch) {
      const base = object.y - object.region.height / 2;
      parts.push(`<line x1="${X(object.x)}" x2="${X(object.x)}" y1="${Y(base)}" y2="${Y(base + launch.height)}" stroke="${color}" stroke-opacity="0.6" stroke-dasharray="4 3"/>`);
    }
  }
  for (const enemy of level.objects.filter((candidate) => candidate.kind === 'enemy')) {
    const x = Number(X(enemy.x));
    const y = Number(Y(enemy.y));
    const size = scale * 0.6;
    parts.push(enemy.species === 'bird'
      ? `<polygon points="${x - size},${y + size * 0.6} ${x + size},${y + size * 0.6} ${x},${y - size * 0.8}" fill="#e0443a"/>`
      : `<rect x="${x - size * 0.5}" y="${y - size}" width="${size}" height="${size * 2}" fill="#9d2a2a" stroke="#ffb0a0" stroke-width="0.6"/>`);
    parts.push(`<line x1="${X(enemy.x - enemy.patrolDistance)}" x2="${X(enemy.x + enemy.patrolDistance)}" y1="${y + size + 2}" y2="${y + size + 2}" stroke="#e0443a" stroke-opacity="0.5"/>`);
  }
  for (const label of level.labels) {
    parts.push(`<text x="${X(label.x)}" y="${Y(label.y)}" fill="#f5e7c4" font-size="${Math.max(8, scale * 0.9)}" text-anchor="middle">${escape(label.text)}</text>`);
  }
  const start = level.objects.find((object) => object.kind === 'start');
  if (start) parts.push(`<circle cx="${X(start.x)}" cy="${Y(start.y)}" r="${scale * 0.8}" fill="#6fe07f" stroke="#fff"/>`);
  if (options.reach) {
    for (const point of options.reach.points) {
      const seen = options.reach.seen[point.id];
      parts.push(`<circle cx="${X(point.x)}" cy="${Y(point.y)}" r="${seen ? 1.2 : 1.8}" fill="${seen ? '#7cff9a' : '#ff3df2'}" fill-opacity="${seen ? 0.5 : 0.9}"/>`);
    }
  }
  parts.push('</svg>');
  return { svg: parts.join('\n'), left, right, bottom, top, scale };
}

/** Renders map crops to PNG files with Playwright, for reviewing a course without the game. */
export async function renderCrops(map, crops, directory) {
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
