import { CylinderGeometry, ExtrudeGeometry, InstancedMesh, MeshStandardMaterial, Shape } from 'three';
import { triggerBounds, TRIGGER_LIMITS } from './level';
import { MarkerView } from './marker-view';

const FLAG = {
  poleHeight: 1.5, poleTopRadius: 0.025, poleBottomRadius: 0.035, poleSides: 8,
  poleDepth: -0.15, poleColor: 0xdbc9a0,
  width: 0.72, pointDrop: 0.12, height: 0.35, depth: 0.015,
  x: 0.03, y: 1.4, z: -0.1, color: 0xdc714d,
} as const;

export class FlagView extends MarkerView {
  constructor() {
    const pole = new CylinderGeometry(FLAG.poleTopRadius, FLAG.poleBottomRadius, FLAG.poleHeight, FLAG.poleSides);
    pole.translate(0, FLAG.poleHeight / 2, FLAG.poleDepth);
    const outline = new Shape();
    outline.moveTo(0, 0);
    outline.lineTo(FLAG.width, -FLAG.pointDrop);
    outline.lineTo(0, -FLAG.height);
    outline.closePath();
    const banner = new ExtrudeGeometry(outline, { depth: FLAG.depth, bevelEnabled: false });
    banner.translate(FLAG.x, FLAG.y, FLAG.z);
    super({
      kind: 'flag',
      meshes: [
        new InstancedMesh(pole, new MeshStandardMaterial({ color: FLAG.poleColor, roughness: 0.45, metalness: 0.4 }), TRIGGER_LIMITS.objects),
        new InstancedMesh(banner, new MeshStandardMaterial({ color: FLAG.color, roughness: 1 }), TRIGGER_LIMITS.objects),
      ],
      transform: (object, matrix) => matrix.makeTranslation(object.x, triggerBounds(object).minY, 0),
    });
  }

  update(): void {
    this.updateBounds();
  }
}
