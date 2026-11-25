// `--loop-triggers`: real triggers (`--triggers <file>`, a file of lines `<placeId> <triggerMessageId> [<turnId>]`
// read by scripts/lib/triggers.ts#parseTriggers, or one trigger as positionals) answered again, one turn each, as the
// message mode answers one (scripts/lib/replay-message.ts): the engine's own turn runner at the trigger's moment, the
// chat read over Discord up to it, the memory of the data folder (or `--snapshot`) read only, the mode and kind of the
// turn the journal recorded for it (the line's `<turnId>`, else the newest that answered it). Nothing is posted and no
// errand is dispatched. `--out` (default ./replay-loop-triggers-<time>/) gets `runs.jsonl`, one line per trigger with
// its report as the stored-turn mode writes one (scripts/lib/turn-report.ts), and `report.md` with the short table of
// each. Its requests carry the prompt-cache marker a live turn has (`--no-cache`: none). `--spend` also stops the run
// once what the provider reports spent reaches it. With `--answers-dir`, one directory serves the whole file.

import fs from 'node:fs';
import path from 'node:path';
import type { Untyped } from '../../src/tools/types.ts';
import { CliError } from './cli.ts';
import { cappedLlm } from './replay-llm.ts';
import { momentOf, turnOf } from './replay-message.ts';
import type { MessageKit } from './replay-message.ts';
import { renderLoopTriggersReport } from './replay-report.ts';
import { reportOf } from './replay-turn.ts';
import type { Rec } from './replay-types.ts';

/** The `--loop-triggers` mode (see the head of this file). Returns `{ code, result }`: code 1 on a failure or a stop. */
export async function runTriggerLoops(
  kit: MessageKit & {
    args: MessageKit['args'] & { outDir: string | null };
    liveData: string;
    budget: number | null;
    triggers: Array<{ placeId: string; triggerId: string; turnId: string | null }>;
  }
): Promise<{ code: number; result: Rec }> {
  const { args, liveData, root, triggers } = kit;
  const outDir = path.resolve(
    root,
    args.outDir ?? `replay-loop-triggers-${new Date().toISOString().replace(/[:.]/g, '-')}`
  );
  if (outDir === liveData || outDir.startsWith(`${liveData}${path.sep}`))
    throw new CliError('replay-cli: --out may not be under data/');
  if (fs.existsSync(outDir) && fs.readdirSync(outDir).length > 0)
    throw new CliError(`replay-cli: ${outDir} is not empty`);
  const capped = cappedLlm(kit.llm, kit.budget, kit.signal);
  const lines: Array<Rec> = [];
  const failed: Array<Rec> = [];
  for (const [index, trigger] of triggers.entries()) {
    if (capped.stopped.aborted) break;
    const id = `t${index + 1}`;
    try {
      const recorded = trigger.turnId
        ? (kit
            .journalOf()
            .find((record: Untyped) => record?.kind === 'turn.start' && record.turnId === trigger.turnId) ?? null)
        : null;
      const moment = await momentOf(kit, trigger.placeId, trigger.triggerId, recorded);
      const run = await turnOf({ ...kit, llm: capped.llm }, moment, `t-replay-trigger-${index + 1}`, null);
      lines.push({
        id,
        placeId: trigger.placeId,
        triggerId: trigger.triggerId,
        turnId: trigger.turnId,
        at: new Date(moment.at).toISOString(),
        mode: moment.mode,
        kind: moment.triggerKind,
        kindFrom: moment.kindFrom,
        report: reportOf(run, `t-replay-trigger-${index + 1}`, 1),
      });
    } catch (err) {
      failed.push({
        id,
        triggerId: trigger.triggerId,
        error: err instanceof CliError ? err.message : String((err as Error)?.name ?? 'Error'),
      });
    }
  }
  const stoppedBy = lines.length + failed.length === triggers.length ? null : kit.signal?.aborted ? 'signal' : 'spend';
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'runs.jsonl'), lines.map((line) => `${JSON.stringify(line)}\n`).join(''));
  fs.writeFileSync(path.join(outDir, 'report.md'), renderLoopTriggersReport(lines, { failed }));
  return {
    code: failed.length > 0 || stoppedBy !== null ? 1 : 0,
    result: {
      out: outDir,
      runs: path.join(outDir, 'runs.jsonl'),
      report: path.join(outDir, 'report.md'),
      turns: lines.length,
      failed,
      stoppedBy,
      spentUsd: capped.spent(),
    },
  };
}
