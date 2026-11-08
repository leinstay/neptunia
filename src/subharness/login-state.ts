// Whether the last real run of a role through its harness lost its login, kept by the core for the life of the process
// and read by the chat's header (src/interface/commands/status-brief.ts). The runs feed it: her core's steps
// (src/subharness/subscription-client.ts) and the memory writer's runs (src/subharness/memory-writer.ts). A run that
// failed on a missing login marks its role and backend, the next answered run through the same backend clears the mark,
// and any other failure leaves it as it was. Nothing here starts a process or sends a request.

/** What one run through a harness came to: an answer, a lost login, or any other failure. */
export type RunOutcome = 'ok' | 'login' | 'failed';

/** The words of a vendor's answer when it has no login: Claude's `Please run /login`, `Not logged in`, an auth error. */
export const LOGIN_FAILURE = /not logged in|\/login|authenticat/i;

/** The codes a failed run carries when its harness has no login. */
const LOGIN_CODES: ReadonlySet<string> = new Set(['subscription-login', 'not-logged-in']);

/** `login` for an error whose `code` says the harness has no login, `failed` for anything else. */
export function runOutcomeOf(error: unknown): Exclude<RunOutcome, 'ok'> {
  const code: unknown = error !== null && typeof error === 'object' ? Reflect.get(error, 'code') : undefined;
  return typeof code === 'string' && LOGIN_CODES.has(code) ? 'login' : 'failed';
}

export type LoginState = {
  /** One run of `role` through `backend` ended with `outcome`. */
  ran(role: string, backend: string, outcome: RunOutcome): void;
  /** Whether the last run of `role` through `backend` that answered or lost its login lost it. */
  lost(role: string, backend: string): boolean;
};

export function createLoginState(): LoginState {
  const lostBy = new Map<string, string>();
  return {
    ran(role, backend, outcome) {
      if (outcome === 'login') lostBy.set(role, backend);
      else if (outcome === 'ok' && lostBy.get(role) === backend) lostBy.delete(role);
    },
    lost: (role, backend) => lostBy.get(role) === backend,
  };
}
