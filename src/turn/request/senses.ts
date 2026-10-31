// What the persona can sense and do in a turn, as its request says it: the `<senses>` lines in their stable and
// per-turn halves, and the `<skills>` catalogue of a turn whose question was what she can do. buildRequest
// (src/behavior/prompt.js), her skill reads (src/tools/impl/skills.ts) and the tool round (src/turn/tool-round.ts)
// call them.

import { isPlainObject } from '../../config.js';
import { fill } from '../../format.js';
import { gifWatchBlocker } from '../../memory/index.js';
import { IN_TURN_TOOLS, byFamily, discoveryOn } from '../../tools/discovery.ts';
import type { Base } from './head.ts';
import type { MemoryViews } from './memory.ts';
import type { Cost, Fit, Labels, RequestConfig, RequestInput } from './types.ts';

/** The two halves of `<senses>`: the lines that read only the config, and the lines of this turn. */
export type Senses = { stable: string; turn: string };

/** What renderSenses needs to know about the turn beyond the config. */
export type SensesOptions = {
  searchAvailable?: boolean;
  recallAvailable?: boolean;
  drawQuota?: { spent: boolean; userSpent: boolean } | null;
  privateChat?: boolean;
  customEmoji?: boolean;
  gifs?: boolean;
  gifWatching?: boolean;
  elsewhereDestination?: { name?: unknown } | null;
  diaryChannel?: string | null;
  participation?: boolean;
  toolsGranted?: Array<string>;
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

/**
 * Render the `<senses>` lines from `labels.senses`: which lines are true
 * under the live config (see docs/prompt-contract.md, "`<senses>`"), in two
 * halves for the prompt cache: `stable`, the lines that read only the config,
 * the prompts and the server's lists (the same on every turn of a day), and
 * `turn`, the lines that depend on this turn -- `senses.recall` (the server
 * search's daily caps), the drawing line (the quotas), `senses.participation`
 * (whether `<participation>` is shown) and `senses.privateChat` (this turn is
 * a private chat). Each half keeps the lines in the order described below.
 * Both are '' when `labels.senses` is missing entirely, so an older
 * deployment's labels.json never breaks — the block is simply omitted.
 * `drawQuota` (`{ spent, userSpent }` from the image client's quota(), or
 * undefined when no image client is wired) picks the drawing line.
 * `privateChat` adds `senses.privateChat`; outside a private chat,
 * `features.privateMessages === true` adds `senses.privateAware` instead.
 * `recallAvailable` (outside a private chat) adds `senses.recall` right after the search line.
 * With `features.coreTools` exactly true no search runs before her reply: the search line is
 * `senses.searchTool` and the recall line `senses.recallTool`, each only when `toolsGranted`
 * (her granted in-turn tools) holds `web.search` / `memory.search`; else neither. With the switch
 * on, features.webLookup on and `web.read` granted, `senses.readTool` follows the links lines.
 * With the switch on `senses.videoRewatch` is not shown (no classifier gives her a second look);
 * `senses.lookTool` stands in its place when `media.look` is granted and the image second look
 * (features.imageRelook) or video vision is on.
 * `customEmoji` (the `<emoji>` block is possible) adds `senses.customEmoji`;
 * `gifs` (features.gifs on and a non-empty library) adds `senses.gifs` right after it.
 * `gifWatching` (GIFs are watched now, src/memory/gif-watch.js#gifWatchBlocker)
 * swaps `senses.gifDescribed` for `senses.gifWatched` when the labels have it.
 * Right after the files line, `senses.time` (how to read clock times, line
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
  labels: Labels,
  {
    searchAvailable = false,
    recallAvailable = false,
    drawQuota,
    privateChat = false,
    customEmoji = false,
    gifs = false,
    gifWatching = false,
    elsewhereDestination = null,
    diaryChannel = null,
    participation = false,
    toolsGranted = [],
  }: SensesOptions = {}
): Senses {
  const senses = labels.senses;
  // features.coreTools: no search runs before her reply; she calls her own tools (granted to her by name).
  const coreTools = config.features?.coreTools === true;
  const granted = (name: string) => Array.isArray(toolsGranted) && toolsGranted.includes(name);
  if (!senses) return { stable: '', turn: '' };
  // Pictures never go into the persona's own request: she sees them through the describer's
  // captions (and her second look), so the lines say described or blind, never seen first-hand.
  const describedOn = config.features?.mediaDescriptions === true;
  const lines: Array<string | undefined> = [];
  // The lines that change from turn to turn: they stay out of the cached part.
  const turnLines: Array<string | undefined> = [];
  lines.push(describedOn ? senses.imageDescribed : senses.imageBlind);
  // A watched GIF (its animation, not one frame); an older labels.json
  // without the line keeps the one-frame one.
  const gifDescribedLine = gifWatching ? (senses.gifWatched ?? senses.gifDescribed) : senses.gifDescribed;
  lines.push(describedOn ? gifDescribedLine : senses.gifBlind);
  // Watching a video needs the describer on too; an older labels.json
  // without the video-watching lines falls back to the still-frame ones.
  const videoOn = describedOn && config.features?.videoDescriptions !== false;
  lines.push(
    videoOn ? (senses.videoWatch ?? senses.videoDescribed) : describedOn ? senses.videoDescribed : senses.videoBlind
  );
  // The second look on a question (features.videoRewatch, a missing key
  // counts as on); an older labels.json without the line shows nothing.
  // With features.coreTools no classifier gives her one: she looks again herself with media.look,
  // granted to her by name, at a picture (features.imageRelook, through the vision model) or a
  // video (video vision).
  if (coreTools) {
    const imageRelookOn = config.features?.imageRelook !== false;
    if (granted('media.look') && (imageRelookOn || videoOn) && senses.lookTool) lines.push(senses.lookTool);
  } else if (videoOn && config.features?.videoRewatch !== false && senses.videoRewatch) lines.push(senses.videoRewatch);

  // Stickers get their own lines (a picture-format one behaves like an
  // image); senses.lottie only shows up alongside them -- an animated
  // built-in (Lottie) sticker is never a picture, name only, regardless of
  // mediaDescriptions.
  const stickerLines: Array<string | undefined> = [];
  stickerLines.push(describedOn ? senses.stickerDescribed : senses.stickerBlind);
  const shownStickerLines = stickerLines.filter(Boolean);
  lines.push(...shownStickerLines);
  if (shownStickerLines.length > 0) lines.push(senses.lottie);
  // The server's custom emoji (`customEmoji`: features.customEmoji on and a
  // non-empty index); an older labels.json without the line shows nothing.
  if (customEmoji && senses.customEmoji) lines.push(senses.customEmoji);
  // The GIF library (`gifs`: features.gifs on and a non-empty library); an
  // older labels.json without the line shows nothing.
  if (gifs && senses.gifs) lines.push(senses.gifs);

  // The web lookup (features.webLookup -- a missing key counts as OFF, it
  // costs money and needs a key): the links line stays as it is and the
  // read-excerpt line follows it; the search line follows only when a search
  // key is configured (`searchAvailable`). An older labels.json without
  // either line shows nothing extra.
  const webOn = config.features?.webLookup === true;
  const readOn = webOn && config.web?.links?.enabled !== false;
  const searchOn = webOn && config.web?.search?.enabled !== false && searchAvailable === true;
  // With her own page reader (features.coreTools, web lookup on, web.read granted) the links line says a
  // preview may show the opening of the page and she can read it all, in place of "cannot open the page".
  const readerOn = webOn && coreTools && granted('web.read');
  const linksLine = videoOn
    ? (readerOn && senses.linksWatchTool) || senses.linksWatch || senses.links
    : (readerOn && senses.linksTool) || senses.links;
  lines.push(senses.voice, linksLine);
  if (readOn && senses.linksRead) lines.push(senses.linksRead);
  // Her own page reader (features.coreTools, granted to her by name): she can open a page herself.
  if (readerOn && senses.readTool) lines.push(senses.readTool);
  if (searchOn && coreTools) {
    if (granted('web.search') && senses.searchTool) lines.push(senses.searchTool);
  } else if (searchOn && senses.search) lines.push(senses.search);
  // The search of the server's own message history (`recallAvailable`: a server
  // turn where the runner is available; its own switch, not the web one); an
  // older labels.json without the line shows nothing.
  // Per turn: the runner's daily caps can close it within a day.
  if (recallAvailable === true && coreTools) {
    if (granted('memory.search') && senses.recallTool) turnLines.push(senses.recallTool);
  } else if (recallAvailable === true && senses.recall) turnLines.push(senses.recall);
  // Drawing (features.imageGeneration, a missing key counts as on) needs the
  // image client (`drawQuota` present): one line, the spent forms first. An
  // older labels.json without senses.draw shows nothing. Per turn: the quotas
  // move within a day, and the member's one with the author.
  if (drawQuota && config.features?.imageGeneration !== false && senses.draw) {
    turnLines.push(drawQuota.spent ? senses.drawSpent : drawQuota.userSpent ? senses.drawSpentUser : senses.draw);
  }
  lines.push(senses.files);
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
  else if (config.features?.privateMessages === true) lines.push(senses.privateAware);
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
export type SensesOf = { sensesOptions: SensesOptions; senses: Senses; toolsText: string; inventoryText: string };

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
    // Her own in-turn tools granted to her (features.coreTools): the search lines say she calls them.
    toolsGranted: Array.isArray(given.toolsGranted)
      ? // The names of the tools exposed to her this turn (src/tools/discovery.ts#exposedSkillNames).
        (given.toolsGranted as Array<string>).filter((name) => IN_TURN_TOOLS.includes(name))
      : [],
    drawQuota: given.drawQuota,
    privateChat,
    customEmoji: customEmoji.length > 0,
    gifs: gifsOn,
    // Whether a GIF in the transcript was watched rather than seen in one frame, under the live config and prompts.
    gifWatching: gifWatchBlocker(config, prompts) === null,
    elsewhereDestination: given.elsewhereDestination ?? null,
    diaryChannel: typeof given.diaryChannel === 'string' ? given.diaryChannel : null,
    // Fitted as if `<participation>` is shown; checked once the budget is spent.
    participation: participationOffered,
  };
  const senses = renderSenses(config, labels, sensesOptions);
  // The persona's skills (features.tools and features.toolsDiscovery, read now): the catalogue
  // with her access only on a turn whose question was what she can do (`skillsInventory`), in the
  // tail. Her tools travel as the request's `tools` (or, on the text transport, as `<tools>`).
  const skillsShown = discoveryOn(config);
  const toolsText = typeof given.toolsBlock === 'string' ? given.toolsBlock.trim() : '';
  const inventoryText = skillsShown ? skillsInventoryText(given.skillsInventory, labels) : '';
  return { sensesOptions, senses, toolsText, inventoryText };
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
