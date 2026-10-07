// Small, deterministic media files for the example projects.

export interface WavOptions {
  frequency?: number;
  seconds?: number;
  rate?: number;
  decay?: number;
  noise?: number;
}

// A mono 16-bit PCM WAV: a tone with a short attack and exponential decay.
export function wavFixture({ frequency = 440, seconds = 0.25, rate = 22050, decay = 12, noise = 0 }: WavOptions = {}) {
  const samples = Math.round(seconds * rate);
  const data = Buffer.alloc(samples * 2);
  let seed = 1;
  for (let index = 0; index < samples; index++) {
    const time = index / rate;
    const attack = Math.min(1, time / 0.005);
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    const hiss = noise * ((seed / 0x7fffffff) * 2 - 1);
    const value = attack * Math.exp(-decay * time) * (Math.sin(2 * Math.PI * frequency * time) * (1 - noise) + hiss);
    data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, value)) * 0x5fff), index * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

// A seamless loop of two alternating low tones, for background music tests.
export function musicFixture({ seconds = 2, rate = 22050 }: Pick<WavOptions, 'seconds' | 'rate'> = {}) {
  const samples = Math.round(seconds * rate);
  const data = Buffer.alloc(samples * 2);
  for (let index = 0; index < samples; index++) {
    const time = index / rate;
    const note = Math.floor(time * 2) % 2 === 0 ? 110 : 146.83;
    const envelope = 0.5 + 0.5 * Math.cos(2 * Math.PI * time * 2);
    const value = 0.35 * envelope * (Math.sin(2 * Math.PI * note * time) + 0.3 * Math.sin(4 * Math.PI * note * time));
    data.writeInt16LE(Math.round(value * 0x5fff), index * 2);
  }
  const header = wavFixture({ seconds: 0, rate }).subarray(0, 44);
  header.writeUInt32LE(36 + data.length, 4);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

// The sound set of the example project in examples/projects/lantern-cavern.
export function lanternCavernMedia() {
  return {
    'cavern-loop.wav': musicFixture({ seconds: 4 }),
    'clink.wav': wavFixture({ frequency: 1320, seconds: 0.18, decay: 22 }),
    'thud.wav': wavFixture({ frequency: 90, seconds: 0.3, decay: 14, noise: 0.35 }),
    'chime.wav': wavFixture({ frequency: 988, seconds: 0.9, decay: 4 }),
    'whoosh.wav': wavFixture({ frequency: 220, seconds: 0.6, decay: 5, noise: 0.8 }),
    'bell.wav': wavFixture({ frequency: 660, seconds: 1.2, decay: 3 }),
  };
}

// A mono 16-bit PCM WAV of `samples` (-1..1) at `rate`.
function pcm(samples: readonly number[], rate = 22050) {
  const data = Buffer.alloc(samples.length * 2);
  samples.forEach((value, index) => data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, value)) * 0x5fff), index * 2));
  const header = wavFixture({ seconds: 0, rate }).subarray(0, 44);
  header.writeUInt32LE(36 + data.length, 4);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

// Deterministic noise and a one-pole low-pass, for wind, crackle and booms.
function noise(seed: number) {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return (state / 0x7fffffff) * 2 - 1;
  };
}

function render(seconds: number, voice: (time: number, index: number) => number, rate = 22050) {
  return pcm(Array.from({ length: Math.round(seconds * rate) }, (_, index) => voice(index / rate, index)), rate);
}

// Inharmonic partials with their own decays: bells, chimes and clanks.
function struck(partials: readonly (readonly [number, number, number])[], seconds: number, rate = 22050) {
  return render(seconds, (time) => partials.reduce((sum, [frequency, gain, decay]) =>
    sum + gain * Math.exp(-decay * time) * Math.sin(2 * Math.PI * frequency * time), 0) * Math.min(1, time / 0.004), rate);
}

function filtered(seconds: number, seed: number, cutoff: (time: number) => number, envelope: (time: number) => number, rate = 22050) {
  const next = noise(seed);
  let low = 0;
  return render(seconds, (time) => {
    const alpha = 1 - Math.exp(-2 * Math.PI * cutoff(time) / rate);
    low += alpha * (next() - low);
    return low * envelope(time);
  }, rate);
}

// The sound set of the example project in examples/projects/ashen-ascent: all procedural.
export function ashenAscentMedia(): Record<string, Buffer<ArrayBuffer>> {
  const rate = 22050;
  // A slow, dark drone in A minor: root, fifth and a minor third that swells in and out; loops seamlessly.
  const loop = 12;
  const music = render(loop, (time) => {
    const swell = 0.5 - 0.5 * Math.cos(2 * Math.PI * time / loop);
    const breath = 0.8 + 0.2 * Math.sin(2 * Math.PI * time * 3 / loop);
    return 0.16 * breath * (Math.sin(2 * Math.PI * 55 * time) + 0.6 * Math.sin(2 * Math.PI * 82.5 * time) +
      0.35 * swell * Math.sin(2 * Math.PI * 130.8 * time) + 0.2 * Math.sin(2 * Math.PI * 110 * time + Math.sin(2 * Math.PI * time / loop)));
  }, rate);
  const crackle = noise(7);
  let pop = 0;
  const ember = render(1.4, (time) => {
    if (crackle() > 0.985) pop = 1;
    pop *= 0.992;
    return 0.5 * pop * crackle() * Math.exp(-1.6 * time) + 0.08 * crackle() * Math.exp(-2.4 * time);
  }, rate);
  return {
    'ashen-loop.wav': music,
    'ember.wav': ember,
    'bell.wav': struck([[196, 0.5, 1.1], [196 * 2.76, 0.25, 1.8], [196 * 5.4, 0.12, 3.2], [98, 0.3, 0.8]], 3.2, rate),
    'chime.wav': struck([[1046, 0.35, 3], [1318, 0.25, 3.6], [1568, 0.2, 4.4]], 1.4, rate),
    'triumph.wav': render(3.6, (time) => {
      const rise = Math.min(1, time / 0.6) * Math.exp(-0.7 * Math.max(0, time - 1.2));
      return 0.14 * rise * [220, 277.2, 329.6, 440, 554.4].reduce((sum, frequency) => sum + Math.sin(2 * Math.PI * frequency * time), 0);
    }, rate),
    'clank.wav': struck([[1650, 0.4, 28], [2410, 0.25, 34], [3900, 0.12, 40]], 0.22, rate),
    'thud.wav': filtered(0.32, 3, () => 420, (time) => 1.3 * Math.exp(-14 * time), rate),
    'soul.wav': render(0.9, (time) => 0.3 * Math.exp(-2.6 * time) * Math.sin(2 * Math.PI * (440 + 900 * time) * time), rate),
    'gust.wav': filtered(1, 11, (time) => 300 + 1800 * Math.sin(Math.PI * time), (time) => 1.4 * Math.sin(Math.PI * time), rate),
    'mist.wav': filtered(1.8, 5, () => 260, (time) => 1.6 * Math.sin(Math.PI * time / 1.8), rate),
    'boom.wav': filtered(1.6, 9, (time) => 180 * Math.exp(-1.5 * time) + 40, (time) => 2.2 * Math.exp(-2.2 * time), rate),
  };
}
