// Aiming a shot that falls under gravity, as an archer's arrow does.

// A launch: its velocity, in m/s, and how long the shot takes to reach its mark, in seconds.
export interface Launch {
  velocityX: number;
  velocityY: number;
  seconds: number;
}

/**
 * The launch at `speed` that carries a shot falling at `gravity`, both positive, through the mark (dx, dy) from where it
 * starts, along the low, flatter arc or the high, lobbed one, written to `out`; false when `speed` cannot reach the
 * mark or it lies straight above or below.
 */
export function aimArc(dx: number, dy: number, speed: number, gravity: number, high: boolean, out: Launch): boolean {
  const distance = Math.abs(dx);
  const square = speed * speed;
  const discriminant = square * square - gravity * (gravity * distance * distance + 2 * dy * square);
  if (distance === 0 || discriminant < 0) return false;
  // The launch angle's tangent: (v² ∓ √(v⁴ - g(g x² + 2 y v²))) / (g x).
  const slope = (square + (high ? 1 : -1) * Math.sqrt(discriminant)) / (gravity * distance);
  const cosine = 1 / Math.sqrt(1 + slope * slope);
  out.velocityX = Math.sign(dx) * speed * cosine;
  out.velocityY = speed * cosine * slope;
  out.seconds = distance / (speed * cosine);
  return true;
}
