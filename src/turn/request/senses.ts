// What the persona can sense and do in a turn, as its request says it: the `<senses>` lines in their stable and
// per-turn halves, and the `<skills>` catalogue of a turn whose question was what she can do. buildRequest
// (src/behavior/prompt.js), her skill reads (src/tools/impl/skills.ts) and the tool round (src/turn/tool-round.ts)
// call them.

import { isPlainObject } from '../../config.ts';
import { fill } from '../../format.ts';
import { gifWatchBlocker } from '../../memory/index.ts';
import { ROLE_ABILITY, offRoles } from '../../llm/roles.ts';
import { collectPictures, collectVideos } from '../../media/classify.ts';
import { IN_TURN_TOOLS, byFamily } from '../../tools/discovery.ts';
import type { Base } from './head.ts';
import type { MemoryViews } from './memory.ts';
import type { Cost, Fit, Labels, RequestConfig, RequestInput } from './types.ts';

/** The two halves of `<senses>`: the lines that read only the config, and the lines of this turn. */
export type Senses = { stable: string; turn: string };

/** The labels the `<senses>` lines read. */
type SensesLabels = Pick<Labels, 'senses' | 'tools'>;

/** What renderSenses needs to know about the turn beyond the config. */
export type SensesOptions = {
  searchAvailable?: boolean;
  recallAvailable?: boolean;
  drawOn?: boolean;
  privateChat?: boolean;
  customEmoji?: boolean;
  gifs?: boolean;
  gifWatching?: boolean;
  elsewhereDestination?: { name?: unknown } | null;
  diaryChannel?: string | null;
  participation?: boolean;
  toolsGranted?: Array<string>;
  /** The messages the request shows: the media of an off role among them is told once (mediaOffLines). */
  window?: ReadonlyArray<object>;
};

/** One argument of a skill (src/tools/discovery.ts#skillArgs). */
type SkillArg = {
  readonly name: string;
  readonly values?: Array<unknown>;
  readonly more?: boolean;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly required?: boolean;
};

/** One row of the skills catalogue (src/tools/gateway.ts#listSkills). */
export type SkillRow = {
  readonly name: string;
  readonly title?: string;
  readonly whenToUse?: string;
  readonly allowed: boolean;
  readonly reason: string;
  readonly proposed?: boolean;
  readonly args?: Array<SkillArg | null>;
};

/** The abilities whose media the window may hold, with the role each needs. */
const MEDIA_ABILITIES = [
  { ability: 'imagesIn', role: 'vision' },
  { ability: 'videoIn', role: 'video' },
] as const;

/** The value at `path` below `value`, undefined at the first step that is not an object. */
function at(value: unknown, ...path: Array<string>): unknown {
  let here = value;
  for (const key of path) {
    if (here === null || typeof here !== 'object') return undefined;
    here = Reflect.get(here, key);
  }
  return here;
}

/** The lines of `reasons['ability-unavailable']` for each off role whose media the window holds, vision first. */
function mediaOffLines(config: RequestConfig, labels: SensesLabels, window: ReadonlyArray<object>): Array<string> {
  const off = offRoles(config);
  if (off.length === 0 || window.length === 0) return [];
  const template = at(labels.tools, 'result', 'reasons', 'ability-unavailable');
  const why = at(labels.tools, 'result', 'params', 'why', 'no-model');
  if (typeof template !== 'string' || typeof why !== 'string') return [];
  const held = new Set<string>();
  const sites = config.media?.video?.sites;
  for (const message of window) {
    for (const item of collectPictures(message)) {
      held.add(item.kind === 'gif' || item.kind === 'video' ? 'video' : 'vision');
    }
    if (collectVideos(message, { videoSites: sites ?? [] }).length > 0) held.add('video');
  }
  const lines: Array<string> = [];
  for (const { ability, role } of MEDIA_ABILITIES) {
    const word = at(labels.tools, 'result', 'params', 'ability', ability);
    if (off.includes(role) && held.has(role) && typeof word === 'string') {
      lines.push(fill(template, { ability: word, why }));
    }
  }
  return lines;
}

/**
 * The one line naming the abilities of the optional roles that are off (`labels.senses.abilitiesOff`, `{abilities}`
 * filled with `labels.tools.result.params.ability` words in the order vision, video, drawing, speech, joined by
 * `labels.senses.abilitiesOffSeparator`, ', ' without it). Undefined while every role is on or the label is missing.
 */
