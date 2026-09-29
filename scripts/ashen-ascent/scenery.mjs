// The scenery of Ashen Ascent: decorations that never collide, from the far horizon to the foreground.
// Each zone's scenery is built right after the zone, so its IDs share the zone's prefix. Distant
// scenery is placed by where it should appear on screen while the camera looks at a point of the climb:
// it barely drifts from there, while scenery near the course moves almost with it.
import { THEME } from './project.mjs';

// The perspective camera's distance from the course plane at the game's 8.5 m view height.
const DISTANCE = 8.5 / 2 / Math.tan(THEME.camera.fieldOfView * Math.PI / 360);
// How much larger than it looks a decoration at depth z must be, measured on the course plane.
const depthScale = (z) => (DISTANCE - z) / DISTANCE;
// The rock shelf's slab top, as a share of its height; boulders stand above it.
const SHELF_TOP = 0.8;

const TINT = { dusk: 0x8c8a9a, night: 0x6f6d7e, ash: 0xb3ada2, moss: 0x9fb08a, frost: 0xc2cedb, ember: 0xffcf9e, bone: 0xd6cdb8 };

/** A decoration placed to appear `offset` from the view's centre, `size` tall, while the camera looks at `from`. */
function far(b, model, from, [dx, dy], z, size, options) {
  const scale = depthScale(z);
  b.decoration(model, model, from[0] + dx * scale, from[1] + dy * scale, z, size * scale, options);
}

/** A far decoration standing on the valley floor, appearing `dx` from the view's centre and `size` tall seen from `x`. */
function landmark(b, model, x, dx, z, size, options) {
  const scale = depthScale(z);
  b.decoration(model, model, x + dx * scale, 0, z, size * scale, options);
}

/** Rock shelves side by side from `left` to `right`, their tops level with `top`: ground behind the course. */
function shelves(b, left, right, top, z, height, tint) {
  const width = height * 24 / 5.01;
  for (let x = left + width / 2; x - width / 2 < right; x += width * 0.92) {
    b.decoration('shelf', 'rock-shelf', x, top - height * SHELF_TOP, z, height, { tint, mirror: Math.round(x) % 2 === 0 });
  }
}

/** A row of models along a line, spaced `step` apart, alternating mirror and leaning a little. */
function row(b, model, from, to, y, z, height, step, options = {}) {
  for (let x = from, index = 0; x <= to; x += step, index++) {
    b.decoration(model, model, x, y, z, height * (1 - 0.12 * (index % 3)), {
      ...options, mirror: index % 2 === 1, angle: (options.lean ?? 0) * ((index % 3) - 1),
    });
  }
}

