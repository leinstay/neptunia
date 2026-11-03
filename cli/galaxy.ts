// The small rotating ASCII galaxy of the chat's header, in place of a logo: pure frames, one per tick. With reduced
// motion the first frame stands still. Used by cli/app.ts.

const ARMS = 2;
const WIDTH = 13;
const HEIGHT = 5;
const STARS = ['*', '+', '.', '`'] as const;

/** One frame: `tick` turns the spiral, and the same tick always draws the same text. */
export function galaxyFrame(tick: number): Array<string> {
  const rows = Array.from({ length: HEIGHT }, () => Array.from({ length: WIDTH }, () => ' '));
  const turn = (tick % 24) * (Math.PI / 12);
  for (let arm = 0; arm < ARMS; arm += 1) {
    for (let step = 1; step <= 9; step += 1) {
      const angle = turn + (arm * 2 * Math.PI) / ARMS + step * 0.62;
      const radius = step / 9;
      const x = Math.round((WIDTH - 1) / 2 + Math.cos(angle) * radius * ((WIDTH - 1) / 2));
      const y = Math.round((HEIGHT - 1) / 2 + Math.sin(angle) * radius * ((HEIGHT - 1) / 2));
      const row = rows[y];
      if (row !== undefined) row[x] = STARS[Math.min(STARS.length - 1, Math.floor(radius * STARS.length))] ?? '.';
    }
  }
  const middle = rows[(HEIGHT - 1) / 2];
  if (middle !== undefined) middle[(WIDTH - 1) / 2] = '@';
  return rows.map((row) => row.join(''));
}

/** Whether the terminal or the owner asked for no motion. */
export function reducedMotion(env: Readonly<Record<string, string | undefined>>): boolean {
  return env.NEPTUNIA_REDUCED_MOTION === '1' || env.TERM === 'dumb' || env.NO_COLOR !== undefined;
}