function abilitiesOffLine(config: RequestConfig, labels: SensesLabels): string | undefined {
  const template = labels.senses?.abilitiesOff;
  if (typeof template !== 'string' || !template) return undefined;
  const off = offRoles(config);
  if (off.length === 0) return undefined;
  const wordOf = (ability: string): string => {
    const word = at(labels.tools, 'result', 'params', 'ability', ability);
    return typeof word === 'string' && word ? word : ability;
  };
  const separator = labels.senses?.abilitiesOffSeparator;
  const abilities = off
    .map((role) => wordOf(String(Reflect.get(ROLE_ABILITY, role))))
    .join(typeof separator === 'string' ? separator : ', ');
  return fill(template, { abilities });
}

/**
 * Render the `<senses>` lines from `labels.senses`: which lines are true
 * under the live config (see docs/prompt-contract.md, "`<senses>`"), in two
 * halves for the prompt cache: `stable`, the lines that read only the config,
 * the prompts and the server's lists (the same on every turn of a day), and
 * `turn`, the lines that depend on this turn -- `senses.recallTool` (the server
 * search), the drawing line (`drawOn`), `senses.participation`
 * (whether `<participation>` is shown) and `senses.privateChat` (this turn is
 * a private chat). Each half keeps the lines in the order described below.
 * Both are '' when `labels.senses` is missing entirely, so an older
 * deployment's labels.json never breaks — the block is simply omitted.
 * `drawOn` (an image client and Attach Files) adds the drawing line.
 * `privateChat` adds `senses.privateChat`; outside a private chat,
 * `private.enabled` true adds `senses.privateAware` instead.
 * No search runs before her reply: the search line is `senses.searchTool` (with a search key configured) and the
 * recall line `senses.recallTool` (`recallAvailable`), each only when `toolsGranted`
 * (her granted in-turn tools) holds `web.search` / `memory.search`; else neither. With `web.read` granted,
 * `senses.readTool` follows the links lines, and `senses.lookTool` shows when `media.look` is granted.
 * `customEmoji` (the `<emoji>` block is possible) adds `senses.customEmoji`;
 * `gifs` (a non-empty library) adds `senses.gifs` right after it.
 * `gifWatching` (GIFs are watched now, src/memory/gif-watch.ts#gifWatchBlocker)
 * swaps `senses.gifDescribed` for `senses.gifWatched` when the labels have it.
 * Right after the files line, `senses.abilitiesOff` while an optional model role is off (abilitiesOffLine), then `senses.time` (how to read clock times, line
 * ages and gap markers), private chats included, when the label is a non-empty string.
 * Outside a private chat, after it: `senses.channels` (the
 * persona sees only the channels this request shows), then, with
 * `participation` (the request shows `<participation>`), `senses.participation`, then, with an
 * `elsewhereDestination` (`{ name }`, where a call from a read-only channel is
 * answered), `senses.elsewhere` with `{destination}`. With a `diaryChannel`
 * (the bare name of the diary channel; the label carries the `#`),
 * `senses.diary` with `{channel}` follows. A missing label adds nothing.
 */
