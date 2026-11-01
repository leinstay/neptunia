// `renderProfile` and `profileStateFields` (src/behavior/prompt.ts) as the prompt tests call them: the profiles are
// fixtures that carry only the fields a case reads, and the labels fixture nests groups the request types read as flat,
// so each wrapper hands both over as the shapes they stand for.
import {
  profileStateFields as profileStateFieldsOf,
  renderProfile as renderProfileOf,
} from '../../src/behavior/prompt.ts';

type LabelsArg = Parameters<typeof renderProfileOf>[1];

export const renderProfile = (profile: object | null | undefined, labelSet: object, opts?: Record<string, unknown>): string =>
  renderProfileOf(profile as Parameters<typeof renderProfileOf>[0], labelSet as LabelsArg, opts);

export const profileStateFields = (
  profile: object | null | undefined,
  labelSet: object,
  opts?: Record<string, unknown>
): ReturnType<typeof profileStateFieldsOf> => profileStateFieldsOf(profile as Parameters<typeof profileStateFieldsOf>[0], labelSet as LabelsArg, opts);