export const SCENERY = {
  // I · Ashen Hollow: a graveyard on ash-grey ground under a far range, the golden tree on the horizon.
  z1(b) {
    far(b, 'mountain-ridge', [-20, 6], [0, -2.1], -1000, 3.1, { tint: TINT.dusk });
    far(b, 'mountain-ridge', [-20, 6], [8, -2.5], -1000, 3.6, { mirror: true, tint: TINT.night });
    far(b, 'great-tree', [0, 14], [5.5, -1.4], -900, 4.4);
    far(b, 'stone-bridge', [10, 12], [4.2, -1.6], -200, 2.2, { tint: TINT.dusk });
    shelves(b, -72, 34, 0, -14, 4, TINT.ash);
    shelves(b, -80, 60, 2.5, -48, 9, TINT.dusk);
    shelves(b, -110, 80, 9, -110, 20, TINT.night);
    b.decoration('watchtower', 'watchtower', -61, 9 + 0.5, -110, 26, { tint: TINT.ash });
    b.decoration('gothic-arch', 'gothic-arch', -44, 2.5, -30, 11, { tint: TINT.ash });
    for (const [x, z, height, mirror] of [[-62, -6, 7, false], [-27, -9, 9, true], [-8, -20, 11, false], [14, -6, 6, true]]) {
      b.decoration('dead-tree', 'dead-tree', x, 0, z, height, { mirror, angle: mirror ? 0.06 : -0.05 });
    }
    for (const [x, z] of [[-47, -4], [-38, -12], [-24, -5]]) b.decoration('ruined-pillar', 'ruined-pillar', x, 0, z, 5.5);
    row(b, 'graves', -62, -30, 0, -3.2, 1.4, 5.5);
    row(b, 'iron-fence', -64, -34, 0, -6, 2.2, 6.3);
    b.decoration('knight-statue', 'knight-statue', -33, 0, -8, 6.5, { mirror: true });
    b.decoration('skull-pile', 'skull-pile', -18, 0, -1.4, 0.9);
    b.decoration('lantern-post', 'lantern-post', -55, 0, -1.2, 3.3);
  },

  // II · Hollow Hamlet: a lit street, a wall behind it, the cathedral far off above the roofs.
  z2(b) {
    landmark(b, 'cathedral', 30, -3.6, -400, 2.6, { tint: TINT.ash });
    shelves(b, 8, 66, 35.7, -14, 4, TINT.ash);
    row(b, 'lantern-post', 22, 60, 35.7, -1.2, 3.4, 12.5);
    row(b, 'broken-wall', 14, 58, 35.7, -7, 5.5, 11);
    b.decoration('dead-tree', 'dead-tree', 49, 35.7, -16, 10, { mirror: true });
    b.decoration('banner', 'banner', 31.5, 35.7, -1.6, 5.2);
    b.decoration('banner', 'banner', 42.5, 35.7, -1.6, 5.2, { mirror: true });
    b.decoration('hanging-cage', 'hanging-cage', 3, 61.5, 1.8, 5.5);
  },

  // III · The Ossuary: a crypt wall, skulls and candles on the catacomb floor, cages hung in front.
  z3(b) {
    row(b, 'broken-wall', -78, -30, 26, -3.5, 7, 9.5, { tint: 0x6a6470 });
    row(b, 'skull-pile', -74, -34, 26, -1.2, 0.9, 8);
    for (const x of [-70, -56, -43]) b.decoration('candelabra', 'candelabra', x, 26, -1.4, 2.3);
    b.decoration('knight-statue', 'knight-statue', -50, 26, -2.8, 5.5);
    b.decoration('chains', 'chains', -62, 32.5, 2.6, 8);
    b.decoration('hanging-cage', 'hanging-cage', -41, 31, 2.2, 5);
    b.decoration('chains', 'chains', -78, 50, -1.6, 9, { mirror: true });
  },

  // IV · Blighted Mire: drowned trees and thorns on moss, a rune stone, crags on the horizon.
  z4(b) {
    far(b, 'rock-spire', [0, 76], [-4.8, -1.3], -60, 2.8, { tint: TINT.moss });
    far(b, 'rock-spire', [0, 76], [5.2, -1.6], -60, 3.4, { mirror: true, tint: TINT.moss });
    shelves(b, -46, 40, 71, -14, 4, TINT.moss);
    for (const [x, z, height, angle] of [[-38, -5, 7, 0.12], [-8, -11, 9, -0.1], [9, -4, 6, 0.18], [30, -16, 10, -0.08]]) {
      b.decoration('dead-tree', 'dead-tree', x, 71, z, height, { angle, mirror: x > 0, tint: TINT.moss });
    }
    row(b, 'thorn-bush', -44, 36, 71, -1.6, 1.1, 9.5);
    b.decoration('obelisk', 'obelisk', -2, 71, -13, 8);
    b.decoration('sword-grave', 'sword-grave', 20, 71, -2.2, 4.4);
  },

  // V · Cinder Forge: braziers on the catwalk, chains overhead, and far off a castle adrift in the sky: it
  // peeks over the top of the view from the graveyard, is level with the forge, and lies below the keep.
  z5(b) {
    far(b, 'castle', [-10, 150], [-3.2, 0], -600, 2.6, { tint: TINT.dusk });
    for (const [dx, size] of [[-0.85, 3], [0.1, 4.4], [0.95, 2.4]]) {
      far(b, 'rock-spire', [-10, 150], [-3.2 + dx, 0.15], -601, size, { angle: Math.PI, mirror: dx > 0, tint: TINT.night });
    }
    for (const x of [18, 3, -18]) b.decoration('brazier', 'brazier', x, 109, -1.3, 1.7);
    b.decoration('ember-cairn', 'ember-cairn', 31, 100, -1.2, 1.5);
    b.decoration('chains', 'chains', 8, 117, 3, 8);
    b.decoration('chains', 'chains', -14, 120, 2.6, 7, { mirror: true });
    b.decoration('hanging-cage', 'hanging-cage', -32, 129, 2.2, 5.5, { tint: TINT.ember });
    row(b, 'broken-wall', -28, 20, 98, -6, 6, 12, { tint: 0x9a8a80 });
  },

  // VI · Frostbound Ramparts: banners on the walls, a far watchtower, knights on guard.
  z6(b) {
    far(b, 'mountain-ridge', [0, 150], [-6.5, -2.9], -1000, 3.8, { tint: TINT.frost });
    far(b, 'watchtower', [0, 150], [4.6, -0.9], -80, 3.2, { tint: TINT.frost });
    for (const [x, y] of [[-41, 145.1], [-24, 145.1], [1, 157.1], [21, 157.1]]) b.decoration('banner', 'banner', x, y, -1.8, 5, { tint: TINT.frost });
    b.decoration('knight-statue', 'knight-statue', -30, 145.1, -3.5, 5.5, { tint: TINT.frost });
    b.decoration('knight-statue', 'knight-statue', 12, 157.1, -3.5, 5.5, { mirror: true, tint: TINT.frost });
  },

  // VII · Windward Stair: crags adrift in the wind, a lone obelisk on the highest of them.
  z7(b) {
    for (const [x, y, z, height] of [[-14, 188, -35, 22], [2, 222, -70, 30], [36, 205, -24, 16], [-24, 246, -50, 26], [30, 250, -90, 34]]) {
      b.decoration('crag', 'rock-spire', x, y, z, height, { angle: Math.PI, tint: TINT.dusk });
    }
    b.decoration('chains', 'chains', 58, 214, -1.5, 8);
    b.decoration('banner', 'banner', 59, 236, -1.4, 5.5, { mirror: true });
  },

  // VIII · The Drifting Keep: candles and banners in the courtyard, knights at the gate; far below, the
  // golden tree of the graveyard's horizon.
  z8(b) {
    for (const x of [-9, -19]) b.decoration('candelabra', 'candelabra', x, 367.1, -1.2, 2.2);
    b.decoration('knight-statue', 'knight-statue', 3.5, 367.1, -2.6, 4.8);
    b.decoration('knight-statue', 'knight-statue', -10.5, 367.1, -2.6, 4.8, { mirror: true });
    for (const [x, y] of [[-30, 375.7], [-34.5, 375.7]]) b.decoration('lantern-post', 'lantern-post', x, y, -1.2, 3.2);
    b.decoration('banner', 'banner', 8, 367.1, -1.6, 5.5);
    b.decoration('hanging-cage', 'hanging-cage', 12, 352, 1.8, 6);
    b.decoration('chains', 'chains', 20, 356, 2.8, 8, { mirror: true });
    for (const [x, y, z, height] of [[-60, 330, -40, 24], [30, 300, -65, 32], [-10, 310, -110, 40]]) {
      b.decoration('crag', 'rock-spire', x, y, z, height, { angle: Math.PI, tint: TINT.night });
    }
  },
};
