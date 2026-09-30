// Depth placement for a course's scenery: decorations that never collide, from the far horizon to the
// foreground. Distant scenery is placed by where it should appear on screen while the camera looks at a
// point of the climb: it barely drifts from there, while scenery near the course moves almost with it.
import VIEW_FRAME from '../../src/view-frame.json' with { type: 'json' };

// The rock shelf model's proportions, and its slab top as a share of its height; boulders stand above it.
const SHELF_SIZE = { width: 24, height: 5.01 };
const SHELF_TOP = 0.8;
// Consecutive shelves overlap a little, so no seam opens between them.
const SHELF_STEP = 0.92;
// Every third model of a row is a little shorter than the one before it.
const ROW_SHRINK = 0.12;

export class SceneryCameraError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SceneryCameraError';
  }
}

/**
 * Scenery helpers for a theme's camera (`theme.camera`), which must be the perspective camera; its vertical
 * `fieldOfView` is in degrees. The camera frames the engine's course view height, so its distance from the
 * course plane follows from the angle.
 */
export function sceneryHelpers({ perspective, fieldOfView }) {
  if (perspective !== true) {
    throw new SceneryCameraError('Depth-placed scenery needs the theme\'s perspective camera; an orthographic camera does not shrink distant decorations.');
  }
  if (typeof fieldOfView !== 'number' || !(fieldOfView > 0 && fieldOfView < 180)) {
    throw new SceneryCameraError('Scenery needs the theme\'s perspective camera fieldOfView, in degrees between 0 and 180.');
  }
  // The perspective camera's distance from the course plane.
  const distance = VIEW_FRAME.viewHeight / 2 / Math.tan(fieldOfView * Math.PI / 360);
  // How much larger than it looks a decoration at depth z must be, measured on the course plane.
  const depthScale = (z) => (distance - z) / distance;

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

  return { depthScale, far, landmark, shelves, row };
}

/** Rock shelves side by side from `left` to `right`, their tops level with `top`: ground behind the course. */
function shelves(b, left, right, top, z, height, tint) {
  const width = height * SHELF_SIZE.width / SHELF_SIZE.height;
  for (let x = left + width / 2; x - width / 2 < right; x += width * SHELF_STEP) {
    b.decoration('shelf', 'rock-shelf', x, top - height * SHELF_TOP, z, height, { tint, mirror: Math.round(x) % 2 === 0 });
  }
}

/** A row of models along a line, spaced `step` apart, alternating mirror and leaning a little. */
function row(b, model, from, to, y, z, height, step, options = {}) {
  for (let x = from, index = 0; x <= to; x += step, index++) {
    b.decoration(model, model, x, y, z, height * (1 - ROW_SHRINK * (index % 3)), {
      ...options, mirror: index % 2 === 1, angle: (options.lean ?? 0) * ((index % 3) - 1),
    });
  }
}
