// What the core does with an error nothing caught. An idle HTTP/2 session of the built-in fetch closes its streams with
// `UND_ERR_INFO`, and a stream whose response nobody reads any more (a hedged request's loser) has no listener for it, so
// Node throws it at the top. That stream is over and nothing waits on it, so the process goes on. Every other uncaught error ends the process as Node would. src/index.ts calls this.

/** What the guard logs through. */
type GuardLog = { warn(msg: string, fields: object): void; error(msg: string, fields: object): void };

/** The code undici gives a stream it closed for being idle. */
const IDLE_STREAM_CODE = 'UND_ERR_INFO';

export function guardProcessErrors(log: GuardLog): void {
  process.on('uncaughtException', (error: Error & { code?: unknown }) => {
    if (error.code === IDLE_STREAM_CODE) {
      log.warn('index: idle stream closed', { code: error.code });
      return;
    }
    log.error('index: uncaught error', { error });
    process.exit(1);
  });
}
