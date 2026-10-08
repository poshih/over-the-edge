import type { EnemyPose } from './enemy-types';
import type { HammerHead } from './hammer-head';

// World metres on the course plane; angles are radians counterclockwise.
export interface ScenePoint { readonly x: number; readonly y: number }
export interface ScenePose extends ScenePoint { readonly angle: number }
export interface SceneBounds { readonly left: number; readonly right: number; readonly bottom: number; readonly top: number }

export interface SceneCharacter {
  readonly phase: 'alive' | 'dying';
  // The drawn player centre: the live jar root, or the corpse jar.
  readonly centre: ScenePose;
  // The jar's base below that centre, in the jar's frame, in metres (negative): the game's jar outline sets it.
  readonly jarBottom: number;
  readonly torso: ScenePose;
  readonly head: ScenePose;
  // Live grip points on the drawn tool frame, or the death appearance's hands.
  readonly hands: Readonly<Record<'left' | 'right', ScenePose>>;
}

export interface SceneHammer {
  readonly held: boolean;
  readonly butt: ScenePose;
  readonly head: ScenePose;
  // The drawn head's colliding outline, head-local and borrowed, including a library hammer's own.
  readonly outline: HammerHead;
}

// One pooled, read-only view of what is drawn, including Workshop presentation previews.
// Read during update(): the record, nested poses, outline and enemies are borrowed, not previous-frame snapshots.
export interface SceneFrame {
  // Drawn simulation seconds; a restart rewinds them to 0.
  readonly time: number;
  readonly character: SceneCharacter;
  readonly hammer: SceneHammer;
  readonly cursor: ScenePoint;
  readonly enemies: readonly EnemyPose[];
  // The course plane's rectangle the camera shows; in perspective, nearer depths show less and farther ones more.
  readonly view: SceneBounds;
}

// Internal writer mirrors; SDKs expose only the read-only contract.
type Mutable<T> = { -readonly [K in keyof T]: T[K] };
interface MutableSceneCharacter extends Mutable<SceneCharacter> {
  centre: Mutable<ScenePose>;
  torso: Mutable<ScenePose>;
  head: Mutable<ScenePose>;
  hands: Record<'left' | 'right', Mutable<ScenePose>>;
}
interface MutableSceneHammer extends Mutable<SceneHammer> {
  butt: Mutable<ScenePose>;
  head: Mutable<ScenePose>;
}
export interface MutableSceneFrame extends Mutable<SceneFrame> {
  character: MutableSceneCharacter;
  hammer: MutableSceneHammer;
  cursor: Mutable<ScenePoint>;
  view: Mutable<SceneBounds>;
}

function pose(): Mutable<ScenePose> { return { x: 0, y: 0, angle: 0 }; }

export function createSceneFrame(outline: HammerHead): MutableSceneFrame {
  return {
    time: 0,
    character: { phase: 'alive', centre: pose(), jarBottom: 0, torso: pose(), head: pose(), hands: { left: pose(), right: pose() } },
    hammer: { held: true, butt: pose(), head: pose(), outline },
    cursor: { x: 0, y: 0 },
    enemies: [],
    view: { left: 0, right: 0, bottom: 0, top: 0 },
  };
}
