import { Mesh, MeshPhysicalMaterial, Vector3 } from 'three';
import type { DirectionalLight, Event, Material, Object3D, Scene } from 'three';
import { ARM_LAYER } from './arm-layer';
import { RIG } from './config';
import type { Point } from './config';
import type { GameTheme } from './theme';

// The player's tool, its hammer: the view draws this render layer of the actors last, over the marks, sharing the arms'
// depth so the hands hold it.
export const TOOL_LAYER = 2;
// The player's opaque arm and tool meshes are on this layer too. While the character casts its shadows, the actors pass
// draws it with the rest of the character, so its arms and hammer cast them as well; their own passes then draw them
// over the body as ever, so nothing shows twice.
export const CASTER_LAYER = 3;

const SHADOW = {
  // The shadow map's square, metres each way from the shoulder hinge it centres on: the jar, body, head and arms, and
  // the hammer near them. Casters farther out still shadow what lies inside.
  reach: 2.5,
  mapSize: 1024,
  // The light stands this far from the hinge, past the farthest hammer, and sees this far behind it.
  distance: 10,
  // Offsets that keep a surface from shadowing itself: along its normal in metres, and in depth.
  normalBias: 0.01,
  bias: -0.0002,
} as const;
const TEXEL = 2 * SHADOW.reach / SHADOW.mapSize;

// Where a light at `angle` around the view (0° from the right, 90° from above) and `tilt` toward the camera comes from.
function lightDirection(light: Readonly<Pick<GameTheme['characterLight'], 'angle' | 'tilt'>>, out: Vector3): Vector3 {
  const angle = light.angle * Math.PI / 180, tilt = light.tilt * Math.PI / 180;
  return out.set(Math.cos(tilt) * Math.cos(angle), Math.cos(tilt) * Math.sin(angle), Math.sin(tilt));
}

/**
 * The sunlight on the characters, the actors pass's directional light: it comes from the theme's character light and
 * follows the player's character, whose own shadows it casts while the character is 3D and the theme's shadow is above
 * zero. The shadow map covers only the character and updates once a frame, in the actors pass, so the arms and tool
 * passes reuse it.
 */
export class CharacterLight {
  private readonly light: DirectionalLight;
  private readonly direction = new Vector3();
  private shadow = false;

  constructor(light: DirectionalLight, actors: Scene, theme: GameTheme) {
    this.light = light;
    // The target moves with the character, so the scene keeps its world matrix current.
    actors.add(light.target);
    const shadow = light.shadow;
    shadow.autoUpdate = false;
    shadow.mapSize.set(SHADOW.mapSize, SHADOW.mapSize);
    shadow.normalBias = SHADOW.normalBias;
    shadow.bias = SHADOW.bias;
    const camera = shadow.camera;
    camera.left = camera.bottom = -SHADOW.reach;
    camera.right = camera.top = SHADOW.reach;
    camera.near = 0.1;
    camera.far = SHADOW.distance + SHADOW.reach;
    camera.updateProjectionMatrix();
    this.setTheme(theme);
  }

  setTheme(theme: GameTheme): void {
    const { shadow, softness } = theme.characterLight;
    lightDirection(theme.characterLight, this.direction);
    this.light.shadow.intensity = shadow / 100;
    // The shadow map's filter radius is in texels.
    this.light.shadow.radius = softness / 100 / TEXEL;
    this.shadow = shadow > 0;
  }

  // Puts the light on the character at `centre`, its root, before the actors pass, and returns whether it casts the
  // character's shadows this frame: only a 3D character does.
  place(centre: Readonly<Point>, upperBody3d: boolean): boolean {
    const target = this.light.target.position.set(centre.x, centre.y + RIG.shoulder.y, 0);
    this.light.position.copy(target).addScaledVector(this.direction, SHADOW.distance);
    const casting = this.shadow && upperBody3d;
    this.light.castShadow = casting;
    if (casting) this.light.shadow.needsUpdate = true;
    return casting;
  }

  dispose(): void {
    this.light.target.removeFromParent();
    this.light.shadow.dispose();
  }
}

// Whether light passes through none of a mesh's materials: glass and translucent parts cast no shadow.
function opaque(material: Material | Material[]): boolean {
  const materials = Array.isArray(material) ? material : [material];
  return materials.every((entry) => !entry.transparent && !(entry instanceof MeshPhysicalMaterial && entry.transmission > 0));
}

type ChildEvent = Event<'childadded' | 'childremoved', Object3D> & { child: Object3D };

/**
 * Keeps the player's character ready for its shadows as its parts come and go: the actors' character and its tool,
 * whose subtree moves to `TOOL_LAYER`. Each mesh receives the shadows, opaque ones cast them, and opaque arm and tool
 * meshes join `CASTER_LAYER`. Parts added anywhere below either root are taken in at the next `flush`, before the frame
 * draws, after whoever added them has put them on their layers; nothing is visited per frame otherwise.
 */
export class CharacterShadowParts {
  // Every watched object, and whether it belongs to the tool.
  private readonly watched = new Map<Object3D, boolean>();
  private readonly pending = new Set<Object3D>();
  private readonly added = (event: ChildEvent): void => this.watch(event.child, this.watched.get(event.target) === true);
  private readonly removed = (event: ChildEvent): void => this.unwatch(event.child);
  private readonly roots: readonly Object3D[];

  constructor(actors: Object3D, tool: Object3D) {
    this.roots = [actors, tool];
    this.watch(actors, false);
    this.watch(tool, true);
  }

  flush(): void {
    if (this.pending.size === 0) return;
    for (const root of this.pending) {
      root.traverse((object) => {
        const tool = this.watched.get(object);
        if (tool === undefined) return;
        if (tool) object.layers.set(TOOL_LAYER);
        if (!(object instanceof Mesh)) return;
        object.receiveShadow = true;
        object.castShadow = opaque(object.material);
        if (object.castShadow && (tool || object.layers.isEnabled(ARM_LAYER))) object.layers.enable(CASTER_LAYER);
      });
    }
    this.pending.clear();
  }

  dispose(): void {
    for (const root of this.roots) this.unwatch(root);
  }

  private watch(root: Object3D, tool: boolean): void {
    root.traverse((object) => {
      if (this.watched.has(object)) return;
      this.watched.set(object, tool);
      object.addEventListener('childadded', this.added);
      object.addEventListener('childremoved', this.removed);
    });
    this.pending.add(root);
  }

  // A part leaving the character keeps none of its layers; it may draw elsewhere.
  private unwatch(root: Object3D): void {
    root.traverse((object) => {
      const tool = this.watched.get(object);
      if (tool === undefined) return;
      this.watched.delete(object);
      this.pending.delete(object);
      object.removeEventListener('childadded', this.added);
      object.removeEventListener('childremoved', this.removed);
      if (tool) object.layers.set(0);
      else object.layers.disable(CASTER_LAYER);
    });
  }
}
