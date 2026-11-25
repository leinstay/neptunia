// `createTurnRunner` over the test world, typed as the turn runner it returns. The turn tests name it
// `createTurnRunner` and call it with the stand-ins a test holds (`runnerOptions` fills in the rest from the world), and
// `runTurn` takes a channel of the world in the place of a chat reference (`turnParams`).
import { createTurnRunner as createRealTurnRunner } from '../../src/behavior/turn.ts';
import type { TurnRunner } from '../../src/behavior/turn-types.ts';
import { onWorld } from './turn-world.ts';

// The world fills in the options a test leaves out, so the real input type (all of it required) does not fit what a
// test hands over, and `onWorld` types its runner loosely: this is the one place that says what the runner is.
export const createTurnRunner = onWorld(
  createRealTurnRunner as unknown as Parameters<typeof onWorld>[0]
) as unknown as (options?: Record<string, unknown>) => TurnRunner;