// health: allow complexity until 2027-04-01 -- moved whole from src/behavior/prompt.js in stage 5d, a pure move
export function renderSenses(
  config: RequestConfig,
  labels: SensesLabels,
  {
    searchAvailable = false,
    recallAvailable = false,
    drawOn,
    privateChat = false,
    customEmoji = false,
    gifs = false,
    gifWatching = false,
    elsewhereDestination = null,
    diaryChannel = null,
    participation = false,
    toolsGranted = [],
    window = [],
  }: SensesOptions = {}
): Senses {
  const senses = labels.senses;
  // No search runs before her reply; she calls her own tools (granted to her by name).
  const granted = (name: string) => Array.isArray(toolsGranted) && toolsGranted.includes(name);
  if (!senses) return { stable: '', turn: '' };
  const lines: Array<string | undefined> = [];
  // The lines that change from turn to turn: they stay out of the cached part.
  const turnLines: Array<string | undefined> = [];
  // Pictures never go into the persona's own request: she sees them through the describer's
  // captions (and her second look), so the lines say described, never seen first-hand.
  lines.push(senses.imageDescribed);
  // A watched GIF (its animation, not one frame); an older labels.json
  // without the line keeps the one-frame one.
  lines.push(gifWatching ? (senses.gifWatched ?? senses.gifDescribed) : senses.gifDescribed);
  // An older labels.json without the video-watching line falls back to the still-frame one.
  lines.push(senses.videoWatch ?? senses.videoDescribed);
  // The second look on a question: she looks again herself with media.look, granted to her by name, at a
  // picture (through the vision model) or a video (video vision).
  if (granted('media.look') && senses.lookTool) lines.push(senses.lookTool);

  // Stickers get their own lines (a picture-format one behaves like an
  // image); senses.lottie only shows up alongside them -- an animated
  // built-in (Lottie) sticker is never a picture, name only.
  if (senses.stickerDescribed) lines.push(senses.stickerDescribed, senses.lottie);
  // The server's custom emoji (`customEmoji`: a non-empty index); an older labels.json without the line shows
  // nothing.
  if (customEmoji && senses.customEmoji) lines.push(senses.customEmoji);
  // The GIF library (`gifs`: a non-empty library); an older labels.json without the line shows nothing.
  if (gifs && senses.gifs) lines.push(senses.gifs);

  // The web lookup: the links line stays as it is and the read-excerpt line follows it; the search line follows
  // only when a search key is configured (`searchAvailable`). An older labels.json without either line shows
  // nothing extra.
  const searchOn = config.web?.search?.enabled !== false && searchAvailable === true;
  // With her own page reader (web.read granted) the links line says a preview may show the opening of the page
  // and she can read it all, in place of "cannot open the page".
  const readerOn = granted('web.read');
  const linksLine = (readerOn && senses.linksWatchTool) || senses.linksWatch || senses.links;
  lines.push(senses.voice, linksLine);
  if (senses.linksRead) lines.push(senses.linksRead);
  // Her own page reader (granted to her by name): she can open a page herself.
  if (readerOn && senses.readTool) lines.push(senses.readTool);
  if (searchOn && granted('web.search') && senses.searchTool) lines.push(senses.searchTool);
  // The search of the server's own message history (`recallAvailable`: a server turn where the runner is
  // available); an older labels.json without the line shows nothing. Per turn.
  if (recallAvailable === true && granted('memory.search') && senses.recallTool) turnLines.push(senses.recallTool);
  // Drawing needs the image client and Attach Files (`drawOn`): one line. An older labels.json without senses.draw
  // shows nothing. Per turn: Attach Files is the conversation's.
  if (drawOn === true && senses.draw) turnLines.push(senses.draw);
  lines.push(senses.files);
  lines.push(abilitiesOffLine(config, labels));
  // The media of an off role in the window: the words of the ability-unavailable answer, per turn.
  turnLines.push(...mediaOffLines(config, labels, window));
  // How to read clock times, line ages and gap markers; private chats too.
  if (typeof senses.time === 'string' && senses.time) lines.push(senses.time);
  // Which channels the persona sees, and where it answers a call from one it
  // cannot write in: a server turn only.
  if (!privateChat && senses.channels) lines.push(senses.channels);
  // The persona's own exchanges on other channels (`<participation>`), only while the block is
  // there: per turn.
  if (!privateChat && participation === true && senses.participation) turnLines.push(senses.participation);
  if (!privateChat && senses.elsewhere && typeof elsewhereDestination?.name === 'string' && elsewhereDestination.name) {
    lines.push(fill(senses.elsewhere, { destination: elsewhereDestination.name }));
  }
  // Where the persona keeps its diary, so it can speak of it anywhere.
  if (senses.diary && typeof diaryChannel === 'string' && diaryChannel)
    lines.push(fill(senses.diary, { channel: diaryChannel }));
  // Private chat: the one line for this conversation (per turn), or -- on the
  // server, with the feature on -- the rule about what was said in private.
  if (privateChat) turnLines.push(senses.privateChat);
  else if (config.private?.enabled === true) lines.push(senses.privateAware);
  return { stable: lines.filter(Boolean).join('\n'), turn: turnLines.filter(Boolean).join('\n') };
}

/**
 * The whole `<senses>` text of `senses` (renderSenses' halves), as the budget
 * counts it: the same characters as one block of every line.
 */
export function sensesWhole(senses: Senses): string {
  return [senses.stable, senses.turn].filter(Boolean).join('\n');
}

