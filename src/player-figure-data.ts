// Metres in the character's frame; shared by artwork and the passive death bodies.
export const PLAYER_FIGURE = {
  potProfile: [[0.19, -0.47], [0.33, -0.41], [0.44, -0.28], [0.49, 0.05], [0.46, 0.23], [0.43, 0.32]],
  chest: { radius: 0.28, y: 0.56, scale: [0.82, 1.25, 0.77] },
  neck: { top: 0.07, bottom: 0.09, height: 0.16, y: 0.89 },
  helmet: { radius: 0.225, y: 1.095, scaleY: 1.06 },
  upperArm: { top: 0.065, bottom: 0.073 },
  forearm: { top: 0.055, bottom: 0.07 },
  elbow: 0.077,
  hand: 0.083,
  hammerHead: { depth: 0.22, bevel: 0.012 },
} as const;
