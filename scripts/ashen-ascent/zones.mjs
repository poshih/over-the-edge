// The Ashen Ascent course: eight souls-like zones climbing from a graveyard to a castle adrift in
// the sky. Every set piece of the Workshop's library appears once, recoloured for its zone.
import { random } from './course.mjs';
import { SCENERY } from './scenery.mjs';
import { Trail } from './trail.mjs';
import { TEXT } from './lore.mjs';

// The library's own colours, named as materials so each zone can repaint them.
const MATERIALS = {
  0x71817a: 'rock', 0x8a8f86: 'stone', 0x5d6b68: 'slate', 0x9a7660: 'wood', 0x7f5f4b: 'crate', 0x6e5540: 'bark',
  0x5f7f4b: 'leaf', 0x707a80: 'metal', 0xb0643a: 'rust', 0xa6a59b: 'concrete', 0x6f8f3c: 'snake', 0x8c5a48: 'brick',
  0x7a4a3c: 'roof', 0xcfc6ad: 'ivory', 0xb44a3c: 'canvas',
};
const BASE = {
  rock: 0x5b5f5a, stone: 0x7b7d76, slate: 0x4b5553, wood: 0x6e5a48, crate: 0x5f4c3e, bark: 0x4d3f33, leaf: 0x4f5a45,
  metal: 0x5f666a, rust: 0x9a5632, concrete: 0x8f8e86, snake: 0x5d6e34, brick: 0x6e4a3e, roof: 0x5e3d33, ivory: 0xb8b09a,
  canvas: 0x8e3a31,
};
const palette = (overrides) => ({ ...BASE, ...overrides });
const SOUND = { bonfire: '/media/ember.wav', bell: '/media/bell.wav', gate: '/media/mist.wav', secret: '/media/chime.wav' };

// Pieces keep their materials in each zone's colours.
function place(t, id, options = {}) {
  return t.piece(id, { recolor: MATERIALS, ...options });
}

// A bonfire landing: a coiled blade in a cairn, and the zone's title the first time the player arrives.
function bonfire(b, x, y, key) {
  // Low enough to step over: the course always passes through its bonfires.
  b.hex('cairn', x, y, 1.4, 0.35, { tone: 'stone', depth: 1 });
  b.plank('blade', x - 0.03, y + 0.32, x + 0.06, y + 0.9, 0.25, { tone: 'ember', depth: 0.3 });
  b.message(`bonfire-${key}`, x, y + 1.3, TEXT[key].title, TEXT[key].message, { sound: SOUND.bonfire, width: 4, height: 3 });
}

function grave(b, x, y, rng, kind = Math.floor(rng() * 3)) {
  if (kind === 0) b.terrain('grave', 'box', x, y + 0.45, 0.42, 0.9, { tone: 'grave', depth: 0.5, angle: (rng() - 0.5) * 0.2 });
  else if (kind === 1) {
    b.block('cross', x - 0.13, y, 0.26, 1.3, { tone: 'wood', depth: 0.3 });
    b.block('cross', x - 0.42, y + 0.78, 0.84, 0.25, { tone: 'wood', depth: 0.3 });
  } else b.peak('grave', x - 0.35, y, 0.7, 1.05, { tone: 'grave', depth: 0.6 });
}

// A wall or cliff of any height, built from terrain no taller than the level allows.
function tower(b, name, left, bottom, width, height, style) {
  for (let from = 0; from < height; from += 120) {
    b.block(name, left, bottom + from, width, Math.min(120, height - from), style);
  }
}

// Floating stones stacked in one tower. The player crosses each to its far end, where a vent lifts
// them `rise` metres, just past the next stone's edge; stones alternate direction, so no stone sits
// in a vent's column below its apex and no vent lies inside another's column.
function windStair(b, t, rises, tones) {
  for (const [index, rise] of rises.entries()) {
    const width = 4.4 + (index % 3) * 0.4;
    t.floor(width, { name: 'stair-stone', thickness: 1, tone: tones[index % tones.length], depth: 2.2 });
    b.vent('stair-wind', t.x - t.dir * 1.1, t.y, rise + 1.3, { width: 2, title: 'Stair wind' });
    t.at(t.x - t.dir * 2.3, t.y + rise).turn();
  }
  // The top stone, where the stair ends.
  t.floor(5.2, { name: 'stair-stone', thickness: 1.2, tone: tones[0], depth: 2.4 });
}

// A castle tower standing on `bottom`: its shaft, a band of merlons and a conical slate roof.
function castleTower(b, center, bottom, width, height, options = {}) {
  b.block('tower', center - width / 2, bottom, width, height, { tone: options.tone ?? 'stone', depth: options.depth ?? 3.4 });
  b.block('tower-band', center - width / 2 - 0.3, bottom + height - 0.6, width + 0.6, 0.6, { tone: 'ivory', depth: (options.depth ?? 3.4) + 0.4 });
  b.peak('tower-roof', center - width / 2 - 0.5, bottom + height, width + 1, options.roof ?? width * 1.4, { tone: 'roof', depth: (options.depth ?? 3.4) + 0.6 });
}

// A banner hanging from `top` on a wall's face.
function banner(b, x, top, length) {
  b.block('banner', x - 0.3, top - length, 0.6, length, { tone: 'banner', depth: 0.3 });
}

