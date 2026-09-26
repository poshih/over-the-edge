// Small, deterministic media files for project examples and verification.

// A mono 16-bit PCM WAV: a tone with a short attack and exponential decay.
export function wavFixture({ frequency = 440, seconds = 0.25, rate = 22050, decay = 12, noise = 0 } = {}) {
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
export function musicFixture({ seconds = 2, rate = 22050 } = {}) {
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
