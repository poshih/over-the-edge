import { PHYSICS } from '../config';
import type { PlayerSpawn } from '../config';
import type { Game } from '../game';
import type { PracticeId } from './practices';

// The running game's state as the Workshop reports it: `window.gettingOver.snapshot()`, and what Workshop plugins read
// through their host. Built on request, never per frame.
export function workshopGameState(game: Game, context: {
  readonly practice: PracticeId | null;
  readonly placedPlayer: PlayerSpawn | null;
  readonly debug: boolean;
}) {
  const state = game.simulation.snapshot();
  const reasons = game.pauseState();
  return {
    ...state, practice: context.practice, placedPlayer: context.placedPlayer, debug: context.debug,
    parts: game.simulation.frame(1).parts.map((part) => ({
      ...part, vertices: part.vertices.map((point) => ({ ...point })),
    })),
    paused: reasons.length > 0, pauseReasons: reasons,
    pointerLocked: game.input.locked, inputMode: game.input.mode,
    camera: game.view.cameraState(), cursorScreen: game.view.project(state.cursor),
    step: PHYSICS.dt, stopped: game.halted, timer: game.timerState(), dying: game.dying, death: game.deathKind,
  };
}

export type WorkshopGameState = ReturnType<typeof workshopGameState>;
