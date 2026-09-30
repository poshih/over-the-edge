/**
 * The obstacle line: z = 0, the course plane where the 2D physics plays out. Every other depth is measured
 * from it: the camera frames the course on it, the level editor picks on it and decorations count their
 * depth from it. Everything that collides is drawn centred on it, so in perspective a collision outline
 * always runs through the middle of what it looks like: terrain and its artwork reach half their depth
 * toward the camera and half behind, and the pot, enemies and phantoms stand on it. Decorations never
 * collide and may sit at any depth.
 */
export const OBSTACLE_LINE = 0;
