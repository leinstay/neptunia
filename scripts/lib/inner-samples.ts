// The sample loop of an `--inner` run of scripts/replay.ts: `runSamples` runs the samples of one batch one after
// another and keeps the ones that finished. A caller's stop ends the batch before a sample, and an abort of the batch
// (the replay's SIGTERM or SIGINT) ends it at once, inside a running sample, so the finished samples can still be
// written out.

/** What one batch gave: its finished samples, the stop that ended it early, and the cut an abort made. */
export type SampleRun<TSample> = {
  samples: Array<TSample>;
  stopped: string | null;
  cut: { asked: number; finished: number } | null;
};

/** A promise that resolves once `signal` aborts. */
function aborted(signal: AbortSignal): Promise<'aborted'> {
  if (signal.aborted) return Promise.resolve('aborted');
  return new Promise((resolve) => signal.addEventListener('abort', () => resolve('aborted'), { once: true }));
}

export async function runSamples<TSample>({
  count,
  signal,
  stop,
  runOne,
}: {
  count: number;
  signal: AbortSignal;
  /** Why the batch ends before sample `n` (0-based), or null to run it. */
  stop: (n: number) => string | null;
  runOne: (n: number) => Promise<TSample>;
}): Promise<SampleRun<TSample>> {
  const samples: Array<TSample> = [];
  const cut = () => ({ samples, stopped: null, cut: { asked: count, finished: samples.length } });
  const abort = aborted(signal);
  for (let n = 0; n < count; n += 1) {
    if (signal.aborted) return cut();
    const stopped = stop(n);
    if (stopped !== null) return { samples, stopped, cut: null };
    // A sample still running when the batch is aborted is left behind: the process ends once its result is written.
    const sample = await Promise.race([runOne(n).then((value) => ({ value })), abort]);
    if (sample === 'aborted') return cut();
    samples.push(sample.value);
  }
  return { samples, stopped: null, cut: null };
}
