// `renderProfile` (src/behavior/prompt.ts) as the prompt tests call it: the profiles are fixtures that carry only the
// fields a case reads, and the labels fixture nests groups the request types read as flat, so the wrapper hands both
// over as the shapes they stand for.
import { renderProfile as renderProfileOf } from '../../src/behavior/prompt.ts';

type LabelsArg = Parameters<typeof renderProfileOf>[1];

export const renderProfile = (profile: object | null | undefined, labelSet: object, opts?: Record<string, unknown>): string =>
  renderProfileOf(profile as Parameters<typeof renderProfileOf>[0], labelSet as LabelsArg, opts);
