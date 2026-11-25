#!/usr/bin/env node
// The replay command: a real, stored or scheduled turn of the engine run again without side effects, with this
// checkout's code, prompts and memory, to check a prompt, a profile or a change of the turn's steps against real
// moments before it is deployed. Each mode lives in scripts/lib:
// - a message (scripts/lib/replay-message.ts): one real message answered again, or the request a journal turn sent;
// - a stored turn (`--turn`, `--cut`, scripts/lib/replay-stored.ts): one turn of a copy of a data folder run again by
//   the engine's own turn runner, or the copy cut at the moment a turn started;
// - a diary day (`--diary-day`, scripts/lib/replay-diary.ts): a seeded day of the diary, or entries of one kind;
// - skill scenarios (`--skills`, scripts/lib/replay-skills.ts): invented requests put to the persona after a real chat;
// - a loop run (`--loop-triggers`, scripts/lib/replay-triggers.ts): real triggers answered, every step recorded;
// - an inner turn (`--inner`, scripts/lib/replay-inner.ts): one turn of the persona's inner life run in shadow.
// The model clients run on the routing of the data folder (scripts/lib/script-routes.ts), and `--<role> <route>`
// replaces a role for this run alone. `--answers-dir <dir>` answers every request from files. Every mode that spends
// passes the spend gate first (`--spend <usd>`).
//
//   node scripts/replay.ts <placeId> <triggerMessageId> [--samples 1] [--show-request] [--snapshot <dir>] [--spend <usd>]
//   node scripts/replay.ts --show-request <turnId> [--steps] [--snapshot <dir>]
//   node scripts/replay.ts --data <copy dir> --turn <turnId> [--samples 1] [--out <dir>]
//        [--answers-dir <dir> | --answers archive | --spend <usd>] [--compare --oracle <memory.db>]
//        [--prompts <dir>] [--embed live|off] [--calibration <ratio>] [--kind <diary kind>] [--seed <text>]
//   node scripts/replay.ts --data <copy dir> --cut <turnId> --into <new copy dir>
//   node scripts/replay.ts --skills <scenarios.json> [--prompts <dir>] [--out <dir>] [--snapshot <dir>] [--dry]
//        [--core-tools] [--spend <usd>]
//   node scripts/replay.ts --loop-triggers (--triggers <file> | <placeId> <triggerMessageId>) [--no-cache]
//        [--snapshot <dir>] [--out <dir>] [--spend <usd>]
//   node scripts/replay.ts --diary-day [--seed <text>] [--date YYYY-MM-DD] [--draw fake|live] [--max-pictures <n>]
//        [--out <dir>] [--spend <usd>]
//   node scripts/replay.ts --diary-day --diary-kind <kind> [--samples n] [--seed <text>] [--prompts <dir>]
//        [--draw fake|live|none] [--max-pictures <n>] [--out <dir>] [--spend <usd>]
//   node scripts/replay.ts --inner <intention_due|errand_deadline|heartbeat> [--intention <id>] [--snapshot <dir>]
//        [--show-request] [--samples n] [--seed <text>] [--prompts <dir>] [--out <file>] [--spend <usd>]
//        [--errand-answers <file>]
//   every mode but the stored turn also takes [--<role> <route>]... [--variant "<flags>"]...
//   [--answers-dir <dir> [--answers-timeout-min 20]]; the stored turn takes [--<role> <route>]...
//
// Output: every log line, the engine's JSON lines included, goes to stderr, and stdout carries exactly one JSON
// object. THIS TOOL PRINTS AND WRITES MESSAGE CONTENTS AND MEMORY ABOUT REAL PEOPLE: it is a diagnostic to read on
// the server alone. Never paste its output into a commit, an issue or a chat. It never prints
// a token. Exit code 0 on success, 2 when the spend gate refused, 1 on any other error (the message on stderr). The
// first Ctrl-C or SIGTERM stops the run as each mode allows and keeps what finished, a second Ctrl-C exits at once, and
// a mode that does not stop ends 5 seconds after a SIGTERM.

import { CliError } from './lib/cli.ts';
import { main } from './lib/replay-main.ts';

// How long a SIGTERM waits for the run to write what it has before the process ends.
const TERM_GRACE_MS = 5000;

// Every log line, the engine's included, goes to stderr; stdout keeps only the final JSON object.
const stdoutWrite = process.stdout.write.bind(process.stdout);
// The redirect takes the three-argument form of `write`, which every caller of stdout here uses; the cast stands for
// the overload list `process.stdout.write` has and a single arrow cannot spell.
process.stdout.write = ((
  chunk: Uint8Array | string,
  encoding?: BufferEncoding,
  callback?: (err?: Error | null) => void
) => process.stderr.write(chunk, encoding, callback)) as typeof process.stdout.write;
const finish = (code: number, result: unknown) => stdoutWrite(`${JSON.stringify(result)}\n`, () => process.exit(code));

const controller = new AbortController();
// `timeout` ends a batch with SIGTERM: the run is aborted as by a first Ctrl-C, so a batch writes the samples it
// finished.
process.on('SIGTERM', () => {
  controller.abort();
  setTimeout(() => process.exit(143), TERM_GRACE_MS).unref();
});
process.on('SIGINT', () => {
  if (!controller.signal.aborted) {
    process.stderr.write('replay-cli: stopping (Ctrl-C again to exit at once)\n');
    controller.abort();
    return;
  }
  process.exit(130);
});
/** A thrown value in one line: its name and message, or its text. */
const said = (err: unknown): string => (err instanceof Error ? `${err.name}: ${err.message}` : `Error: ${String(err)}`);
process.on('unhandledRejection', (err: unknown) =>
  process.stderr.write(`replay-cli: unhandled rejection: ${said(err)}\n`)
);

main(process.argv.slice(2), { signal: controller.signal }).then(
  ({ code, result }) => finish(Number(code) || 0, result),
  (err: unknown) => {
    process.stderr.write(`${err instanceof CliError ? err.message : `replay-cli: ${said(err)}`}\n`);
    process.exit(err instanceof CliError ? err.exitCode : 1);
  }
);
