// The models the `model set` dialog offers for a base role on the direct path: OpenRouter's `/models` read on the
// role's key, kept to the models whose input and output fit what the role sends and reads back. The list only offers;
// the owner may type a model outside it, and every model is checked with one request before it is saved
// (src/keys/commands.ts). A list that cannot be read is empty. Nothing here logs or returns the key value.

import { apiUrl, openRouterHeaders } from '../llm/openrouter.ts';

/** How long the listing waits for the provider (ms). */
const LIST_TIMEOUT_MS = 15_000;

/** What a role's model must take in and give back, as OpenRouter's `architecture` modalities name it. */
type Fit = { input?: string; output: string };

/** The fit of each role: the text roles take and give text, the others are told apart by the one modality they need. */
const ROLE_FITS: Readonly<Record<string, Fit>> = {
  core: { input: 'text', output: 'text' },
  memory: { input: 'text', output: 'text' },
  analyzer: { input: 'text', output: 'text' },
  vision: { input: 'image', output: 'text' },
  video: { input: 'video', output: 'text' },
  drawing: { output: 'image' },
  speech: { output: 'audio' },
  embedding: { output: 'embeddings' },
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Whether the list `value` holds `wanted`. */
const lists = (value: unknown, wanted: string): boolean => Array.isArray(value) && value.includes(wanted);

/** Whether one `/models` entry fits `fit`. */
function fits(entry: unknown, fit: Fit): boolean {
  if (!isRecord(entry) || !isRecord(entry.architecture)) return false;
  const { input_modalities: input, output_modalities: output } = entry.architecture;
  return (fit.input === undefined || lists(input, fit.input)) && lists(output, fit.output);
}

/** The ids of OpenRouter's `/models` on the key `value` that fit `role`, in the listing's order; [] when unreadable. */
export async function listRoleModels(
  input: { fetch: typeof fetch; baseUrl: string; value: string },
  role: string
): Promise<Array<string>> {
  const fit = Object.hasOwn(ROLE_FITS, role) ? ROLE_FITS[role] : undefined;
  if (fit === undefined) return [];
  try {
    const response = await input.fetch(apiUrl(input.baseUrl, 'models'), {
      headers: openRouterHeaders(input.value),
      signal: AbortSignal.timeout(LIST_TIMEOUT_MS),
    });
    if (!response.ok) return [];
    const body: unknown = await response.json();
    const data = isRecord(body) ? body.data : null;
    if (!Array.isArray(data)) return [];
    return data
      .filter((entry) => fits(entry, fit))
      .map((entry: unknown) => (isRecord(entry) ? entry.id : null))
      .filter((id): id is string => typeof id === 'string');
  } catch {
    // an unreachable provider leaves the owner to type the model
    return [];
  }
}
