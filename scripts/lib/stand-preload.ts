// The preload of a replay stand run (scripts/replay-stand.ts, `node --import`): the wall clock stands still at
// `REPLAY_STAND_AT`, `Math.random` draws from a fixed seed, every random UUID counts up, and Discord's REST API answers
// from the fixture at `REPLAY_STAND_DISCORD` while every other host refuses the connection. Two runs of one case at two
// commits thus see the same times, ids, draws and platform.

import crypto from 'node:crypto';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { installStandDiscord } from './stand-discord.ts';
import type { StandDiscord } from './stand-discord.ts';

const at = Date.parse(process.env.REPLAY_STAND_AT ?? '');
if (!Number.isFinite(at)) throw new Error('replay-stand: REPLAY_STAND_AT names no moment');

let state = 0x5eed1234;
Math.random = () => {
  state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
  return state / 2 ** 32;
};

let uuids = 0;
const counted = (): `${string}-${string}-${string}-${string}-${string}` => {
  uuids += 1;
  return `00000000-0000-4000-8000-${String(uuids).padStart(12, '0')}`;
};
crypto.randomUUID = counted;
globalThis.crypto.randomUUID = counted;
syncBuiltinESMExports();

const RealDate = Date;
class StillDate extends RealDate {
  constructor(...args: Array<unknown>) {
    if (args.length === 0) super(at);
    else super(...(args as [string]));
  }
  static override now(): number {
    return at;
  }
}
globalThis.Date = StillDate as DateConstructor;

// The build of the world (scripts/replay-stand.ts `world`) writes the fixture and installs it itself.
const fixture = process.env.REPLAY_STAND_DISCORD;
if (fixture !== undefined) installStandDiscord(JSON.parse(fs.readFileSync(fixture, 'utf8')) as StandDiscord);