// Notation of an argument's allowed values in `<skills>`: separator, and the mark of a cut list.
const ARG_VALUE_SEPARATOR = '|';
const ARG_VALUES_MORE = '…';

/**
 * The `{args}` of one `labels.tools.line`: `forms.list` with `{list}` filled by the arguments
 * (src/tools/discovery.ts#skillArgs, in their order) joined by ', ', each its name wrapped in
 * turn by `forms.values` (`{arg}`, `{values}`: the values joined by '|', '…' after a cut list),
 * else by `forms.range` (`{arg}`, `{min}`, `{max}`; a bound the schema leaves open is ''), then
 * `forms.required` (`{arg}`);
 * a form the labels lack leaves the text as it was. '' without arguments or without `forms.list`.
 * `forms` is `labels.tools.args`.
 */
function skillArgsText(args: Array<SkillArg | null> | undefined, formsGiven: unknown): string {
  // `labels.tools.args` as the labels file gives it: checked to be an object right below, before any read, each form
  // read as text.
  const forms = formsGiven as { readonly [form: string]: unknown };
  if (
    !Array.isArray(args) ||
    args.length === 0 ||
    !isPlainObject(forms) ||
    typeof forms.list !== 'string' ||
    !forms.list
  )
    return '';
  const wrap = (key: string, text: string, values?: Record<string, unknown>) => {
    const form = forms[key];
    return typeof form === 'string' && form ? fill(form, { ...values, arg: text }) : text;
  };
  const one = (arg: SkillArg) => {
    let text = String(arg.name);
    if (Array.isArray(arg.values) && arg.values.length > 0) {
      text = wrap('values', text, {
        values: [...arg.values, ...(arg.more ? [ARG_VALUES_MORE] : [])].join(ARG_VALUE_SEPARATOR),
      });
    } else if (Number.isFinite(arg.minimum) || Number.isFinite(arg.maximum)) {
      text = wrap('range', text, {
        min: Number.isFinite(arg.minimum) ? arg.minimum : '',
        max: Number.isFinite(arg.maximum) ? arg.maximum : '',
      });
    }
    if (arg.required === true) text = wrap('required', text);
    return text;
  };
  return fill(forms.list, {
    list: args
      .filter((arg): arg is SkillArg => typeof arg?.name === 'string')
      .map(one)
      .join(', '),
  });
}

/**
 * The `<skills>` body, compact whatever the size of the catalogue: only the rows the persona may
 * use now (`allowed`), grouped by family (src/tools/discovery.ts#byFamily, an empty line between
 * families), one `labels.tools.line` each with `{name}`, `{title}`, `{whenToUse}`, `{access}`
 * and `{args}` filled; `{access}` is `labels.tools.access[<the row's reason>]`, else
 * `labels.tools.access.allowed`; `{args}` is skillArgsText of the row's `args`. A row without a
 * title (no texts in the skills layer yet) is its name alone. Rows marked `proposed` (the skills
 * a classifier named for this turn, not the whole catalogue): a line for each allowed one, then
 * the names of the others in one `labels.tools.proposedOff` line (`{names}`; none without that
 * label), except those the asker has no right to (`requester-denied`), named in one
 * `labels.tools.proposedDenied` line after it (none without that label). '' without an allowed
 * row and nothing to name, or without `labels.tools.line`.
 * Deterministic: the rows' order (the registry's) and their arguments' (the schema's) decide it.
 */
