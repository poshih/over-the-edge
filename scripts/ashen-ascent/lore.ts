// Every message title and text of Ashen Ascent, in one place so the words can be edited together.
export interface LoreMessage { title: string; message: string }

export const TEXT = {
  intro: {
    title: 'Ashen Ascent',
    message: 'Ash has fallen for a thousand years.\n\nAbove the grey, they say, a keep still drifts on the wind, and in its highest tower burns the last ember.\n\nYou have no legs. You have a hammer. Climb.',
  },
  firstLesson: {
    title: 'A note, left by a kinder corpse',
    message: 'Sweep the hammer over the stone, hook the far side, and pull.\n\nThere is no death on this mountain. Only falling, and the long climb back.',
  },
  hollowHamlet: {
    title: 'Hollow Hamlet',
    message: 'Once a village. Its people still keep watch, though they no longer remember what for.\n\nThe hollowed take two honest blows before they fall.',
  },
  ossuary: {
    title: 'The Ossuary',
    message: 'The hamlet buried its dead beneath its feet, then followed them down.\n\nHere the way up begins by going down.',
  },
  mire: {
    title: 'Blighted Mire',
    message: 'Beneath the bones the mountain rots. A great serpent sleeps across the only road.\n\nMessages here were written by the drowned. Read them like it.',
  },
  forge: {
    title: 'Cinder Forge',
    message: 'The ash is still warm here. The ironkeepers hammered a road up the mountain\'s throat and never came back down.\n\nThe orange stone burns nothing but pride.',
  },
  ramparts: {
    title: 'Frostbound Ramparts',
    message: 'A fortress raised to hold back the sky, now held fast by ice.\n\nWhat looks solid is only cold, and what is cold may crack.',
  },
  windward: {
    title: 'Windward Stair',
    message: 'Above the frost the wind never rests. The old stair fell long ago; the gusts remember where it stood.\n\nLet the wind carry you, but steer.',
  },
  keep: {
    title: 'The Drifting Keep',
    message: 'It drifts on air that should not hold it. Its guard never left the walls.\n\nThe ember waits above its highest tower.',
  },
  phantomDare: {
    title: 'Try jumping',
    message: 'Written in pale light at the brink, by a hand that is barely there.\n\nThe ledge beyond looks solid enough.',
  },
  treasure: {
    title: 'Treasure ahead',
    message: 'A gilded chest, unguarded, in the middle of the courtyard.\n\nSurely whoever left it here meant well.',
  },
  mimic: {
    title: 'It was a mimic',
    message: 'It was always a mimic.\n\nBut something stirs in the dark below: a draft, warm and upward.',
  },
  mistVeil: {
    title: 'A veil of mist',
    message: 'Pale mist, cold as a held breath. Beyond it the keep\'s guard still keeps its watch.\n\nThere is no turning back that is not a fall.',
  },
  falseSummit: {
    title: 'Not the keep',
    message: 'Someone planted this flag and called it the top.\n\nThe keep drifts higher still. Listen for the wind.',
  },
  deadEnd: {
    title: 'A view of nothing',
    message: 'Ash to every horizon, and the keep a smudge above it.\n\nNothing else up here. Climb back down.',
  },
  secretStair: {
    title: 'The drowned stair',
    message: 'The drowned did not lie.\n\nA warm draft rises where the swamp swallowed the old stair, all the way up to the forge.',
  },
  ending: {
    title: 'Ember reclaimed',
    message: 'At the top of the drifting keep a single ember still burns.\n\nIt is warm, and small, and it fits inside your pot.\n\nBelow, for the first time in a thousand years, the ash stops falling.',
  },
} satisfies Record<string, LoreMessage>;
