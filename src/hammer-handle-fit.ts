import { Box3, BufferAttribute, Matrix3, Matrix4, Mesh, Vector3 } from 'three';
import type { BufferGeometry, Object3D } from 'three';
import { SHAFT_ARTWORK_LENGTH } from './character';
import type { LoadedCharacterModel } from './character-model-types';
import { refreshOutlineNormals } from './character-shading';
import { HEAD_GRIP_MARGIN } from './grips';

// A one-model hammer is authored on the reference handle all shaft artwork uses: its head centred at this x.
export const HAMMER_MODEL_HANDLE = SHAFT_ARTWORK_LENGTH;
// Where the model's head end starts. Hands never hold nearer the head's centre, so that end keeps its size.
export const HAMMER_MODEL_HEAD_END = HAMMER_MODEL_HANDLE - HEAD_GRIP_MARGIN;
const FITTED_ATTRIBUTES = ['position', 'normal', 'tangent'] as const;

interface FittedMesh {
  readonly mesh: Mesh;
  readonly authored: BufferGeometry;
  readonly fitted: BufferGeometry;
  // The loaded geometry's bounds in model space, for inspection.
  readonly authoredBounds: Box3;
  // The mesh in model space: a local point's model x is row · point + offset, and `along` is model +X locally.
  readonly model: Matrix4;
  readonly row: Vector3;
  readonly offset: number;
  readonly along: Vector3;
}

/**
 * Fits a one-model hammer to the game's handle length. Up to HAMMER_MODEL_HEAD_END, where hands can hold, the
 * model's handle stretches along the handle; the head end keeps its size and moves with the physical head, and
 * anything behind the butt stays with it. Each mesh draws its own copy of the loaded geometry, rewritten only
 * when the handle length changes, so the model still costs one matrix copy per frame. Fit a model before shading
 * outlines it, since outline hulls share their mesh's geometry.
 */
export class HammerHandleFit {
  private readonly meshes: FittedMesh[] = [];
  private handleLength: number;

  constructor(model: LoadedCharacterModel, handleLength: number) {
    model.scene.updateMatrixWorld(true);
    model.scene.traverse((object) => {
      if (!(object instanceof Mesh) || object.userData.characterOutline === true) return;
      const authored: BufferGeometry = object.geometry;
      if (authored.getAttribute('position') === undefined) return;
      // Model space is the scene's parent space, whatever the scene is attached to.
      const placement = new Matrix4();
      for (let node: Object3D | null = object; node !== null; node = node === model.scene ? null : node.parent) {
        placement.premultiply(node.matrix);
      }
      const linear = new Matrix3().setFromMatrix4(placement);
      // A collapsed node draws nothing, so there is nothing to fit.
      if (linear.determinant() === 0) return;
      const fitted = authored.clone();
      // Float copies, so quantized glTF attributes can hold any handle length.
      for (const name of FITTED_ATTRIBUTES) {
        const source = authored.getAttribute(name);
        if (source !== undefined) fitted.setAttribute(name, new BufferAttribute(new Float32Array(source.count * source.itemSize), source.itemSize));
      }
      object.geometry = fitted;
      const authoredBounds = new Box3();
      const position = authored.getAttribute('position');
      const point = new Vector3();
      for (let index = 0; index < position.count; index++) authoredBounds.expandByPoint(point.fromBufferAttribute(position, index));
      const e = placement.elements;
      this.meshes.push({
        mesh: object, authored, fitted, model: placement,
        authoredBounds: authoredBounds.applyMatrix4(placement),
        row: new Vector3(e[0], e[4], e[8]), offset: e[12], along: new Vector3(1, 0, 0).applyMatrix3(linear.invert()),
      });
    });
    this.handleLength = handleLength;
    this.write(handleLength);
  }

  setHandleLength(handleLength: number): void {
    if (handleLength === this.handleLength) return;
    this.handleLength = handleLength;
    this.write(handleLength);
  }

  // Model-space bounds of the whole fitted model and of each mesh as loaded and as fitted; diagnostic only.
  inspect() {
    const bounds = new Box3();
    const box = new Box3();
    const range = (value: Box3) => ({ min: value.min.toArray(), max: value.max.toArray() });
    const meshes = this.meshes.map(({ fitted, model, authoredBounds }) => {
      box.copy(fitted.boundingBox!).applyMatrix4(model);
      bounds.union(box);
      return { authored: range(authoredBounds), fitted: range(box) };
    });
    return { handleLength: this.handleLength, bounds: range(bounds), meshes };
  }

  // Gives the meshes back their loaded geometry, which the model's owner disposes.
  dispose(): void {
    for (const { mesh, authored, fitted } of this.meshes) {
      mesh.geometry = authored;
      fitted.dispose();
    }
    this.meshes.length = 0;
  }

  private write(handleLength: number): void {
    // The handle up to the head end maps onto the handle up to the same margin short of the physical head.
    const stretch = (handleLength - HEAD_GRIP_MARGIN) / HAMMER_MODEL_HEAD_END;
    const shift = handleLength - HAMMER_MODEL_HANDLE;
    for (const { authored, fitted, row, offset, along } of this.meshes) {
      const position = authored.getAttribute('position');
      const normal = authored.getAttribute('normal');
      const tangent = authored.getAttribute('tangent');
      const fittedPosition = fitted.getAttribute('position');
      const fittedNormal = fitted.getAttribute('normal');
      const fittedTangent = fitted.getAttribute('tangent');
      for (let index = 0; index < position.count; index++) {
        const px = position.getX(index), py = position.getY(index), pz = position.getZ(index);
        const x = row.x * px + row.y * py + row.z * pz + offset;
        const stretched = x > 0 && x < HAMMER_MODEL_HEAD_END;
        const moved = x <= 0 ? 0 : stretched ? x * (stretch - 1) : shift;
        fittedPosition.setXYZ(index, px + moved * along.x, py + moved * along.y, pz + moved * along.z);
        if (normal !== undefined) {
          let nx = normal.getX(index), ny = normal.getY(index), nz = normal.getZ(index);
          if (stretched) {
            // Normals scale by the inverse stretch along the handle.
            const change = (1 / stretch - 1) * (along.x * nx + along.y * ny + along.z * nz);
            nx += change * row.x;
            ny += change * row.y;
            nz += change * row.z;
            const length = Math.hypot(nx, ny, nz);
            if (length > 0) {
              nx /= length;
              ny /= length;
              nz /= length;
            }
          }
          fittedNormal.setXYZ(index, nx, ny, nz);
        }
        if (tangent !== undefined) {
          let tx = tangent.getX(index), ty = tangent.getY(index), tz = tangent.getZ(index);
          if (stretched) {
            const change = (stretch - 1) * (row.x * tx + row.y * ty + row.z * tz);
            tx += change * along.x;
            ty += change * along.y;
            tz += change * along.z;
            const length = Math.hypot(tx, ty, tz);
            if (length > 0) {
              tx /= length;
              ty /= length;
              tz /= length;
            }
          }
          fittedTangent.setXYZW(index, tx, ty, tz, tangent.getW(index));
        }
      }
      for (const name of FITTED_ATTRIBUTES) {
        const attribute = fitted.getAttribute(name);
        if (attribute !== undefined) attribute.needsUpdate = true;
      }
      refreshOutlineNormals(fitted);
      fitted.computeBoundingBox();
      fitted.computeBoundingSphere();
    }
  }
}
