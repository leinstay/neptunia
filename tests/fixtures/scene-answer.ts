// A director fake's answer (src/behavior/diary-scene.ts): the scene request's user text names its numbered sets, and
// the answer builds on set 1, keeps its first line and tells `scene`.

/** The lines of set `n` in a director request's user text, in order; [] when it has no such set. */
export function setLines(user: string, n: number): Array<string> {
  const sets = /<sets>\n([\s\S]*?)\n<\/sets>/.exec(user)?.[1] ?? '';
  const block = sets.split('\n\n').find((one) => one.startsWith(`${n}.\n`));
  return block === undefined ? [] : block.split('\n').slice(1);
}

/** Every set of a director request's user text, each as its lines. */
export function setsOf(user: string): Array<Array<string>> {
  const sets = /<sets>\n([\s\S]*?)\n<\/sets>/.exec(user)?.[1] ?? '';
  return sets === '' ? [] : sets.split('\n\n').map((block) => block.split('\n').slice(1));
}

/** The JSON text of a director answer to `user`: set 1, its first line kept, the scene `scene`. */
export function sceneAnswerText(user: string, scene = 'A STILL HARBOUR AT DUSK.'): string {
  const first = setLines(user, 1)[0];
  return JSON.stringify({ set: 1, used: first === undefined ? [] : [first], scene });
}

/** The director's whole answer to a request of `messages` with `options`, or null for a request of another purpose. */
export function directorAnswer(
  messages: unknown,
  options: unknown,
  scene?: string
): { text: string; usage: object; estimated: number } | null {
  if ((options as { purpose?: unknown } | null | undefined)?.purpose !== 'diary-scene') return null;
  const user = (messages as ReadonlyArray<{ content?: unknown }>)[1]?.content;
  return { text: sceneAnswerText(typeof user === 'string' ? user : '', scene), usage: {}, estimated: 5 };
}
