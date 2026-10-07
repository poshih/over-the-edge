// The project around the Ashen Ascent course: a souls-like look, readout, sound and enemy art.
export const TITLE = 'Ashen Ascent';

export const THEME = {
  sky: '#26252d',
  // Fog thickens slowly toward the far horizon, so distant ranges and the golden tree read as silhouettes.
  fog: { color: '#2d2b34', near: 8, far: 1500 },
  exposure: 1.25,
  // Depth reads as distance: the course's stone shows its sides, and far dressing drifts slowly by.
  camera: { perspective: true, fieldOfView: 35 },
  // Cold ashen daylight, so stone reads grey; the dying sun only warms what faces it.
  hemisphere: { sky: '#9aa8c0', ground: '#3a2e28', intensity: 2.2 },
  ambient: { color: '#6a6470', intensity: 0.7 },
  sun: { color: '#ffb070', intensity: 1.15 },
  rim: { color: '#8fb8d0', intensity: 1.2 },
  sunDisc: { visible: true, color: '#e8773a' },
  // The scenery is the landscape, so the stock backdrop hills stay hidden.
  backdrop: { visible: false, far: '#36333d', middle: '#2d2a33', near: '#232128' },
  aim: { cursor: '#ffb35c', line: '#c98a4a' },
  character: { pot: '#3c3b40', trim: '#b08a3e', dark: '#19191d', suit: '#5a2a28', ceramic: '#c9bfae', wood: '#3e2e22' },
};

export const HUD = {
  height: { visible: true, label: 'ASCENT', unit: 'm', scale: 1, decimals: 0 },
  timer: { visible: true, label: 'HOLLOWING' },
  // Lore rises as embers and drifts away while the climb goes on.
  messages: { style: 'toast' },
  death: { text: 'You are dead...', fadeIn: 1.5 },
};

export const MEDIA = ['ashen-loop.wav', 'ember.wav', 'bell.wav', 'chime.wav', 'triumph.wav', 'clank.wav', 'thud.wav', 'soul.wav',
  'gust.wav', 'mist.wav', 'boom.wav'];

export const AUDIO = {
  volume: 0.9,
  music: { source: '/media/ashen-loop.wav', volume: 0.45 },
  cues: {
    impact: { source: '/media/clank.wav', volume: 0.55 },
    block: null,
    'enemy-hit': { source: '/media/thud.wav', volume: 0.8 },
    'enemy-defeat': { source: '/media/soul.wav', volume: 0.8 },
    launch: { source: '/media/gust.wav', volume: 0.7 },
    finish: { source: '/media/triumph.wav', volume: 1 },
    hurt: { source: '/media/thud.wav', volume: 0.7 },
    death: { source: '/media/soul.wav', volume: 1 },
    fall: { source: '/media/boom.wav', volume: 0.75 },
    bonfire: { source: '/media/ember.wav', volume: 0.8 },
  },
};

// Original pixel art: a carrion crow, and a hollow in a rusted helm with a broken blade. Facing right.
export const ENEMIES = {
  bird: {
    palette: { '#': '#101014', K: '#3a3a48', G: '#6e6e84', B: '#9a8f7a', E: '#ff5a3c' },
    frames: [
      [
        '................',
        '.KK..........KK.',
        '..KK........KK..',
        '...KKK.##.KKK...',
        '....KKGKKGKK....',
        '.....KKKKKKEBB..',
        '....#KKKKKK#....',
        '.....#KKKK#.....',
        '......#..#......',
        '................',
      ],
      [
        '................',
        '................',
        '......####......',
        '.....#GKKG#.....',
        '..KKKKKKKKKKK...',
        '.KKK.KKKKKKEBB..',
        'KK..#KKKKKK#.KK.',
        'K....#KKKK#...KK',
        '......#..#......',
        '................',
      ],
    ],
  },
  'hollow-soldier': {
    palette: { '#': '#121214', H: '#5a5550', h: '#3d3a36', E: '#ffae42', S: '#8d8577', C: '#3b2f2a', c: '#2a211d', R: '#7a4a2e', M: '#8a8d90' },
    frames: [
      [
        '....####....',
        '...#HHHH#...',
        '..#HHhhHH#..',
        '..#HEhhEH#..',
        '..#hHHHHh#..',
        '...#SSSS#...',
        '..##CCCC##..',
        '.#CCcCCcCC#.',
        '#CCcCCCCcCC#',
        '#C#CCRRCC#C#',
        '#M#cCCCCc#C#',
        '.M#CCCCCC#..',
        '.M.#CCCC#...',
        '.M.#Cc#cC#..',
        '...#C#.#C#..',
        '..##S#.#S##.',
        '..###..###..',
        '............',
      ],
      [
        '....####....',
        '...#HHHH#...',
        '..#HHhhHH#..',
        '..#HEhhEH#..',
        '..#hHHHHh#..',
        '...#SSSS#...',
        '..##CCCC##..',
        '.#CCcCCcCC#.',
        '#CCcCCCCcCC#',
        'M#CCCRRCC#C#',
        'M#CcCCCCc#C#',
        'M.#CCCCCC#..',
        '...#CCCC#...',
        '..#Cc##cC#..',
        '..#C#..#C#..',
        '.##S#..#S##.',
        '.###....###.',
        '............',
      ],
    ],
  },
};

/** The project manifest, from the engine's defaults for everything the course does not change. */
export function projectManifest(defaults) {
  return {
    ...defaults,
    theme: THEME,
    hud: HUD,
    audio: AUDIO,
    enemies: ENEMIES,
    media: MEDIA.map((name) => ({ path: `/media/${name}` })),
  };
}
