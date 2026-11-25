// The trigger list of scripts/replay.ts --loop-triggers. Pure, no I/O.

/** One line of the triggers file. */
type Trigger = { placeId: string; triggerId: string; turnId: string | null };

const SNOWFLAKE = /^\d{17,20}$/;
const TURN_ID = /^t-[A-Za-z0-9-]{1,80}$/;

/**
 * The triggers file: one trigger per line, `<placeId> <triggerMessageId> [<turnId>]`; blank
 * lines and `#` comments are skipped. Throws an Error naming the first bad line.
 */
export function parseTriggers(text: string): Array<Trigger> {
  const out: Array<Trigger> = [];
  String(text ?? '')
    .split(/\r?\n/)
    .forEach((raw, index) => {
      const line = raw.replace(/#.*$/, '').trim();
      if (!line) return;
      const [placeId, triggerId, turnId, extra] = line.split(/\s+/);
      if (
        extra !== undefined ||
        !SNOWFLAKE.test(placeId ?? '') ||
        !SNOWFLAKE.test(triggerId ?? '') ||
        (turnId !== undefined && !TURN_ID.test(turnId))
      ) {
        throw new Error(`triggers line ${index + 1}: expected "<placeId> <triggerMessageId> [<turnId>]"`);
      }
      out.push({ placeId, triggerId, turnId: turnId ?? null });
    });
  return out;
}
