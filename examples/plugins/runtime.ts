import { DynamicDrawUsage, InstancedMesh, Matrix4, MeshBasicMaterial, SphereGeometry } from 'three';
import { defineRuntime, HUD, LOOKS, replace, SHOOTER } from '../../src/plugins/runtime-sdk';
import type { HudReadoutFactory, ProjectileLook, ProjectilePose } from '../../src/plugins/runtime-sdk';
import './health-bar.css';

// One readout's state belongs to its factory invocation, not the module or a shared HUD frame.
const healthBar: HudReadoutFactory = (mount) => {
  const root = document.createElement('div');
  root.className = 'example-health';
  const label = document.createElement('span');
  label.textContent = 'HEALTH';
  const meter = document.createElement('div');
  meter.className = 'example-health-meter';
  meter.setAttribute('role', 'meter');
  meter.setAttribute('aria-label', 'Health');
  meter.setAttribute('aria-valuemin', '0');
  const fill = document.createElement('span');
  fill.className = 'example-health-fill';
  meter.append(fill);
  root.append(label, meter);
  mount.append(root);
  let current = -1;
  let max = -1;
  return {
    update(frame) {
      const health = frame.health;
      if (health === null || health.current === current && health.max === max) return;
      current = health.current;
      max = health.max;
      fill.style.transform = `scaleX(${current / max})`;
      meter.setAttribute('aria-valuenow', String(current));
      meter.setAttribute('aria-valuemax', String(max));
    },
    dispose() { root.remove(); },
  };
};

function orbs(): ProjectileLook {
  const radius = 0.11;
  const mesh = new InstancedMesh(new SphereGeometry(radius, 12, 8),
    new MeshBasicMaterial({ color: 0x7be5f2, toneMapped: false }), SHOOTER.projectiles);
  mesh.count = 0;
  mesh.frustumCulled = false;
  mesh.matrixAutoUpdate = false;
  mesh.instanceMatrix.setUsage(DynamicDrawUsage);
  const matrix = new Matrix4();
  // Reuse the update range too: addUpdateRange() would allocate a new object each frame.
  const range = { start: 0, count: 0 };
  return {
    passes: { actors: mesh },
    update(projectiles: readonly ProjectilePose[]) {
      const count = projectiles.length;
      if (count === 0 && mesh.count === 0) return;
      for (let index = 0; index < count; index++) {
        const pose = projectiles[index]!;
        // The sphere's leading edge, not its centre, matches the projectile's physical tip.
        matrix.makeTranslation(pose.x - Math.cos(pose.angle) * radius, pose.y - Math.sin(pose.angle) * radius, 0);
        mesh.setMatrixAt(index, matrix);
      }
      mesh.count = count;
      if (count === 0) return;
      range.count = count * mesh.instanceMatrix.itemSize;
      mesh.instanceMatrix.updateRanges.length = 0;
      mesh.instanceMatrix.updateRanges.push(range);
      mesh.instanceMatrix.needsUpdate = true;
    },
    dispose() {
      mesh.removeFromParent();
      mesh.dispose();
      mesh.geometry.dispose();
      mesh.material.dispose();
    },
  };
}

export default defineRuntime({
  start() {
    return [replace(HUD.health, healthBar), replace(LOOKS.projectile, orbs)];
  },
});
