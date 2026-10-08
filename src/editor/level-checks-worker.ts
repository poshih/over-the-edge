// The Level tab's checks, off the page's thread (src/editor/level-checks.ts): each message is one run of the engine's
// checkLevel on a posted level, answered with its plain report, or with why it could not run.
import type { Point } from '../config';
import { checkLevel } from '../course-checks';
import type { LevelCheckReport, ReachModel } from '../course-checks';

export interface LevelCheckRequest {
  readonly id: number;
  readonly level: unknown;
  readonly reach: ReachModel;
  readonly goal: Readonly<Point> | null;
  readonly setPieces: readonly string[];
  readonly stands: boolean;
}

export type LevelCheckResponse =
  | { readonly id: number; readonly report: LevelCheckReport }
  | { readonly id: number; readonly failure: string };

addEventListener('message', (event: MessageEvent<LevelCheckRequest>) => {
  const { id, level, reach, goal, setPieces, stands } = event.data;
  let response: LevelCheckResponse;
  try {
    response = { id, report: checkLevel(level, { reach, goal, setPieces, stands }) };
  } catch (error) {
    response = { id, failure: error instanceof Error ? error.message : String(error) };
  }
  postMessage(response);
});
