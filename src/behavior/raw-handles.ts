// The platform objects behind a message event, as the message pipeline (src/behavior/pipeline.js) reads them.
// An event that crossed the link carries none, so the pipeline asks an injected `rawOf(event)`; an event built in
// process still carries its own `raw` and `rawPrevious`. The core never looks inside them: they are the Discord
// side's until the conversation reads leave the pipeline (core extraction plan, stage 3).

export type RawHandles = { message: unknown; previous: unknown };

type CarriesRaw = { raw?: unknown; rawPrevious?: unknown };

export function defaultRawOf(event: CarriesRaw): RawHandles | null {
  return event.raw ? { message: event.raw, previous: event.rawPrevious ?? null } : null;
}

// The message of an event and the old one of an edit, with nothing for an event `rawOf` does not know.
export function handlesOf(
  rawOf: (event: { id: string }) => RawHandles | null,
  event: { id: string } | null | undefined
): RawHandles {
  return (event && rawOf(event)) || { message: undefined, previous: null };
}
