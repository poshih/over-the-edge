import { PHYSICS } from '../config';
import type { PlayerSpawn, Point } from '../config';
import type { Game } from '../game';
import type { PracticeId } from './practices';

// Plain-data readings for Workshop plugins, built on request rather than per frame. Positions are world metres,
// angles radians counterclockwise, times seconds and screen coordinates CSS pixels. No physics or plugin internals.
export interface WorkshopGameState {
  readonly paused: boolean;
  readonly pauseReasons: readonly string[];
  readonly stopped: boolean;
  readonly timer: { readonly elapsed: number; readonly running: boolean };
  readonly dying: boolean;
  readonly death: 'health' | 'fall' | null;
  readonly player: {
    readonly phase: 'alive' | 'dying';
    readonly centre: Readonly<Point> & { readonly angle: number };
  };
  readonly tip: Readonly<Point>;
  readonly aim:
    | { readonly state: 'driven'; readonly cursor: Readonly<Point>; readonly origin: Readonly<Point>;
      readonly cursorOffset: Readonly<Point>; readonly target: Readonly<Point>; readonly targetOffset: Readonly<Point> }
    | { readonly state: 'captured'; readonly cursor: Readonly<Point>; readonly target: Readonly<Point> };
  readonly drive:
    | { readonly state: 'driven'; readonly extension: number; readonly hingeTorque: number; readonly sliderForce: number }
    | { readonly state: 'released' };
  readonly time: number;
  readonly height: number;
  readonly bestHeight: number;
  readonly contacts: number;
  readonly phase: 'alive' | 'dying';
  readonly motors: 'driven' | 'released';
  // Released motors have no load reading; health is null where nothing can hurt the player.
  readonly hingeLoad: number | null;
  readonly sliderLoad: number | null;
  readonly health: { readonly current: number; readonly max: number } | null;
  readonly playerVelocity: Readonly<Point>;
  readonly potAngle: number;
  readonly headContacts: number;
  // The selected practice ID, or null when using a placed player.
  readonly practice: string | null;
  readonly placedPlayer: {
    readonly position: Readonly<Point>;
    readonly angle: number;
    readonly reach: number;
  } | null;
  readonly debug: boolean;
  readonly pointerLocked: boolean;
  readonly inputMode: 'mouse' | 'touch';
  readonly camera: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
    readonly worldHeight: number;
  };
  readonly cursorScreen: Readonly<Point>;
  readonly step: number;
}

interface GameStateContext {
  readonly practice: PracticeId | null;
  readonly placedPlayer: PlayerSpawn | null;
  readonly debug: boolean;
}

// The editor's fuller, internal `window.gettingOver.snapshot()` diagnostics. Not a plugin contract.
export function gameDiagnostics(game: Game, context: GameStateContext) {
  const state = game.simulation.snapshot();
  const reasons = game.pauseState();
  return {
    ...state, practice: context.practice, placedPlayer: context.placedPlayer, debug: context.debug,
    parts: game.simulation.frame(1).parts.map((part) => ({
      ...part, vertices: part.vertices.map((point) => ({ ...point })),
    })),
    paused: reasons.length > 0, pauseReasons: reasons,
    pointerLocked: game.input.locked, inputMode: game.input.mode,
    camera: game.view.cameraState(), cursorScreen: game.view.project(state.aim.cursor),
    step: PHYSICS.dt, stopped: game.halted, timer: game.timerState(), dying: game.dying, death: game.deathKind,
  };
}

export function workshopGameState(game: Game, context: GameStateContext): WorkshopGameState {
  const state = game.simulation.status(), readings = game.simulation.playerReadings();
  const reasons = game.pauseState(), placed = context.placedPlayer;
  return {
    paused: reasons.length > 0, pauseReasons: reasons, stopped: game.halted, timer: game.timerState(),
    dying: game.dying, death: game.deathKind, player: readings.player, tip: readings.tip, aim: readings.aim, drive: readings.drive,
    time: state.time, height: state.height, bestHeight: state.bestHeight, contacts: state.contacts,
    phase: state.phase, motors: state.motors, hingeLoad: state.hingeLoad, sliderLoad: state.sliderLoad, health: state.health,
    playerVelocity: readings.playerVelocity, potAngle: readings.potAngle, headContacts: readings.headContacts,
    practice: context.practice, placedPlayer: placed === null ? null : {
      position: { x: placed.position.x, y: placed.position.y }, angle: placed.angle, reach: placed.reach,
    }, debug: context.debug,
    pointerLocked: game.input.locked, inputMode: game.input.mode,
    camera: game.view.cameraReadings(), cursorScreen: game.view.project(readings.aim.cursor), step: PHYSICS.dt,
  };
}
