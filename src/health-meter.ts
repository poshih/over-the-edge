import './health-meter.css';

export interface HealthReading {
  readonly current: number;
  readonly max: number;
}

// The player's health as a bar of the share of hit points left. A loss leaves a pale chunk for what it took, which
// drains away after a moment; a gain, as at a new placement, fills at once. `update` touches the page only when the
// reading changes.
export function createHealthMeter() {
  const root = document.createElement('div');
  root.className = 'health-meter';
  root.setAttribute('role', 'meter');
  root.setAttribute('aria-label', 'Health');
  root.setAttribute('aria-valuemin', '0');
  const chunk = document.createElement('span');
  chunk.className = 'health-meter-chunk';
  const fill = document.createElement('span');
  fill.className = 'health-meter-fill';
  root.append(chunk, fill);
  let current = -1;
  let max = -1;
  return {
    root,
    update(health: HealthReading): void {
      if (health.current === current && health.max === max) return;
      const lost = health.max === max && health.current < current;
      if (health.max !== max) root.setAttribute('aria-valuemax', String(health.max));
      current = health.current;
      max = health.max;
      // Without its transition the chunk keeps up with the fill.
      root.classList.toggle('is-gaining', !lost);
      const share = `scaleX(${max > 0 ? Math.min(1, Math.max(0, current / max)) : 0})`;
      fill.style.transform = share;
      chunk.style.transform = share;
      root.setAttribute('aria-valuenow', String(current));
    },
  };
}