// A floating islet with a rock keel below it and a chain hanging from the keel.
function islet(b, center, top, width, chain = 0) {
  b.hex('islet', center, top - width * 0.45, width, width * 0.45, { tone: 'dark', depth: 2.6 });
  b.fang('keel', center, top - width * 0.45 + 0.02, width * 0.5, width * 0.55, { tone: 'dark', depth: 2.2 });
  for (let link = 0; link < chain; link++) {
    b.block('chain', center - 0.13 + (link % 2) * 0.06, top - width - 0.8 - link * 0.9, 0.26, 0.7, { tone: 'metal', depth: 0.3 });
  }
}

const ZONES = [
  {
    code: 'z1', name: 'I · Ashen Hollow', from: 0, to: 36, view: { left: -64, right: 30 },
    palette: palette({ rock: 0x4f524e, stone: 0x6f716b, slate: 0x3f4543, leaf: 0x464c40, grave: 0x8a8b84, soil: 0x37332f, ember: 0xc0602a, bone: 0xb8b09a }),
    build(b, t, rng) {
      b.block('ground', -64, -2, 128, 2, { tone: 'soil', depth: 3 });
      b.block('edge', -64, 0, 3.4, 18, { tone: 'rock', depth: 3 });
      b.add({ kind: 'start', id: 'start', x: -56.5, y: 0.65, angle: -0.42, reach: 1.7 }, 'z1:start');
      b.message('intro', -56.5, 1.6, TEXT.intro.title, TEXT.intro.message, { sound: SOUND.bell, width: 5, height: 3.2 });
      [-59.6, -58.4, -53.4, -51.8, -50.2].forEach((x) => grave(b, x, 0, rng));
      t.at(-48.2, 0);
      place(t, 'tutorial-note', { floor: false, retune: (object) => object.kind === 'trigger'
        ? { ...object, name: TEXT.firstLesson.title, events: [{ type: 'popup', title: TEXT.firstLesson.title, message: TEXT.firstLesson.message }] } : object });
      t.go(2.4);
      b.label(t.x + 0.2, 3.4, 'TRY HOOKING THE STONE');
      place(t, 'first-boulder', { floor: false });
      [-35.4, -34, -32.6].forEach((x) => grave(b, x, 0, rng));
      t.at(-31, 0);
      t.edge(place(t, 'rising-steps', { floor: false }));
      // The barrow: a burial mound; its dead tree grows against the Barrow Cliff.
      const treeAt = t.x + 7.6;
      b.block('barrow', t.x, 0, treeAt + 0.3 - t.x, 3.4, { tone: 'soil', depth: 2.6 });
      t.at(t.x, 3.4);
      b.block('sarcophagus', t.x + 1.4, 3.4, 2, 0.75, { tone: 'grave', depth: 1.2 });
      t.at(treeAt - 2.6, 3.4);
      const tree = place(t, 'the-tree', { floor: false });
      b.label(tree.bounds.left - 1.6, 6.4, 'THE DEAD STILL CLIMB');
      // Raised ground under the right branch, so nothing can fall into a pocket behind the trunk.
      b.block('roots', treeAt + 0.3, 0, 2.1, 3.4 + 3.1, { tone: 'soil', depth: 2.4, allowIn: 'the-tree' });
      const cliff = tree.bounds.right + 0.05;
      t.at(cliff, 11);
      [cliff + 1.6, cliff + 3.1].forEach((x) => grave(b, x, 11, rng));
      t.go(4.4);
      const plank = place(t, 'leaning-plank');
      t.edge(plank);
      // The Barrow Cliff rises in stepped columns to the hamlet; everything beneath it is cliff top.
      t.stairs(12, 23.2, { shapes: ['column', 'column', 'shelf'], floor: 11, tones: ['rock', 'stone'], width: [1.6, 2.3], depth: 3 });
      b.enemy('bird', t.x - 7, t.y - 8, 'left', 3, 1.1);
      b.block('barrow-cliff', cliff, 0, t.x - cliff, 11, { tone: 'rock', depth: 3 });
    },
  },
  {
    code: 'z2', name: 'II · Hollow Hamlet', from: 34, to: 70, view: { left: -24, right: 64 },
    palette: palette({ rock: 0x57534d, stone: 0x7c776d, wood: 0x62544a, crate: 0x564a40, roof: 0x3c3a3c, brick: 0x5e5650,
      plaster: 0x7e776a, metal: 0x5b5f62, ivory: 0x9a9284, canvas: 0x5a3a32, soil: 0x3d3934, ember: 0xc0602a, slate: 0x4a4e4c }),
    build(b, t, rng) {
      // The hamlet stands on the mountain's shoulder: solid rock down to the valley floor.
      const left = t.x;
      const street = t.y;
      b.block('shoulder', left, 0, 64 - left, street, { tone: 'rock', depth: 3.4 });
      bonfire(b, left + 3, street, 'hollowHamlet');
      t.at(left + 5.5, street);
      place(t, 'barrel-and-bucket', { floor: false });
      b.block('fence', t.x + 1.2, street, 0.3, 0.9, { tone: 'wood', depth: 0.4 });
      b.block('fence', t.x + 2.4, street, 0.3, 0.9, { tone: 'wood', depth: 0.4 });
      t.go(3.6);
      place(t, 'hut-roof', { floor: false });
      t.go(1.6);
      b.label(t.x + 1.6, street + 2.6, 'BE WARY OF THE HOLLOW');
      const gate = place(t, 'guarded-landing', { floor: false });
      // The gatehouse walk, level with the guarded landing.
      b.block('gatehouse', gate.bounds.right, street, 10.5, 3.4, { tone: 'stone', depth: 2.6 });
      b.enemy('hollow-soldier', gate.bounds.right + 6, street + 3.4, 'left', 2.5, 0.7);
      t.at(gate.bounds.right + 7.4, street + 3.4);
      const crates = place(t, 'crate-tower', { floor: false });
      // The world's edge stands flush against the crates, so nothing can fall behind them.
      b.block('world-edge', crates.bounds.right, street + 3.4, 64 - crates.bounds.right, 80, { tone: 'rock', depth: 3 });
      b.block('gatehouse-end', gate.bounds.right + 10.5, street, 64 - gate.bounds.right - 10.5, 3.4, { tone: 'stone', depth: 2.6 });
      // The belfry: a ruined bell tower, climbed while turning back along the upper lane.
      t.turn().edge(crates);
      t.stairs(8, 12.4, { shapes: ['shelf', 'crate', 'slab'], tones: ['wood', 'crate', 'stone'], width: [1.5, 2.1] });
      b.enemy('bird', t.x + 3, t.y + 2.2, 'left', 2.5, 1.2);
      // The upper lane floats over the street below.
      const lane = t.y;
      const laneEnd = -22;
      b.block('upper-lane', laneEnd, lane - 1.2, t.x - laneEnd, 1.2, { tone: 'stone', depth: 2.4 });
      t.go(2.5);
      place(t, 'grill-to-house', { floor: false, exit: [5, 0] });
      t.go(2.4);
      b.enemy('hollow-soldier', t.x + 1.2, lane, 'left', 1.6, 0.8);
      t.go(1.2);
      const reliquary = place(t, 'fridge-fling', { floor: false });
      b.label(reliquary.anchor.x, lane + 5.2, 'NOT A FRIDGE. A RELIQUARY.');
      b.enemy('bird', reliquary.anchor.x, lane + 7, 'right', 2.5, 1.2);
      t.edge(reliquary);
      // Filled ground beneath the reliquary's ledge, so no pocket opens beside its post.
      const post = reliquary.objects[1];
      b.block('ossuary-fill', reliquary.bounds.left, lane, post.x - post.width / 2 - reliquary.bounds.left, 2.9,
        { tone: 'plaster', depth: 2.2, allowIn: 'fridge-fling' });
      // The chapel yard, level with the reliquary's ledge, ends under the crow's perch.
      const yard = t.x;
      t.go(2.6);
      const perch = place(t, 'bird-ledge', { floor: false });
      b.block('chapel-yard', perch.bounds.left, lane, yard - perch.bounds.left, 3.4, { tone: 'plaster', depth: 2.2 });
      // Down into the ossuary: the charnel crates step down from the perch to the lane.
      t.edge(perch).at(t.x, lane + 7);
      const crypt = place(t, 'box-descent', { floor: false });
      b.zone.exit = { x: t.x, y: t.y, lane, laneEnd, crypt };
    },
  },
  {
    code: 'z3', name: 'III · The Ossuary', from: 20, to: 96, view: { left: -86, right: 6 },
    palette: palette({ rock: 0x3f3d3b, stone: 0x5e5a55, slate: 0x363a3a, bone: 0xc9c1a8, skull: 0xd8d0b8, candle: 0xd89a4a,
      metal: 0x55595c, wood: 0x4f4336, crate: 0x4a3f33, soil: 0x2e2b29, ember: 0xd07a3a, rust: 0x7a4a30 }),
    build(b, t, rng) {
      const { lane, laneEnd } = ZONES[1].exit;
      // The lane runs on to its broken end, where a shaft hangs below it.
      t.at(laneEnd, lane);
      bonfire(b, laneEnd + 4, lane, 'ossuary');
      const shaft = place(t, 'drop-shaft', { floorTone: 'stone' });
      // A foothold at the bottom of the shaft, for anyone who misses the ledge.
      const low = shaft.anchor.y;
      b.block('foothold', shaft.anchor.x - 2.4 + 1.2, low, 0.7, 2.2, { tone: 'bone', depth: 0.6, allowIn: 'drop-shaft' });
      t.floor(3.2, { name: 'window-sill', thickness: 0.8, tone: 'stone' });
      const drop = place(t, 'ledge-drop', { floorTone: 'stone' });
      // The brink: the floor ends at a long drop into the catacombs.
      t.edge(drop).floor(4.5, { name: 'brink', thickness: 1.4, tone: 'stone' });
      const brink = t.x;
      b.label(brink + 1.4, t.y + 1.7, 'TRY FALLING');
      // The catacomb floor, far below; a heap of bones breaks the fall.
      const floor = 26;
      // The catacombs reach past the graveyard's edge, over nothing.
      b.block('catacombs', -80, 18, brink + 14 + 80, floor - 18, { tone: 'rock', depth: 3 });

      [0.4, 1.3].forEach((dx, index) => b.ball('bones', brink - dx, floor, 0.9 - index * 0.2, { tone: 'bone', depth: 1 }));
      // Stalactites under the catacombs, hanging over the graveyard far below.
      [[-58.4, 1.2, 2.2], [-54.6, 0.8, 1.4], [-50.2, 1.4, 2.8], [-45.8, 0.9, 1.6], [-41.1, 1.1, 2.4], [-36.4, 0.7, 1.2], [-31.2, 1.3, 2]]
        .forEach(([x, width, height]) => b.fang('stalactite', x, 18, width, height, { tone: 'slate', depth: 1.4 }));
      t.at(brink - 1.8, floor);
      place(t, 'crawlspace', { floor: false });
      t.go(1.2);
      b.enemy('hollow-soldier', t.x - 0.6, floor, 'right', 0.8, 0.6);
      t.go(1.2);
      place(t, 'pogo-pit', { floor: false, exit: [3.4, 0] });
      t.at(t.x, floor).go(0.8);
      const trapdoor = place(t, 'false-floor', { floor: false });
      b.label(trapdoor.anchor.x, floor + 5.8, 'SOLID GROUND AHEAD');
      // Beneath the false floor, a hidden draft throws the fallen back up to the rim.
      const pit = trapdoor.objects.find((object) => object.illusion);
      b.vent('pit-draft', pit.x, floor, 5.1, { hidden: true, width: pit.width - 0.2, height: 1, title: 'Pit draft' });
      // The bone well: its shafts climb the far wall of the catacombs.
      t.edge(trapdoor).at(t.x, floor).go(1);
      const chimney = place(t, 'devils-chimney', { floor: false });
      // The world's edge stands flush against the chimney.
      b.block('world-edge', -84, 18, chimney.bounds.left + 84, 110, { tone: 'rock', depth: 3 });
      t.turn().at(chimney.anchor.x + 2.4, chimney.anchor.y + 10);
      const well = place(t, 'zigzag-shaft', { gap: 0.5, floorTone: 'stone', floorThickness: 1.2 });
      b.enemy('bird', well.bounds.right + 14, well.bounds.top + 10.5, 'left', 2, 1);
      t.floor(1.6, { name: 'landing', thickness: 1, tone: 'stone' });
      const mantle = place(t, 'mantle-shelf', { gap: 0.9, floorTone: 'stone' });
      t.go(0.6);
      place(t, 'crumbling-holds', { gap: 0.9, floorTone: 'stone', floorThickness: 1.2 });
      // The last flight of the well, up to the serpent's head.
      t.stairs(4.6, 19, { shapes: ['shelf', 'slab'], tones: ['stone', 'bone', 'rock'], width: [1.5, 2.1] });
    },
  },
  {
    code: 'z4', name: 'IV · Blighted Mire', from: 68, to: 104, view: { left: -60, right: 52 },
    palette: palette({ rock: 0x3e4638, stone: 0x55604c, slate: 0x34403a, snake: 0x5f7a2c, moss: 0x4a5e32, rot: 0x6b6a3a,
      mud: 0x3a3a2c, wood: 0x4f4331, bark: 0x3f3527, metal: 0x4f5550, bone: 0xa9a58c, ember: 0xc0702a }),
    build(b, t, rng) {
      const mire = t.y - 8;
      // The serpent sleeps across the only road: ride it down into the mire.
      const snake = place(t, 'the-snake', { floor: false, retuneLabel: (label) => label });
      const sign = b.labels.find((label) => label.text === 'DO NOT RIDE SNAKE');
      b.label(sign.x, sign.y + 1.1, 'LIAR AHEAD');
      b.block('snake-rest', snake.bounds.left, mire - 2, snake.bounds.right - snake.bounds.left + 0.6, 2, { tone: 'mud', depth: 3 });
      // Mud heaped under the serpent's coils, just below the chord of its body, so nothing hides beneath it.
      b.ramp('coil-mud', snake.anchor.x - 2.34, mire, 5.94, 7.3, { mirror: true, tone: 'mud', depth: 2.6, allowIn: 'the-snake' });
      const floor = (length, name = 'mire') => t.floor(length, { name, thickness: 2, tone: 'mud', depth: 3 });
      t.at(snake.bounds.right + 0.6, mire);
      floor(3);
      bonfire(b, t.x - 1.4, mire, 'mire');
      floor(0.6);
      place(t, 'boulder-field', { floorTone: 'mud', floorThickness: 2 });
      // Swamp mud that is not there: beneath it, the drowned stair's grotto, whose draft the forge sets.
      // The opening is wide enough for a pot with a tucked or raised hammer to ride the draft back out.
      floor(0.4);
      const secret = t.x + 1.2;
      b.block('drowned-mud', t.x, mire - 2, 2.4, 2, { tone: 'mud', depth: 3, illusion: true });
      t.go(2.4);
      b.label(secret, mire + 2.2, 'TRY THE SWAMP');
      b.block('grotto', secret - 2.6, mire - 8.2, 5.2, 1.2, { tone: 'rock', depth: 2.6 });
      b.block('grotto-wall', secret - 2.6, mire - 7, 0.7, 5, { tone: 'rock', depth: 2.6 });
      b.block('grotto-wall', secret + 1.9, mire - 7, 0.7, 5, { tone: 'rock', depth: 2.6 });
      b.zone.drowned = { x: secret, y: mire - 7 };
      b.message('drowned-stair', secret, mire - 5.2, TEXT.secretStair.title, TEXT.secretStair.message, { sound: '/media/chime.wav', width: 3.4, height: 2 });
      floor(0.4);
      place(t, 'stepping-stones', { floorTone: 'mud', floorThickness: 2 });
      b.enemy('bird', t.x - 5, mire + 4.6, 'left', 3, 1.3);
      floor(1.6);
      b.ball('stump', t.x - 0.8, mire, 0.7, { tone: 'bark', depth: 1 });
      place(t, 'pogo-posts');
      floor(1.2);
      place(t, 'floating-rock');
      b.enemy('bird', t.x - 4.7, mire + 5.2, 'right', 2, 1.4);
      floor(1.2);
      // Roots of the drowned forest hang from the mire over the hamlet below.
      [[14.5, 0.6, 1.5], [19.4, 0.5, 1.1], [23.6, 0.7, 1.8], [30.2, 0.5, 1.2], [35.4, 0.6, 1.4]]
        .forEach(([x, width, height]) => b.fang('root', x, mire - 2, width, height, { tone: 'bark', depth: 0.8 }));
      const scree = place(t, 'scree-slope', { floorTone: 'mud', floorThickness: 2 });
      b.enemy('bird', scree.anchor.x + 3, mire + 8, 'left', 3, 1.2);
      t.floor(1, { name: 'bank', thickness: 1.4, tone: 'moss' });
      place(t, 'friction-slab', { floorTone: 'moss', floorThickness: 1.4 });
      t.floor(0.8, { name: 'bank', thickness: 1.4, tone: 'moss' });
      const kicker = place(t, 'kicker-ramp', { floorTone: 'moss', floorThickness: 1.4 });
      b.zone.landing = kicker.objects[1];
    },
  },
  {
    code: 'z5', name: 'V · Cinder Forge', from: 98, to: 142, view: { left: -80, right: 52 },
    palette: palette({ rock: 0x3a302c, stone: 0x5a4a42, rust: 0xb4582a, metal: 0x55575a, iron: 0x3e4144, ember: 0xd8702a,
      coal: 0x2a2624, slate: 0x3c3432, concrete: 0x6e625a, wood: 0x4a3a30, crate: 0x45352b, bark: 0x3a2e25 }),
    build(b, t, rng) {
      // A furnace stack, climbed from the ramp's landing while turning back into the forge.
      const landing = ZONES[3].landing;
      t.turn().at(landing.x - landing.width / 2, landing.y + landing.height / 2);
      t.stairs(6, 13.8, { shapes: ['shelf', 'crate'], tones: ['iron', 'metal', 'coal'], width: [1.5, 2] });
      const forge = t.y;
      const floor = (length, name = 'forge-floor', thickness = 2) => t.floor(length, { name, thickness, tone: 'coal', depth: 3 });
      floor(4.4);
      bonfire(b, t.x + 2, forge, 'forge');
      floor(0.6);
      b.label(t.x - 1.2, forge + 1.9, 'BE WARY OF ORANGE');
      place(t, 'orange-hell', { floorTone: 'coal', floorThickness: 2 });
      // The iron catwalk above the forge floor; its gaps open onto the floor below.
      const walk = (length) => t.floor(length, { name: 'catwalk', thickness: 0.8, tone: 'iron', depth: 2 });
      walk(3);
      b.enemy('hollow-soldier', t.x + 1.4, t.y, 'left', 1, 0.7);
      place(t, 'hook-swing', { tone: 'iron', recolor: undefined });
      walk(2.2);
      place(t, 'chasm-leap', { recolor: undefined, tone: 'stone' });
      walk(1.8);
      place(t, 'pole-vault', { floor: false });
      walk(2);
      const catchWall = place(t, 'catch-wall', { floor: false });
      // The secret way up: the drowned draft rises from the mire's grotto through the chasm, past the take-off wall.
      const drowned = ZONES[3].drowned;
      const [takeOff] = catchWall.objects;
      b.vent('drowned-draft', drowned.x, drowned.y, takeOff.y + takeOff.height / 2 + 1.3 - drowned.y, { hidden: true, width: 2, height: 1, title: 'Drowned draft' });
      walk(2.2);
      place(t, 'max-reach-wall', { floorTone: 'iron', floorThickness: 0.8 });
      walk(1.6);
      b.enemy('bird', t.x - 1.5, t.y + 3, 'left', 2, 1.1);
      place(t, 'overhang', { floorTone: 'iron', floorThickness: 0.8 });
      walk(1.6);
      const spire = place(t, 'spire', { floorTone: 'coal', floorThickness: 1.2, tone: 'coal' });
      b.enemy('bird', spire.anchor.x + 3.6, spire.bounds.top - 2, 'right', 2, 1.3);
      // A slag ledge beside the spire's tip.
      t.at(spire.bounds.left - 0.2, spire.anchor.y + 8.4);
      walk(3.2);
      place(t, 'tilted-slab', { floorTone: 'iron', floorThickness: 0.8 });
    },
  },
  {
    code: 'z6', name: 'VI · Frostbound Ramparts', from: 138, to: 196, view: { left: -60, right: 52 },
    palette: palette({ rock: 0x6d7880, stone: 0x8e9aa2, slate: 0x56626b, ice: 0xa9c8d6, snow: 0xd6e0e6, frost: 0x7fa3b5,
      metal: 0x6a747c, wood: 0x5e5650, bark: 0x4e4640, leaf: 0x8fa8b4, ember: 0xd07a3a, concrete: 0x9aa4ab }),
    build(b, t, rng) {
      // Frozen steps up from the forge's last slab.
      t.turn();
      t.stairs(4, 5.7, { shapes: ['shelf', 'slab'], tones: ['ice', 'stone', 'snow'], width: [1.5, 2] });
      const wall = (length, name = 'rampart', thickness = 2) => t.floor(length, { name, thickness, tone: 'stone', depth: 3 });
      const icicle = (x, width, height) => b.fang('icicle', x, t.y - 2, width, height, { tone: 'ice', depth: 0.8 });
      const merlon = (x) => b.block('merlon', x - 0.35, t.y, 0.7, 0.7, { tone: 'snow', depth: 2.4 });
      wall(4.2);
      bonfire(b, t.x - 2, t.y, 'ramparts');
      wall(1.2);
      place(t, 'knife-edge', { recolor: undefined, tone: 'ice' });
      wall(2.6);
      merlon(t.x - 1.3);
      icicle(t.x - 2.2, 0.6, 1.6);
      wall(1.6);
      icicle(t.x - 0.8, 0.5, 1.1);
      const boulder = place(t, 'perched-boulder', { floor: false, recolor: undefined, tone: 'ice' });
      b.enemy('hollow-soldier', t.x + 3.6, t.y, 'left', 1.2, 0.6);
      // The tower walk, reached across the ice boulder's crown.
      t.go(0.95);
      t.floor(5.4, { name: 'tower-walk', thickness: 0.8, tone: 'stone', depth: 2.2 });
      place(t, 'needle-pillars', { floorTone: 'stone', floorThickness: 0.8, recolor: undefined, tone: 'frost' });
      t.floor(2, { name: 'tower-top', thickness: 1, tone: 'stone', depth: 2.4 });
      place(t, 'dome', { floorTone: 'stone', floorThickness: 1, recolor: undefined, tone: 'snow' });
      // Off the dome's crown to the upper rampart.
      t.edge(b.pieces.at(-1));
      const upper = t.y;
      wall(3);
      b.enemy('bird', t.x - 1, upper + 4, 'right', 2.5, 1.3);
      place(t, 'ball-stack', { floor: false, recolor: undefined, tone: 'snow', exit: [1.7, 0] });
      wall(2.4);
      // The gate of icicles: a roof of fangs over a gap in the wall.
      const gateOfFangs = place(t, 'ceiling-traverse', { recolor: undefined, tone: 'frost' });
      b.enemy('bird', gateOfFangs.anchor.x, gateOfFangs.bounds.top + 1.6, 'right', 3, 1.2);
      wall(2.2);
      merlon(t.x - 1.1);
      icicle(t.x - 1.6, 0.7, 2.2);
      b.enemy('hollow-soldier', t.x - 1.9, t.y, 'left', 0.5, 0.6);
      wall(1.4);
      b.label(t.x - 2.6, t.y + 1.8, 'DO NOT LINGER');
      place(t, 'crumbling-bridge', { recolor: undefined, tone: 'ice' });
      wall(2);
      // The Plunge: a warning, a lip over nothing, and a shelf high above the forge.
      place(t, 'danger-sign', { recolor: undefined, tone: 'stone' });
      t.go(1.4);
      place(t, 'long-fall', { recolor: undefined, tone: 'frost' });
    },
  },
  {
    code: 'z7', name: 'VII · Windward Stair', from: 156, to: 262, view: { left: -10, right: 66 },
    palette: palette({ rock: 0x585e66, stone: 0x7a818a, slate: 0x4a5058, cloud: 0xb9c0c8, metal: 0x646c74, rope: 0x7a6a50,
      wood: 0x6a5a48, crate: 0x5a4c3e, concrete: 0x8a9098, ember: 0xd08a3a }),
    build(b, t, rng) {
      // The windward ledge at the mountain's edge, with the world's edge beyond it.
      t.floor(11.3, { name: 'windward-ledge', thickness: 1.2, tone: 'rock', depth: 2.6 });
      tower(b, 'sky-edge', t.x, 119.1, 66 - t.x, 330, { tone: 'rock', depth: 3 });
      bonfire(b, t.x - 8.6, t.y, 'windward');
      b.hex('cairn', t.x - 5.6, t.y, 1.1, 0.4, { tone: 'stone', depth: 1 });
      b.hex('cairn', t.x - 5.6, t.y + 0.4, 0.7, 0.35, { tone: 'cloud', depth: 0.9 });
      // A wind-scoured stair turns back up against the world's edge.
      t.go(-2).turn();
      t.stairs(7, 10, { shapes: ['shelf', 'slab'], tones: ['rock', 'stone'], width: [1.5, 2] });
      place(t, 'launch-pad', { gap: 0.3, floorTone: 'stone', floorThickness: 1 });
      place(t, 'updraft-ambush', { gap: 0.4, floorTone: 'stone', floorThickness: 1 });
      place(t, 'updraft-cliff', { gap: 0.4, floorTone: 'stone', floorThickness: 1 });
      place(t, 'the-fork', { floorTone: 'stone', floorThickness: 1 });
      b.enemy('bird', t.x + 4, t.y + 3.4, 'right', 2.5, 1.4);
      place(t, 'vent-ladder', { gap: 0.4, floorTone: 'stone', floorThickness: 1 });
      // The broken stair: stones that once were steps, each crossed to its far end, where the wind
      // lifts the player just past the next stone above.
      const stairFoot = { x: t.x, y: t.y };
      windStair(b, t, [9.4, 8.2, 11.6, 9, 12.4, 8.6, 10.2], ['stone', 'rock', 'cloud']);
      b.enemy('bird', stairFoot.x - 9, stairFoot.y + 24, 'right', 2.5, 1.4);
      b.enemy('bird', stairFoot.x + 6, stairFoot.y + 46, 'left', 2.5, 1.5);
      b.enemy('bird', t.x - t.dir * 2, t.y + 3, 'left', 3, 1.5);
    },
  },
  {
    code: 'z8', name: 'VIII · The Drifting Keep', from: 262, to: 432, view: { left: -64, right: 30 },
    palette: palette({ rock: 0x4a4640, stone: 0xb9b0a0, ivory: 0xd8ceb6, gold: 0xc9a24a, roof: 0x3e4a62, banner: 0x7e2a2a,
      metal: 0x6f747b, crystal: 0x9fb8d8, wood: 0x5e4c3c, concrete: 0xa8a092, brick: 0x8a7e70, canvas: 0x7e2a2a,
      slate: 0x5a6070, bark: 0x5a4a3a, leaf: 0x6a7a5a, ember: 0xe0903a, dark: 0x34302d }),
    build(b, t, rng) {
      // The false summit crowns the stair; behind its flag the wind altar looks up at the keep.
      place(t, 'false-summit', { floorTone: 'stone', floorThickness: 1.2, retune: (object) => object.kind === 'trigger'
        ? { ...object, name: TEXT.falseSummit.title, events: [{ type: 'popup', title: TEXT.falseSummit.title, message: TEXT.falseSummit.message }] }
        : object });
      b.label(t.x - 3.6, t.y - 3.2, 'THE TOP, SURELY');
      t.floor(3.6, { name: 'wind-altar', thickness: 1.2, tone: 'gold', depth: 2.6 });
      const lift = 96;
      const altar = t.y;
      const column = t.x - 1.2;
      b.vent('great-updraft', column, altar, lift, { width: 2, title: 'The Great Updraft' });
      // Islets drift past the wind's column on the way up, well clear of it.
      [[-7, 34, 3.4, 3], [6.5, 52, 2.6, 2], [-6.2, 70, 4, 4], [7.2, 84, 3, 3]].forEach(([dx, dy, width, chain]) =>
        islet(b, column + dx, altar + dy, width, chain));
      // The sky dock waits beside the column, just below the wind's apex.
      const dock = altar + lift - 1.3;
      t.turn().at(column - 1.2, dock);
      t.floor(9, { name: 'sky-dock', thickness: 1.2, tone: 'stone', depth: 3 });
      b.hex('dock-rock', t.x + 4.8, dock - 4.4, 8.8, 3.6, { tone: 'dark', depth: 3.4 });
      b.fang('dock-keel', t.x + 4.8, dock - 2.6, 3.4, 5.5, { tone: 'dark', depth: 3 });
      bonfire(b, t.x + 4.4, dock, 'keep');
      // The drawbridge, crows circling below the keep.
      place(t, 'bird-gauntlet', { recolor: undefined, tone: 'wood' });
      b.enemy('bird', t.x + 6, dock - 3, 'right', 3, 1.3);
      // The gatehouse hangs over the road, a tower on it; the mist veil fills the passage.
      const gate = t.x;
      b.block('gatehouse', gate - 7.5, dock + 2.8, 7.5, 7, { tone: 'stone', depth: 5 });
      castleTower(b, gate - 3.8, dock + 9.8, 4, 8.5, { depth: 4.4 });
      banner(b, gate + 0.35, dock + 9.4, 3.2);
      banner(b, gate - 7.85, dock + 9.4, 2.6);
      t.floor(7.5, { name: 'gate-passage', thickness: 1.4, tone: 'stone', depth: 4 });
      b.message('mist-veil', gate - 4.2, dock + 1.3, TEXT.mistVeil.title, TEXT.mistVeil.message, { sound: '/media/mist.wav', width: 1.6, height: 2.4 });
      // The courtyard, where the keep's last guard still stands.
      const court = t.x;
      const yard = (length) => t.floor(length, { name: 'courtyard', thickness: 1.4, tone: 'concrete', depth: 3.4 });
      yard(6.4);
      [court - 2.4, court - 5.2].forEach((x, index) => b.enemy('hollow-soldier', x, dock, index ? 'right' : 'left', 1, 0.8));
      // A chest on the flagstones. It is a mimic: chest and flagstones are illusions over the undercroft,
      // whose opening is wide enough for a pot with a tucked or raised hammer to ride the draft back out.
      const hole = t.x - 1.2;
      b.block('mimic', hole - 0.8, dock, 1.6, 0.8, { tone: 'gold', depth: 1.2, illusion: true });
      b.block('mimic-flagstone', t.x - 2.4, dock - 1.4, 2.4, 1.4, { tone: 'concrete', depth: 3.4, illusion: true });
      b.label(hole, dock + 2.1, 'TREASURE AHEAD');
      t.go(2.4);
      yard(8.6);
      b.enemy('hollow-soldier', t.x + 3.2, dock, 'right', 1.8, 0.9);
      const below = dock - 6.4;
      b.block('undercroft', hole - 3.4, below - 1.2, 6.8, 1.2, { tone: 'dark', depth: 3 });
      b.block('undercroft-wall', hole - 3.4, below, 0.8, 5, { tone: 'dark', depth: 3 });
      b.block('undercroft-wall', hole + 2.6, below, 0.8, 5, { tone: 'dark', depth: 3 });
      b.vent('mimic-draft', hole, below, 8.2, { hidden: true, width: 2, height: 1, title: 'Undercroft draft' });
      b.message('mimic', hole, below + 2.4, TEXT.mimic.title, TEXT.mimic.message, { sound: '/media/chime.wav', width: 4.4, height: 2.2 });
      // The keep's rock foundation, clear of the undercroft.
      b.fang('foundation', court - 3, dock - 1.4, 5.6, 9, { tone: 'dark', depth: 3.6 });
      b.fang('foundation', t.x + 2.6, dock - 1.4, 5, 12, { tone: 'dark', depth: 3.6 });
      // The curtain wall: notches cut into its face, and a balcony to a turret that goes nowhere.
      const curtain = place(t, 'notch-wall', { floor: false, recolor: undefined, tone: 'stone' });
      const walk = t.y;
      t.turn().at(curtain.bounds.right, walk);
      t.floor(5.8, { name: 'balcony', thickness: 0.9, tone: 'stone', depth: 2.4 });
      place(t, 'dead-end-tower', { floor: false, recolor: undefined, tone: 'stone', retune: (object) => object.kind === 'trigger'
        ? { ...object, name: TEXT.deadEnd.title, events: [{ type: 'popup', title: TEXT.deadEnd.title, message: TEXT.deadEnd.message }] }
        : object });
      b.label(curtain.bounds.right + 1.6, walk + 2.4, 'GREAT VIEW AHEAD');
      // The wall walk to the keep.
      t.turn().at(curtain.bounds.left, walk);
      const merlon = (x) => b.block('merlon', x - 0.35, walk, 0.7, 0.7, { tone: 'ivory', depth: 2.4 });
      t.floor(3.6, { name: 'wall-walk', thickness: 1.2, tone: 'stone', depth: 3 });
      merlon(t.x + 1.6);
      t.floor(4.2, { name: 'wall-walk', thickness: 1.2, tone: 'stone', depth: 3 });
      b.enemy('bird', t.x + 2, walk + 3.2, 'left', 3, 1.4);
      const ladder = place(t, 'ledge-ladder', { floor: false, recolor: undefined, tone: 'ivory' });
      // The keep: its roof is level with the tower's top, its foundation hangs below.
      const roof = t.y;
      const body = ladder.bounds.left;
      b.block('keep', body - 13, walk - 10, 13, roof - walk + 10, { tone: 'stone', depth: 5 });
      b.block('keep', ladder.bounds.left, walk - 1.2, ladder.bounds.right - ladder.bounds.left, 1.2, { tone: 'stone', depth: 3 });
      b.fang('keep-keel', body - 6.5, walk - 10, 11, 14, { tone: 'dark', depth: 4 });
      banner(b, body - 13.35, roof - 0.6, 4);
      // The Ember Spire: a gilded stair turning up from the keep's roof past its towers to the summit.
      t.go(2.6);
      b.enemy('hollow-soldier', t.x + 1.8, roof, 'left', 0.6, 0.6);
      castleTower(b, body - 10.4, roof, 3, 12, { depth: 4 });
      castleTower(b, body - 6.6, roof, 2.2, 7, { depth: 3.6 });
      const spireFoot = { x: t.x, y: t.y };
      t.stairs(1, 22, { shapes: ['shelf', 'crate', 'slab'], tones: ['gold', 'ivory', 'stone'], width: [1.5, 2] });
      b.enemy('bird', spireFoot.x + 7.4, spireFoot.y + 12, 'left', 1.5, 1.6);
      b.label(t.x - 2.2, t.y + 2.6, 'THE EMBER, AT LAST');
      t.floor(1.4, { name: 'spire-top', thickness: 1.2, tone: 'ivory', depth: 2.6 });
      place(t, 'summit', { floorTone: 'gold', floorThickness: 1.2, recolor: undefined, tone: 'gold', retune: (object) => object.kind === 'trigger'
        ? { ...object, name: TEXT.ending.title, events: [{ type: 'stop-timer' }, { type: 'popup', title: TEXT.ending.title, message: TEXT.ending.message }] }
        : object });
    },
  },
];

export function buildCourse(builder) {
  let trail = null;
  for (const zone of ZONES) {
    const rng = random(zone.code.charCodeAt(1) * 7919);
    builder.beginZone(zone);
    trail = trail === null ? new Trail(builder, rng, 0, 0, 1) : Object.assign(trail, { rng });
    zone.build(builder, trail, rng);
    SCENERY[zone.code]?.(builder);
  }
  return trail;
}
