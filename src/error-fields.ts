// Reads the fields the engine looks at on a thrown value. A `catch` clause gives `unknown`, and the code that logs or
// maps a failure wants `name`, `code`, `statusCode` and the like without a check at every use. Called by the clients
// under `src/llm/`, `src/media/`, `src/web/`, `src/speech/` and `src/agent-runner/`.

/** What a failure may carry; each field is `undefined` when the thrown value has none. */
export type ErrorFields = {
  name?: unknown;
  message?: unknown;
  code?: unknown;
  status?: unknown;
  statusCode?: unknown;
  reason?: unknown;
  body?: unknown;
  data?: unknown;
  metadata?: unknown;
  errorType?: unknown;
  nativeFinishReason?: unknown;
};

/** The fields of `err` listed in `ErrorFields`: none for a value that is not an object. */
export function errorFields(err: unknown): ErrorFields {
  if (typeof err !== 'object' || err === null) return {};
  return {
    name: Reflect.get(err, 'name'),
    message: Reflect.get(err, 'message'),
    code: Reflect.get(err, 'code'),
    status: Reflect.get(err, 'status'),
    statusCode: Reflect.get(err, 'statusCode'),
    reason: Reflect.get(err, 'reason'),
    body: Reflect.get(err, 'body'),
    data: Reflect.get(err, 'data'),
    metadata: Reflect.get(err, 'metadata'),
    errorType: Reflect.get(err, 'errorType'),
    nativeFinishReason: Reflect.get(err, 'nativeFinishReason'),
  };
}
