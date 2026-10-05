import './health-meter.css';

export interface HealthReading {
  readonly current: number;
  readonly max: number;
}

// The player's health as a row of pips, one per damage point, those lost hollow. `update` touches the page only when
// the reading changes.
export function createHealthMeter() {
  const root = document.createElement('div');
  root.className = 'health-meter';
  root.setAttribute('role', 'meter');
  root.setAttribute('aria-label', 'Health');
  root.setAttribute('aria-valuemin', '0');
  const pips: HTMLElement[] = [];
  let current = -1;
  return {
    root,
    update(health: HealthReading): void {
      if (health.max !== pips.length) {
        for (const pip of pips.splice(health.max)) pip.remove();
        while (pips.length < health.max) {
          const pip = document.createElement('span');
          pip.className = 'health-pip';
          pips.push(pip);
          root.append(pip);
        }
        root.setAttribute('aria-valuemax', String(health.max));
        current = -1;
      }
      if (health.current === current) return;
      current = health.current;
      for (const [index, pip] of pips.entries()) pip.classList.toggle('is-lost', index >= current);
      root.setAttribute('aria-valuenow', String(current));
    },
  };
}
