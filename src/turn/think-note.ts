// The think of an answer as the command line's status row shows it: one line, cut by code points. The turn copies it for
// display (`noteProgress` with the step name `think`) and her answer goes on as it was.

/** The longest think a progress note carries, in code points. */
export const THINK_NOTE_MAX = 400;

/** `think` on one line and at most `THINK_NOTE_MAX` code points, or null when it holds no word. */
export function thinkNote(think: unknown): string | null {
  if (typeof think !== 'string') return null;
  const line = think.replace(/\s*[\r\n]+\s*/g, ' ').trim();
  if (line === '') return null;
  return Array.from(line).slice(0, THINK_NOTE_MAX).join('');
}