export function skillsInventoryText(rows: Array<SkillRow | null> | null | undefined, labelsGiven: object): string {
  // The live labels file, as every caller hands it.
  const labels = labelsGiven as Labels;
  const l = labels.tools;
  const template = l?.line;
  if (!Array.isArray(rows) || rows.length === 0 || typeof template !== 'string' || !template) return '';
  // `labels.tools.access` as the labels file gives it: the word of each access reason.
  const access = (isPlainObject(l?.access) ? l?.access : {}) as { readonly [reason: string]: unknown };
  const word = (row: SkillRow) => access[row.reason] ?? access.allowed ?? '';
  const named = rows.filter((row): row is SkillRow => Boolean(row) && typeof row?.name === 'string');
  const line = (row: SkillRow) =>
    row.title
      ? fill(template, {
          name: row.name,
          title: row.title,
          whenToUse: row.whenToUse ?? '',
          access: word(row),
          args: skillArgsText(row.args, l?.args),
        })
      : row.name;
  const open = byFamily(named.filter((row) => row.allowed === true)).map((group) => group.map(line).join('\n'));
  if (!named.every((row) => row.proposed === true)) return open.join('\n\n');
  // A skill the asker has no right to is not a switched-off one: each is named through its own label.
  const closed = named.filter((row) => row.allowed !== true);
  const note = (label: unknown, rows: Array<SkillRow>) =>
    rows.length > 0 && typeof label === 'string' && label
      ? fill(label, { names: rows.map((row) => row.name).join(', ') })
      : '';
  const offLine = note(
    l?.proposedOff,
    closed.filter((row) => row.reason !== 'requester-denied')
  );
  const deniedLine = note(
    l?.proposedDenied,
    closed.filter((row) => row.reason === 'requester-denied')
  );
  return [open.join('\n\n'), offLine, deniedLine].filter(Boolean).join('\n');
}

/** The senses of a turn and the options they were rendered with, her tools in text and the skills catalogue. */
export type SensesOf = {
  sensesOptions: SensesOptions;
  senses: Senses;
  toolsText: string;
  inventoryText: string;
  skillIndexText: string;
};

/**
 * The `<senses>` lines of a turn, fitted as if `<participation>` is shown, her tools in text (the text transport) and
 * the skills catalogue of a turn whose question was what she can do.
 */
// health: allow complexity until 2027-04-01 -- moved from buildRequest in src/behavior/prompt.js in stage 5d, a pure split
export function sensesOf(given: RequestInput & Base & MemoryViews): SensesOf {
  const { config, prompts, labels, privateChat, customEmoji, gifsOn, participationOffered } = given;
  const sensesOptions: SensesOptions = {
    searchAvailable: given.searchAvailable === true,
    recallAvailable: given.recallAvailable === true,
    // Her own in-turn tools granted to her: the search lines say she calls them.
    toolsGranted: Array.isArray(given.toolsGranted)
      ? // The names of the tools exposed to her this turn (src/tools/discovery.ts#exposedSkillNames).
        (given.toolsGranted as Array<string>).filter((name) => IN_TURN_TOOLS.includes(name))
      : [],
    drawOn: given.drawOn,
    window: given.history,
    privateChat,
    customEmoji: customEmoji.length > 0,
    gifs: gifsOn,
    // Whether a GIF in the transcript was watched rather than seen in one frame, under the live config and prompts.
    gifWatching: gifWatchBlocker(prompts) === null,
    elsewhereDestination: given.elsewhereDestination ?? null,
    diaryChannel: typeof given.diaryChannel === 'string' ? given.diaryChannel : null,
    // Fitted as if `<participation>` is shown; checked once the budget is spent.
    participation: participationOffered,
  };
  const senses = renderSenses(config, labels, sensesOptions);
  // The persona's skills: the catalogue
  // with her access only on a turn whose question was what she can do (`skillsInventory`), in the
  // tail. Her tools travel as the request's `tools` (or, on the text transport, as `<tools>`).
  const skillsShown = true;
  const toolsText = typeof given.toolsBlock === 'string' ? given.toolsBlock.trim() : '';
  const inventoryText = skillsShown ? skillsInventoryText(given.skillsInventory, labels) : '';
  const skillIndexText = typeof given.skillIndex === 'string' ? given.skillIndex.trim() : '';
  return { sensesOptions, senses, toolsText, inventoryText, skillIndexText };
}

/**
 * The senses line names `<participation>` only when the block is there. The request only gets shorter, so the fit
 * holds. Fills `fit`; the senses the request shows.
 */
export function sensesKept(
  fit: Fit,
  given: { config: RequestConfig; labels: Labels; participationOffered: boolean; cost: Cost } & SensesOf
): Senses {
  const { kept, stats } = fit;
  let { used } = fit;
  const { config, labels, participationOffered, cost, sensesOptions } = given;
  let { senses } = given;
  if (participationOffered && (kept.participation ?? []).length === 0) {
    const fitted = sensesWhole(senses);
    senses = renderSenses(config, labels, { ...sensesOptions, participation: false });
    const saved = cost(fitted) - cost(sensesWhole(senses));
    stats.fixed.used -= saved;
    used -= saved;
  }
  fit.used = used;
  return senses;
}
