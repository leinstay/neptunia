// The real turn runner over the test's world (tests/fixtures/turn-world.ts#onWorld), for the diary's tests and fixtures:
// the world's port, reads and the persona's id are laid under the options a test gives, and `runTurn` takes a channel
// of the world.
import { createTurnRunner } from '../../src/behavior/turn.js';
import { onWorld } from './turn-world.ts';

// onWorld hands the factory the loose options a test gives, laid over the world's; the runner reads what it declares.
export const worldTurnRunner = onWorld((options) =>
  createTurnRunner(options as Parameters<typeof createTurnRunner>[0])
);
