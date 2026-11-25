// The think of an answer as the command line's status row shows it: one line. The turn copies it for
// display (`noteProgress` with the step name `think`) and the persona's answer goes on as it was.

/** `think` on one line, or null when it holds no word. */
export function thinkNote(think: unknown): string | null {
  if (typeof think !== 'string') return null;
  const line = think.replace(/\s*[\r\n]+\s*/g, ' ').trim();
  if (line === '') return null;
  return line;
}
