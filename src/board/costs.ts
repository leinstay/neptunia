// The board's `costs.agents`: the agents' spend over today, the last 7 and the last 30 UTC days (today included), by
// principal. A run of board_agent_runs counts for its agent, an attempt on a dev-lane task for the attempt's
// principal. Called by src/board/board.ts inside its transaction.

import type { BoardDb } from './schema.ts';

type Window = { runs: number; input: number; output: number; usd: number };
type LastWave = { wave: number; turns: number; usd: number; context_mean: number | null; context_peak: number | null };
type AgentCosts = { today: Window; last7: Window; last30: Window; last_wave: LastWave | null };

const DAY_MS = 24 * 60 * 60 * 1000;
const COST_WINDOWS = [
  ['today', 1],
  ['last7', 7],
  ['last30', 30],
] as const;

const count = (value: unknown): number => (typeof value === 'number' ? value : 0);

/**
 * The agent's latest wave (the wave of its latest started run): its turns, its dollars, its context mean weighted by
 * each turn's steps (a turn without steps weighs 1) and its peak; null when the agent has no run.
 */
function lastWave(db: BoardDb, agent: string): LastWave | null {
  const last = db
    .prepare('SELECT wave FROM board_agent_runs WHERE agent = ? ORDER BY started_at DESC, rowid DESC LIMIT 1')
    .get(agent);
  if (last === undefined) return null;
  const rows = db.prepare('SELECT * FROM board_agent_runs WHERE agent = ? AND wave IS ?').all(agent, last.wave);
  let weight = 0;
  let sum = 0;
  let peak: number | null = null;
  for (const row of rows) {
    if (typeof row.context_mean === 'number') {
      const w = count(row.steps) > 0 ? count(row.steps) : 1;
      weight += w;
      sum += row.context_mean * w;
    }
    if (typeof row.context_peak === 'number') peak = Math.max(peak ?? 0, row.context_peak);
  }
  const usd = rows.reduce((s, row) => s + count(row.cost_est_usd), 0);
  return {
    wave: count(last.wave),
    turns: rows.length,
    usd: Number(usd.toFixed(6)),
    context_mean: weight ? Math.round(sum / weight) : null,
    context_peak: peak,
  };
}

/**
 * Each agent's windows `{ runs, input, output, usd }` and its `last_wave`, keyed by principal: every name of `agents`
 * (the run recorders, listed even before their first run) and every principal with a run or a dev-lane attempt in the
 * last 30 days. A run or an attempt counts on the UTC day it started, its tokens and dollars on the day it ended (a
 * day after `nowMs` counts nowhere). `input` is the uncached input tokens, `output` the output tokens with an
 * attempt's reasoning tokens.
 */
export function agentCosts(
  db: BoardDb,
  { nowMs, agents }: { nowMs: number; agents: ReadonlyArray<string> }
): Record<string, AgentCosts> {
  const dayOf = (ms: number): number => Math.floor(ms / DAY_MS) * DAY_MS;
  const today = dayOf(nowMs);
  const starts = COST_WINDOWS.map(([name, days]) => [name, today - (days - 1) * DAY_MS] as const);
  const windowsOf = (iso: unknown): Array<string> => {
    const ms = typeof iso === 'string' ? Date.parse(iso) : NaN;
    if (!Number.isFinite(ms) || dayOf(ms) > today) return [];
    return starts.filter(([, start]) => ms >= start).map(([name]) => name);
  };
  const totals: Record<string, Record<string, Window>> = {};
  const totalsOf = (agent: string): Record<string, Window> =>
    (totals[agent] ??= Object.fromEntries(
      COST_WINDOWS.map(([name]) => [name, { runs: 0, input: 0, output: 0, usd: 0 }])
    ));
  for (const agent of agents) totalsOf(agent);
  const add = (agent: string, row: Record<string, unknown>, output: number): void => {
    const t = totalsOf(agent);
    for (const name of windowsOf(row.started_at)) {
      const w = t[name];
      if (w) w.runs += 1;
    }
    for (const name of windowsOf(row.ended_at)) {
      const w = t[name];
      if (!w) continue;
      w.input += count(row.tokens_in);
      w.output += output;
      w.usd += count(row.cost_est_usd);
    }
  };
  const since = new Date(starts[starts.length - 1]?.[1] ?? today).toISOString();
  for (const row of db
    .prepare('SELECT * FROM board_agent_runs WHERE started_at >= ? OR ended_at >= ?')
    .all(since, since)) {
    add(String(row.agent), row, count(row.tokens_out));
  }
  const attempts = db
    .prepare(
      `SELECT a.* FROM board_attempts a JOIN board_tasks t ON t.id = a.task_id
      WHERE t.lane = 'dev' AND a.principal IS NOT NULL AND (a.started_at >= ? OR a.ended_at >= ?)`
    )
    .all(since, since);
  for (const row of attempts) add(String(row.principal), row, count(row.tokens_out) + count(row.tokens_reasoning));
  const out: Record<string, AgentCosts> = {};
  for (const [agent, windows] of Object.entries(totals)) {
    const fixed = (name: string): Window => {
      const w = windows[name] ?? { runs: 0, input: 0, output: 0, usd: 0 };
      return { ...w, usd: Number(w.usd.toFixed(6)) };
    };
    out[agent] = {
      today: fixed('today'),
      last7: fixed('last7'),
      last30: fixed('last30'),
      last_wave: lastWave(db, agent),
    };
  }
  return out;
}
