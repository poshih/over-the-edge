// Randomness the engine's effects share: numbers that are the same on every run, and value noise for their shaders.

// A number in 0-1 for `index` and `salt`, the same on every run.
export function seeded(index: number, salt: number): number {
  let hash = Math.imul(index + 1, 0x27d4eb2d) ^ Math.imul(salt + 1, 0x165667b1);
  hash = Math.imul(hash ^ (hash >>> 15), 0x2c1b3c6d);
  hash = Math.imul(hash ^ (hash >>> 12), 0x297a2d39);
  return ((hash ^ (hash >>> 15)) >>> 0) / 4294967296;
}

export function between(range: readonly [number, number], at: number): number {
  return range[0] + (range[1] - range[0]) * at;
}

// GLSL value noise, `valueNoise(p)`, and its fractal sum, `fbm(p)`, both in 0-1.
export const VALUE_NOISE = /* glsl */ `
float hash21(vec2 p) {
  p = fract(p * vec2(234.34, 435.345));
  p += dot(p, p + 34.23);
  return fract(p.x * p.y);
}
float valueNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash21(i), hash21(i + vec2(1.0, 0.0)), u.x), mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0, 1.0)), u.x), u.y);
}
float fbm(vec2 p) {
  float sum = 0.0;
  float amplitude = 0.5;
  for (int octave = 0; octave < 4; octave++) {
    sum += amplitude * valueNoise(p);
    p = p * 2.03 + vec2(1.7, 9.2);
    amplitude *= 0.5;
  }
  return sum;
}
`;
