// The chat's state and everything a key, a paste or a mouse report does to it, in one object that lives as long as the
// chat. The state is read and written synchronously, because several keys can arrive before the next render, and every
// change asks for a paint. Keys resolve through interfaces/cli/keymap.ts and dispatch in `run`. `frame` measures what the next render
// draws, so the transcript gets exactly the rows the other parts leave. Keys and a paste have one owner at a time
// (`focusOwner`), and the answer of a panel that was replaced or closed opens nothing and runs nothing. Clearing the display
// touches nothing else, and leaving ends only this process. The commands and their answers come from the caller: this file
// knows no command's meaning but `/clear` and `/attach`. interfaces/cli/app.ts draws it.
import type { Key } from 'ink';
import { alternativeText } from './attachment-actions.ts';
import type { LineChange } from './link.ts';
import type { AttachmentActions, KeptRead } from './attachment-actions.ts';
import { graphicBox, placementOf, viewFile } from './file-view.ts';
import type { ResultGraphic, ViewedFile } from './file-view.ts';
import { DEFAULT_CELL } from './terminal-graphics.ts';
import type { GraphicsSupport, Placement } from './terminal-replies.ts';
import { composerLayout, composerMaxRows, headerMode, headerRows, menuRows } from './chat-view.ts';
import type { ComposerLayout, HeaderMode } from './chat-view.ts';
import type { ClipboardResult } from './clipboard.ts';
import { GRAPHIC_SUFFIX, resultEntries, windowBody, windowChrome, windowHeight } from './command-window.ts';
import type { CommandResult } from './command-window.ts';
import {
  DEFAULT_PASTE_LIMITS,
  assembleDraft,
  attachToDraft,
  backspaceInDraft,
  chipBeforeCaret,
  deleteInDraft,
  displayDraft,
  draftFromHistory,
  dropReply,
  markReply,
  cutDraftRange,
  draftFromParts,
  draftFromText,
  draftRangeText,
  moveInDraft,
  pasteIntoDraft,
  placeCaret,
  removePart,
  replaceDraftText,
  replyOf,
  setReply,
  typeIntoDraft,
} from './composer.ts';
import type { ChatAttachment, Draft, DraftPart, PasteLimits } from './composer.ts';
import {
  applyEdit,
  coalesceEdit,
  editorStart,
  jumpToPrompt,
  popStash,
  redo,
  searchHistory,
  searchTranscript,
  stashDraft,
  undo,
} from './editor-actions.ts';
import type { EditorState } from './editor-actions.ts';
import { buildKeymap, keyNameOf } from './keymap.ts';
import type { FocusContext, KeyAction, KeyBinding, Keymap } from './keymap.ts';
import { caretCell, cellWidth, graphemes, sliceCells, transcriptBudget, wrapCells, wrapWords } from './layout.ts';
import { caretFromCell } from './mouse.ts';
import type { MouseReport } from './mouse.ts';
import type { Panel } from './panel.ts';
import {
  FOLD_LINES,
  backspace,
  browse,
  emptyInput,
  insert,
  menuOf,
  moveCursor,
  replyMarker,
  statusLine,
  submit,
} from './state.ts';
import type { InputState, MenuCommand, StatusBrief } from './state.ts';
import {
  TAIL,
  displaySafe,
  leadDigits,
  lineLead,
  lineTime,
  numberLead,
  replyLead,
  scrollView,
  transcriptWindow,
} from './transcript.ts';
import type { TranscriptDims, TranscriptEntry, TranscriptRow, TranscriptView, TranscriptWindow } from './transcript.ts';
import {
  activeTurn,
  callsInProgress,
  latestThink,
  emptyTurns,
  queuedTurns,
  reduceTurns,
  requestCancel,
  turnOf,
} from './turn-state.ts';
import type { ClientTurnEvent, TurnsState } from './turn-state.ts';

export type ChatEntry = {
  who: 'owner' | 'her' | 'system';
  text: string;
  attachments?: ReadonlyArray<ChatAttachment>;
  /** When the line was sent, in ms since the epoch: a stored line keeps its own, a new one takes the chat's clock. */
  at?: number;
  /** The line's place in the chat's whole stored history, the oldest being 1, as the core numbers it. */
  number?: number;
  /** The number of the line it replies to, drawn as `↳ #N` after its own. */
  replyTo?: number;
  /** The kinds of the files memory stores with the line, drawn as `[voice]` and the like after its text. */
  files?: ReadonlyArray<string>;
  /** The message id of a line as the link keeps it, or as the stored page names it: an edit or a deletion of the line names it. */
  messageId?: string;
};
/**
 * A file of a numbered line: its absolute path on this machine, null when the core did not keep it, and the description
 * memory stores for it.
 */
export type LineFile = { name: string; kind: string; path: string | null; description: string | null };
/** The files of a numbered line, or why there are none to name. */
export type LineFiles = { ok: true; files: ReadonlyArray<LineFile> } | { ok: false; reason: string };
/** Why an image was not staged, for the line the owner reads. */
export type StageResult = { ok: true; staged: ChatAttachment } | { ok: false; code: string };
/** Acquiring and staging an image on this machine. Nothing reaches the core until the draft is sent. */
export type ChatImages = {
  clipboard: () => Promise<ClipboardResult>;
  stageBytes: (bytes: Uint8Array, details: { name: string }) => Promise<StageResult>;
  stageFile: (file: string) => Promise<StageResult>;
  release: (id: string) => Promise<void>;
};
export type Question = {
  question: string;
  secret: boolean;
  /** a closed question: the answer is one of these, exactly as given */
  choices?: ReadonlyArray<string> | null;
  answer: (text: string) => void;
};
export type ChatEnv = {
  title: string;
  commands: ReadonlyArray<MenuCommand>;
  history: ReadonlyArray<string>;
  still: boolean;
  /**
   * One line typed: a command or a chat line, with its staged images. A slash command gives back the promise of its
   * answer's text, which the command window shows; her answer to a chat line comes through `entry`. `replyTo` is the
   * message id of the line a chat line replies to.
   */
  send: (line: string, attachments?: ReadonlyArray<ChatAttachment>, replyTo?: string) => Promise<string> | undefined;
  /** The message id of the stored line with that number, which a reply names as its parent; null when there is none. */
  replyParent?: (number: number) => Promise<string | null>;
  /** Asks the core to cancel a turn. Clearing a draft or leaving the chat never reaches this. */
  cancelTurn?: (turnId: string) => void;
  /** The text of a panel a command opens, or null when this line opens none. */
  panelOf: (line: string) => Promise<Panel | null>;
  /** Registers the listeners of what arrives from the core. */
  subscribe: (listeners: {
    entry: (entry: ChatEntry) => void;
    question: (question: Question) => void;
    connected: (connected: boolean) => void;
    /** What the core says of the turns (interfaces/cli/turn-state.ts). */
    turn: (event: ClientTurnEvent) => void;
    /** Another core answers now: the turns the last one held are gone. */
    coreRestarted: () => void;
    /** The transcript as a resumed or branched chat shows it, in place of what is on the screen. */
    view: (entries: ReadonlyArray<ChatEntry>) => void;
    /** One of her lines was edited or taken back (interfaces/cli/link.ts, `onLineChange`). */
    lineChange: (change: LineChange) => void;
  }) => void;
  status: () => Promise<StatusBrief | null>;
  /** The history after a submit, newest first, and the draft that was added to it. */
  saveHistory: (
    history: ReadonlyArray<string>,
    added?: { text: string; attachments: ReadonlyArray<ChatAttachment> }
  ) => void;
  now: () => number;
  /** The zone of the times on the transcript's lines (`bot.timezone`); absent, the machine's own. */
  timeZone?: string;
  initialInput?: string;
  /** A restored draft, in place of `initialInput`. */
  initialParts?: ReadonlyArray<DraftPart>;
  /** When a paste becomes a chip. Read at each paste, so a getter follows the settings. */
  composer?: PasteLimits;
  /** The images of the history's drafts, by the text of the draft. */
  recalled?: ReadonlyMap<string, ReadonlyArray<ChatAttachment>>;
  /** The clipboard and staging; without them Ctrl+V and `/attach` say so. */
  images?: ChatImages;
  /** What `/attach open` and `/attach save` run on the newest received image. */
  received?: AttachmentActions;
  /** A plain column in reading order, for a screen reader: no borders, no galaxy. */
  linear?: boolean;
  /** Overrides of the keys (`cli.bindings`); a conflict shows when the chat opens. */
  bindings?: ReadonlyArray<KeyBinding>;
  /** Whether the terminal's mouse reports are taken (`cli.mouse`, interfaces/cli/mouse.ts). */
  mouse?: boolean;
  /** The draft's text in the owner's editor, with the terminal handed over meanwhile. */
  editDraft?: (text: string) => Promise<{ status: 'edited' | 'cancelled' | 'failed'; text: string }>;
  /**
   * The stored lines of the command line's chat, oldest first: the newest page with `before` null, else the page that
   * ends just before the stored line `before`. Absent: the chat shows the lines of this process only.
   */
  storedPage?: (before: string | null) => Promise<ReadonlyArray<ChatEntry & { id: string }>>;
  /** The files of the stored line with that number, for `/attach open #N` and `/attach save #N`. */
  lineFiles?: (number: number) => Promise<LineFiles>;
};

/** The rows a question's selector draws at most; the input it replaces stays out of the way of the panel above it. */
const QUESTION_ROWS = 8;
const STAGE_REFUSALS: Readonly<Record<string, string>> = {
  'invalid-image': 'it is not a PNG, JPEG, GIF or WebP image',
  'too-large': 'it is larger than the image reader takes',
  vanished: 'the file cannot be read',
  failed: 'it could not be kept in the staging folder',
};
/**
 * How long Enter does nothing after a question closed and gave the draft back, counted again from each swallowed Enter. A
 * held key repeats only after its delay of up to 500 ms, so the window outlasts that delay; decided 2026-11-05.
 */
const ANSWER_BURST_MS = 700;

/** An entry as the transcript holds it: `text` is what is drawn, `original` what arrived. */
type ShownEntry = {
  id: string;
  who: ChatEntry['who'];
  text: string;
  original: string;
  attachments: ReadonlyArray<ChatAttachment>;
  /** when the line was sent, for the owner's lines and hers */
  at?: number;
  /** the stored number of the line, absent on a line the chat has not matched to its stored line yet */
  number?: number;
  /** the number of the line it replies to */
  replyTo?: number;
  /** the id of the stored line it is */
  storedId?: string;
  /** the message id of her line, as a change of it names it */
  messageId?: string;
};

/** What an edited line of hers ends with, and what a deleted one reads, as the labels word them (`model.transcript`). */
const EDITED_MARK = '(edited)';
const DELETED_LINE = 'message deleted';

/** The id of the blank row between her line and the owner's line after it. */
const GAP_PREFIX = 'gap-';
/** The id of the row of the date and minute above an owner's line. */
const TIME_PREFIX = 'time-';

/** A search of the history or the transcript. The draft waits untouched, and the query goes nowhere else. */
type Search = { kind: 'history' | 'transcript'; query: string; skip: number; viewBefore: TranscriptView };

export type Model = EditorState & {
  entries: ReadonlyArray<ShownEntry>;
  /** the last edit typed letters of a word: the next letter joins its undo step */
  isTypingWord: boolean;
  search: Search | null;
  history: ReadonlyArray<string>;
  /** the history row on show, and the unfinished draft that browsing set aside */
  browsing: number | null;
  held: Draft | null;
  selected: number;
  expanded: ReadonlySet<string>;
  view: TranscriptView;
  /** the live panel of the newest command, drawn inside the command window */
  panel: Panel | null;
  /** the session's slash commands and their answers, in the order they ran */
  results: ReadonlyArray<CommandResult>;
  isWindowOpen: boolean;
  /** where the command window is scrolled, apart from the chat */
  windowView: TranscriptView;
  question: Question | null;
  /** what is typed for the open question: a buffer of its own, so an answer reaches neither the draft nor a store */
  answer: InputState;
  connected: boolean;
  brief: StatusBrief | null;
  polledAt: number | null;
  /** one row of feedback on the status row, gone with the next key */
  notice: string | null;
  /** the transcript text the mouse selected, gone with the next key, click or scroll */
  selection: Selection | null;
  /** the selected part of the draft, `[from, to)` of what the input draws, gone with an edit, an arrow key or a click */
  draftSelection: { from: number; to: number } | null;
  /** until when Enter is swallowed, after a question closed */
  enterHeldUntil: number;
  /** what the core said of the turns */
  turns: TurnsState;
};

/** A cell of the transcript as last drawn: the index of its row on the screen and a zero-based cell in that row. */
type TranscriptCell = { row: number; col: number };
/** The chat or the command window: each scrolls and selects on its own. */
type Area = 'chat' | 'window';
/**
 * A mouse selection inside one area, from where the button went down to where it is, and the text it held when the
 * button came up.
 */
type Selection = { area: Area; anchor: TranscriptCell; focus: TranscriptCell; dragging: boolean; text: string };
/** The cells of one drawn row a selection covers, `[from, to)`. */
export type RowMark = { from: number; to: number };

/** The cells a selection covers on each row it touches, in reading order whichever way the mouse went. */
function selectionMarks({ anchor, focus }: Selection, rowCount: number): Array<RowMark | null> {
  const [first, last] =
    anchor.row < focus.row || (anchor.row === focus.row && anchor.col <= focus.col) ? [anchor, focus] : [focus, anchor];
  return Array.from({ length: rowCount }, (_none, index) => {
    if (index < first.row || index > last.row) return null;
    return { from: index === first.row ? first.col : 0, to: index === last.row ? last.col + 1 : Infinity };
  });
}

/** The text a selection covers, its rows joined by newlines. */
function selectedText(selection: Selection, rows: ReadonlyArray<TranscriptRow>): string {
  return selectionMarks(selection, rows.length)
    .flatMap((mark, index) => {
      if (mark === null) return [];
      const row = rows[index];
      // The blank cells a later row of a line starts with keep the text's column on the screen, not in the copy.
      return [sliceCells(row?.text ?? '', Math.max(mark.from, row?.pad ?? 0), mark.to)];
    })
    .join('\n');
}

/** Who takes the keys and a paste now. A question goes first, because the core is waiting on it. */
export function focusOwner({ question, panel }: Pick<Model, 'question' | 'panel'>): 'choices' | 'input' | 'panel' {
  if (question !== null) return (question.choices?.length ?? 0) > 0 ? 'choices' : 'input';
  return panel === null ? 'input' : 'panel';
}

/**
 * An entry's text with a marker for each stored file after it, in the kind names memory stores, and a row for each of its
 * images, so a terminal that cannot draw one still says what it was.
 */
function entryText(entry: ChatEntry): string {
  const images = (entry.attachments ?? []).map((one) => `[image] ${alternativeText(one)}`);
  const first = [entry.text, ...(entry.files ?? []).map((kind) => `[${kind}]`)].filter((part) => part !== '').join(' ');
  return (first === '' ? images : [first, ...images]).join('\n');
}

/**
 * What the transcript draws for an entry, with every control character made visible: the owner's text and hers as they
 * arrived, under the lead of their number, and `· ` before a notice of the chat, which carries neither.
 */
function drawnText(entry: ChatEntry): string {
  const lines = displaySafe(entryText(entry).replaceAll('\r\n', '\n')).split('\n');
  if (entry.who !== 'system') return lines.join('\n');
  return lines.map((line, index) => `${index === 0 ? '· ' : '  '}${line}`).join('\n');
}

/** The reply chip a draft starts with, as a list of parts the input history writes before the line. */
const leadingPart = ({ parts }: Draft): ReadonlyArray<DraftPart> => parts.slice(0, 1);

/** The fields of an edit alone: an editor function hands back whatever else the state held when it was called. */
const edits = ({
  draft,
  past,
  future,
  stash,
}: EditorState): Pick<EditorState, 'draft' | 'past' | 'future' | 'stash'> => ({
  draft,
  past,
  future,
  stash,
});

/** What the input shows during a search: the query and the match it finds now. */
function searchRow(
  search: Search,
  history: ReadonlyArray<string>,
  entries: ReadonlyArray<{ id: string; text: string }>
): string {
  if (search.kind === 'history') {
    const found = searchHistory(history, search.query, search.skip);
    return `history search: ${search.query}${found === null ? '' : ` → ${found.text}`}`;
  }
  const matches = searchTranscript(entries, search.query);
  const shown = search.skip < matches.length ? `${search.skip + 1} of ${matches.length}` : 'no match';
  return `transcript search: ${search.query}${search.query === '' ? '' : ` → ${shown}`}`;
}

const WHEEL_ROWS = 3;
/** Where the draft's text starts inside the box: border, padding and the `> ` prompt, one-based for a mouse report. */
const DRAFT_FIRST_COLUMN = 5;
const FILTER_ROWS = 1;
/** The status row under the input, always drawn. */
const STATUS_ROWS = 1;
/** The blank row and the rule above the slash menu. */
const MENU_CHROME_ROWS = 2;

/** What the next render draws, measured. */
export type ChatFrame = {
  owner: ReturnType<typeof focusOwner>;
  mode: HeaderMode;
  isLinear: boolean;
  hasChoices: boolean;
  items: ReadonlyArray<MenuCommand>;
  layout: ComposerLayout;
  choiceRows: number;
  menuHeight: number;
  isOffTail: boolean;
  transcript: TranscriptWindow;
  status: string;
  /** the status row under the input: the notice, the reply target, her running turn and the queue, a hidden tail; '' with none */
  statusRow: string;
  /** whether the status row opens with a notice, drawn in the warning style */
  hasNotice: boolean;
  /** the selected cells of each transcript row, in the order of `transcript.rows` */
  marks: Array<RowMark | null>;
  /** the command window's rows and the selected cells of each, or null while it is closed */
  window: { height: number; rows: Array<TranscriptRow>; marks: Array<RowMark | null>; body: number } | null;
  /** the picture placed in the command window, drawn over the frame, or null with none */
  graphic: Placement | null;
};

/** The rows of the window a picture leaves to its command line, its name and its description. */
const PICTURE_CHROME_ROWS = 3;
/** A terminal that was never asked draws no picture. */
const noGraphics = (): Promise<GraphicsSupport> => Promise.resolve({ protocol: 'none', cell: DEFAULT_CELL });

/** The command window never folds an answer: it scrolls instead. */
const NO_FOLD: Pick<TranscriptDims, 'expanded' | 'foldLines'> = { expanded: new Set(), foldLines: Infinity };

export class ChatController {
  readonly env: ChatEnv;
  readonly exit: () => void;
  readonly suspendTerminal: (work: () => Promise<void>) => Promise<void>;
  readonly paint: () => void;
  /** Puts text on the clipboard of the owner's terminal. */
  readonly copy: (text: string) => void;
  /** What the terminal draws pictures with, asked once a session (interfaces/cli/terminal-replies.ts). */
  readonly deps: { graphics?: () => Promise<GraphicsSupport> };
  readonly keymap: Keymap;
  model: Model;
  serial = 0;
  // The transcript's size as last drawn: what a scroll key measures against.
  drawn: TranscriptDims = { columns: 80, budget: 0, expanded: new Set(), foldLines: FOLD_LINES };
  // Counts the panel requests: an answer that is not of the newest one belongs to an overlay the owner left.
  panelRequest = 0;
  recalled: Map<string, ReadonlyArray<ChatAttachment>>;
  // Images whose staged bytes were released: undo cannot bring them back.
  freed = new Set<string>();
  // Where a drag that started in the draft went down, an offset of what the input draws; null with no such drag.
  draftDrag: number | null = null;
  // The input as last drawn: what a row key and a click measure against.
  drawnInput = { safe: '', width: 1, first: 0, firstRow: 0, rowCount: 0 };
  // The transcript rows as last drawn and the one-based screen row of the first: what a selection measures against.
  drawnRows: { top: number; rows: ReadonlyArray<TranscriptRow> } = { top: 1, rows: [] };
  // The command window as last drawn: its first and last screen rows, one-based, its rows and their first screen row.
  drawnWindow: { first: number; last: number; top: number; rows: ReadonlyArray<TranscriptRow>; dims: TranscriptDims } =
    {
      first: 0,
      last: -1,
      top: 1,
      rows: [],
      dims: { columns: 80, budget: 0, ...NO_FOLD },
    };
  // The command whose panel request is on its way, so Esc can mark it cancelled.
  loadingResult: string | null = null;
  // Set while a child closes itself on a key: the same key must not reach the composer that just got the focus back.
  keyTaken = false;
  // A panel request is on its way: Esc takes that back before it asks anything of the core.
  panelLoading = false;

  constructor(
    env: ChatEnv,
    {
      exit,
      suspendTerminal,
      paint,
      copy = () => {},
      graphics,
    }: Pick<ChatController, 'exit' | 'suspendTerminal' | 'paint'> &
      Partial<Pick<ChatController, 'copy'>> & { graphics?: () => Promise<GraphicsSupport> }
  ) {
    this.env = env;
    this.deps = graphics === undefined ? {} : { graphics };
    this.exit = exit;
    this.copy = copy;
    this.suspendTerminal = suspendTerminal;
    this.paint = paint;
    this.keymap = buildKeymap(env.bindings ?? []);
    this.recalled = new Map(env.recalled ?? []);
    const { conflicts } = this.keymap;
    this.model = {
      ...editorStart(
        env.initialParts === undefined
          ? draftFromText('d0', env.initialInput ?? '', env.initialInput?.length ?? 0)
          : draftFromParts('d0', env.initialParts)
      ),
      entries: [],
      isTypingWord: false,
      search: null,
      history: env.history,
      browsing: null,
      held: null,
      selected: 0,
      expanded: new Set(),
      view: TAIL,
      panel: null,
      results: [],
      isWindowOpen: false,
      windowView: TAIL,
      question: null,
      answer: emptyInput(),
      connected: true,
      brief: null,
      polledAt: null,
      notice:
        conflicts.length === 0
          ? null
          : conflicts.map((one) => `Key ${one.key} (${one.context}) not bound: ${one.reason}.`).join(' '),
      selection: null,
      draftSelection: null,
      enterHeldUntil: 0,
      turns: emptyTurns(),
    };
  }

  nextId(prefix: string): string {
    this.serial += 1;
    return `${prefix}${this.serial}`;
  }

  limits(): PasteLimits {
    return this.env.composer ?? DEFAULT_PASTE_LIMITS;
  }

  update(change: Partial<Model>): void {
    this.model = { ...this.model, ...change };
    this.paint();
  }

  /** When a line of the owner or of hers was sent: a stored line keeps its time, a new one takes the chat's clock. */
  timeOf(entry: ChatEntry): { at?: number } {
    return entry.who === 'system' ? {} : { at: entry.at ?? this.env.now() };
  }

  // The drawn entries of the last `model.entries`, and each line's entry under its lead, kept while its number holds.
  shownCache: { from: ReadonlyArray<ShownEntry>; list: Array<TranscriptEntry> } | null = null;
  led = new WeakMap<ShownEntry, { lead: string; entry: TranscriptEntry }>();
  gaps = new WeakMap<ShownEntry, TranscriptEntry>();
  times = new WeakMap<ShownEntry, TranscriptEntry>();

  /**
   * The transcript as it is drawn: each line of the owner or of hers under `[#N] `, and one blank row after her line when
   * the owner's line follows it, nowhere else. The date and minute stand on a row of their own above the owner's first
   * line and above his line after the blank row, and nowhere else. N is the line's stored number. A line without one takes the
   * number after the line before it, and a file of hers that follows her words takes theirs, since both are one line.
   */
  shownEntries(): Array<TranscriptEntry> {
    const { entries } = this.model;
    if (this.shownCache?.from === entries) return this.shownCache.list;
    // The numbers first: the newest line's number is the count of the whole stored history, and its digits pad every lead,
    // so a page of older lines loads under the same width.
    const numbers: Array<number> = [];
    let number = 0;
    let lastLine: ShownEntry | undefined;
    for (const entry of entries) {
      if (entry.who === 'system') continue;
      const isHerFile = entry.who === 'her' && lastLine?.who === 'her' && entry.original === '';
      number = entry.number ?? (isHerFile ? number : number + 1);
      numbers.push(number);
      lastLine = entry;
    }
    const digits = leadDigits(numbers.reduce((most, one) => Math.max(most, one), 0));
    const list: Array<TranscriptEntry> = [];
    let before: ShownEntry | undefined;
    let lines = 0;
    for (const entry of entries) {
      const isAfterHer = entry.who === 'owner' && before?.who === 'her';
      if (isAfterHer) list.push(this.gapOf(entry));
      if (entry.who === 'system') list.push(entry);
      else {
        if (entry.who === 'owner' && (isAfterHer || lines === 0)) list.push(this.timeOfLine(entry));
        const reply = entry.replyTo === undefined ? '' : replyLead(entry.replyTo, digits);
        list.push(this.ledOf(entry, numberLead(numbers[lines] ?? 0, digits) + reply));
        lines += 1;
      }
      before = entry;
    }
    this.shownCache = { from: entries, list };
    return list;
  }

  gapOf(entry: ShownEntry): TranscriptEntry {
    const found = this.gaps.get(entry);
    if (found !== undefined) return found;
    const gap = { id: `${GAP_PREFIX}${entry.id}`, text: '' };
    this.gaps.set(entry, gap);
    return gap;
  }

  /** The row of the date and minute in brackets above an owner's line, starting at the left edge as the numbers do. */
  timeOfLine(entry: ShownEntry): TranscriptEntry {
    const found = this.times.get(entry);
    if (found !== undefined) return found;
    const time = {
      id: `${TIME_PREFIX}${entry.id}`,
      text: `[${lineTime(entry.at ?? this.env.now(), this.env.timeZone)}]`,
    };
    this.times.set(entry, time);
    return time;
  }

  ledOf(entry: ShownEntry, lead: string): TranscriptEntry {
    const found = this.led.get(entry);
    if (found?.lead === lead && found !== undefined) return found.entry;
    const led = { id: entry.id, text: entry.text, lead };
    this.led.set(entry, { lead, entry: led });
    return led;
  }

  addEntry(entry: ChatEntry): void {
    const shown: ShownEntry = {
      id: this.nextId('e'),
      who: entry.who,
      text: drawnText(entry),
      original: entry.text,
      attachments: entry.attachments ?? [],
      ...this.timeOf(entry),
      ...(entry.number === undefined ? {} : { number: entry.number }),
      ...(entry.replyTo === undefined ? {} : { replyTo: entry.replyTo }),
      ...(entry.messageId === undefined ? {} : { messageId: entry.messageId }),
    };
    this.update({ entries: [...this.model.entries, shown] });
  }

  /**
   * One of her lines changed after it was said: an edit draws the new text and ends it with the edited mark, a deletion
   * draws the deleted label in its place and drops its images. The line keeps its place and its number.
   */
  changeLine(change: LineChange): void {
    const { entries } = this.model;
    const at = entries.findIndex((one) => one.who === 'her' && one.messageId === change.id);
    if (at < 0) return;
    const old = entries[at];
    const original = change.deleted === true ? DELETED_LINE : (change.text ?? old.original);
    const text = drawnText({ who: 'her', text: change.deleted === true ? original : `${original} ${EDITED_MARK}` });
    const next = { ...old, original, text, ...(change.deleted === true ? { attachments: [] } : {}) };
    this.update({ entries: entries.map((one, index) => (index === at ? next : one)) });
  }

  /** The transcript entries on the screen. */
  entries(): ReadonlyArray<ShownEntry> {
    const { entries } = this.model;
    return entries;
  }

  /** The id of the draft in the input. */
  draftId(): string {
    const { draft } = this.model;
    return draft.id;
  }

  /** Gives the open question its answer, if one is open. */
  answerQuestion(value: string): void {
    const { question } = this.model;
    question?.answer(value);
  }

  /** Releases the staged bytes of an image, if images are available in this chat. */
  releaseImage(id: string): void {
    const { images } = this.env;
    void images?.release(id);
  }

  /** The oldest stored line shown, whether the store holds nothing older, and whether a page is on its way. */
  stored: { oldest: string | null; done: boolean; loading: boolean } = { oldest: null, done: false, loading: false };

  /** Asks for the stored page before the oldest stored line shown and draws it above the transcript. */
  loadStoredPage(): void {
    const { storedPage } = this.env;
    const { stored } = this;
    if (storedPage === undefined || stored.done || stored.loading) return;
    stored.loading = true;
    storedPage(stored.oldest)
      .then((page) => {
        stored.loading = false;
        // A view shown meanwhile replaced the transcript this page belonged to.
        if (this.stored !== stored) return;
        if (page.length === 0) {
          stored.done = true;
          return;
        }
        stored.oldest = page[0].id;
        const shown = page.map((entry) => ({
          id: `s-${entry.id}`,
          who: entry.who,
          text: drawnText(entry),
          original: entry.text,
          attachments: entry.attachments ?? [],
          ...this.timeOf(entry),
          ...(entry.number === undefined ? {} : { number: entry.number }),
          ...(entry.replyTo === undefined ? {} : { replyTo: entry.replyTo }),
          ...(entry.messageId === undefined ? {} : { messageId: entry.messageId }),
          storedId: entry.id,
        }));
        this.update({ entries: [...shown, ...this.model.entries] });
      })
      .catch(() => {
        stored.loading = false;
        this.say('The stored lines of this chat could not be read.');
      });
  }

  /**
   * Gives the lines said since the newest stored line on the screen the numbers of their stored lines: the newest stored
   * page, read again, matched in order by who said each line and its text. A stored line the screen lacks, such as one
   * from another client, is passed over, and a line not yet stored keeps the number after the line before it.
   */
  renumberLive(): void {
    const { storedPage } = this.env;
    if (storedPage === undefined) return;
    storedPage(null)
      .then((page) => {
        const { entries } = this.model;
        const known = new Set(entries.map((one) => one.storedId));
        const lastStored = entries.findLastIndex((one) => one.storedId !== undefined);
        const live = entries.slice(lastStored + 1).filter((one) => one.who !== 'system' && one.number === undefined);
        const matched = new Map<string, { number: number; storedId: string; replyTo?: number }>();
        let from = 0;
        for (const line of page) {
          if (known.has(line.id) || line.number === undefined) continue;
          const at = live.findIndex(
            (one, index) => index >= from && one.who === line.who && one.original === line.text
          );
          if (at < 0) continue;
          const reply = line.replyTo === undefined ? {} : { replyTo: line.replyTo };
          matched.set(live[at].id, { number: line.number, storedId: line.id, ...reply });
          from = at + 1;
        }
        if (matched.size === 0) return;
        const now = this.model.entries;
        this.update({ entries: now.map((one) => ({ ...one, ...matched.get(one.id) })) });
      })
      .catch(() => {});
  }

  /** Registers with the core's link, once, and draws the newest stored lines. */
  subscribe(): void {
    this.env.subscribe({
      entry: (entry) => this.addEntry(entry),
      question: (asked) => {
        // Only one question fits the screen: the older command gets the empty answer of a cancelled one.
        this.answerQuestion('');
        this.update({ question: asked, answer: emptyInput() });
      },
      connected: (now) => this.update({ connected: now }),
      turn: (event) => this.onTurnEvent(event),
      coreRestarted: () => {
        const lost = queuedTurns(this.model.turns).length + (activeTurn(this.model.turns) === null ? 0 : 1);
        this.update({ turns: emptyTurns() });
        if (lost > 0) this.say(`The core restarted, and ${lost} lines it held are gone: send them again.`);
      },
      view: (entries) => this.showView(entries),
      lineChange: (change) => this.changeLine(change),
    });
    this.loadStoredPage();
  }

  /** The core's word about a turn. A failure or a cancel leaves a line, and a streamed text shows until the end of its turn. */
  onTurnEvent(event: ClientTurnEvent): void {
    // Her turn is over: its lines are on their way to the store, and the lines before it are there.
    if (event.type === 'committed' || event.type === 'failed' || event.type === 'cancelled') this.renumberLive();
    const before = turnOf(this.model.turns, event.turnId);
    const turns = reduceTurns(this.model.turns, event);
    const turn = turnOf(turns, event.turnId);
    this.update({ turns });
    if (turn === null || turn === before) return;
    const liveId = `live-${event.turnId}`;
    if (turn.state === 'running' && turn.text !== '') {
      const live: ShownEntry = {
        id: liveId,
        who: 'her',
        text: displaySafe(turn.text),
        original: turn.text,
        attachments: [],
        at: this.entries().find((one) => one.id === liveId)?.at ?? this.env.now(),
      };
      const isShown = this.entries().some((one) => one.id === liveId);
      this.update({
        entries: isShown
          ? this.entries().map((one) => (one.id === liveId ? live : one))
          : [...this.model.entries, live],
      });
    } else if (turn.state !== 'queued' && turn.state !== 'accepted') {
      this.update({ entries: this.entries().filter((one) => one.id !== liveId) });
    }
    if (event.type === 'failed')
      this.say(
        turn.code === 'no-own-turn'
          ? 'No turn of its own followed this line: she read it with the others, or the core left it.'
          : `Her turn over this line failed (${turn.code ?? 'unknown'}).`
      );
    if (event.type === 'cancelled') this.say('Her turn over this line was cancelled. The line stays said.');
  }

  /** The transcript of a resumed or branched chat. The draft stays as it is. */
  showView(entries: ReadonlyArray<ChatEntry>): void {
    // A resumed or branched view shows its own lines whole: Page Up has no stored page to add to it.
    this.stored = { oldest: null, done: true, loading: false };
    this.update({ entries: [], view: TAIL, expanded: new Set() });
    for (const entry of entries) this.addEntry(entry);
  }

  /**
   * The status row under the input, every short notice of the moment on one row: the notice of the last key, the line the
   * next message replies to, her running turn and the queue, the rows below a transcript read further up and her newest think.
   */
  statusRow(hiddenBelow: number): string {
    const { notice, draft } = this.model;
    const reply = replyOf(draft) ?? replyMarker(displayDraft(draft))?.number ?? null;
    return [
      notice,
      reply === null ? null : `replying to #${reply}`,
      this.turnRow(),
      hiddenBelow > 0 ? `↓ ${hiddenBelow} rows below · Page Down` : null,
      this.thinkRow(),
    ]
      .filter((one) => one !== null)
      .join(' · ');
  }

  /** Her running turn on the status row: the calls she is making, whether a cancel is on its way and how many lines wait. */
  turnRow(): string | null {
    const active = activeTurn(this.model.turns);
    const queued = queuedTurns(this.model.turns).length;
    const calls = active === null ? [] : callsInProgress(active);
    const doing = calls.length === 0 ? 'Her turn is running' : `using ${calls.join(', ')}`;
    const parts = [
      ...(active === null ? [] : [active.cancelRequested ? 'Cancelling her turn…' : doing]),
      ...(queued === 0 ? [] : [`${queued} queued`]),
    ];
    return parts.length === 0 ? null : parts.join(' · ');
  }

  /**
   * What she thought at the newest answer of her running turn. It is the last part of the row, so a narrow terminal cuts it
   * and nothing else, and it is read from the turn's events alone: nothing stores it, and it leaves with the turn.
   */
  thinkRow(): string | null {
    const active = activeTurn(this.model.turns);
    return active === null ? null : latestThink(active);
  }

  /** Esc on an empty input: one request for the running turn, which runs on until the core says it stopped. */
  cancelRunningTurn(): void {
    const active = activeTurn(this.model.turns);
    if (active === null || active.cancelRequested) return;
    this.update({ turns: requestCancel(this.model.turns, active.turnId) });
    this.env.cancelTurn?.(active.turnId);
  }

  /** A read of what the core already knows: no probe and no provider call for the display. */
  pollStatus(): void {
    void this.env
      .status()
      .then((answer) => {
        if (answer !== null) this.update({ brief: answer, polledAt: this.env.now() });
      })
      .catch(() => {});
  }

  /** The same key must not reach the composer that a child's close just gave the focus back. */
  takeKey(): void {
    this.keyTaken = true;
    queueMicrotask(() => {
      this.keyTaken = false;
    });
  }

  /** A panel closed by its own Esc takes the command window with it. */
  closePanel(): void {
    this.takeKey();
    this.closeWindow();
  }

  /** Esc while the window is open: it closes, and a panel still on its way opens nothing. The draft stays. */
  closeWindow(): void {
    if (this.panelLoading) {
      this.panelLoading = false;
      this.panelRequest += 1;
      if (this.loadingResult !== null) this.answerResult(this.loadingResult, 'Cancelled.', { reopens: false });
    }
    this.update({ panel: null, isWindowOpen: false, windowView: TAIL, selection: null });
  }

  /**
   * The answer of one command, in its place in the window, with the moment it came. An answer that comes while the window
   * is closed opens it at its tail, so a command that ran in the background shows its result; a cancel the owner caused
   * by closing or by a newer command reopens nothing.
   */
  answerResult(id: string, answer: string, how: { reopens: boolean } = { reopens: true }): void {
    const { results, isWindowOpen } = this.model;
    const finishedAt = this.env.now();
    const reopen = how.reopens && !isWindowOpen ? { isWindowOpen: true, windowView: TAIL, selection: null } : {};
    this.update({
      results: results.map((one) => (one.id === id ? { ...one, answer, finishedAt } : one)),
      ...reopen,
    });
  }

  closeQuestion(value: string): void {
    this.takeKey();
    this.answerQuestion(value);
    this.endQuestion();
  }

  prefill(line: string): void {
    this.takeKey();
    this.update({ panel: null, draft: replaceDraftText(draftFromText(this.nextId('d'), '', 0), line) });
  }

  /** A key for the input. `renderedOwner` is who held the keys when the frame on the screen was drawn. */
  onKey(text: string, key: Key, renderedOwner: ReturnType<typeof focusOwner>): void {
    if (key.ctrl && text === 'c') {
      this.copyOrLeave();
      return;
    }
    if (renderedOwner !== 'input' || focusOwner(this.model) !== 'input' || this.keyTaken) return;
    if (this.model.draftSelection !== null && this.onSelectedDraft(text, key)) return;
    // A held Enter can come as one chunk of returns, which Ink hands over as text.
    if (/^\r{2,}$/.test(text)) {
      for (let press = 0; press < text.length; press += 1) this.send();
      return;
    }
    if (this.model.notice !== null || this.model.selection !== null) this.update({ notice: null, selection: null });
    const name = keyNameOf(text, key);
    const action = name === null ? null : this.keymap.resolve(this.contextOf(this.model), name);
    if (action !== null) this.run(action);
    else if (name === null && text !== '' && !key.meta) this.typed(text);
  }

  /** Ctrl+C: the draft's selection, else the transcript's, goes to the clipboard; with neither the chat ends. */
  copyOrLeave(): void {
    const { selection, draftSelection, draft, question, search } = this.model;
    // The draft's selection counts only while the draft is what the input draws.
    if (draftSelection !== null && question === null && search === null) this.copyDraftSelection(draft, draftSelection);
    else if (selection === null || selection.text === '') this.exit();
    else this.copySelection(selection.text);
  }

  /**
   * A key while part of the draft is selected: typing replaces it, Backspace and Delete remove it, Esc drops it alone.
   * Any other key drops it and does what it does; false lets it go on to do that.
   */
  onSelectedDraft(text: string, key: Key): boolean {
    const now = this.model;
    const name = keyNameOf(text, key);
    const action = name === null ? null : this.keymap.resolve(this.contextOf(now), name);
    const isText = name === null && text !== '' && !key.meta;
    if (isText || action === 'composer.backspace' || action === 'composer.delete') {
      this.cutDraftSelection(isText ? text.replaceAll('\r', '\n') : '');
      return true;
    }
    this.update({ draftSelection: null, notice: null });
    return action === 'composer.clear';
  }

  /** The selected part of the draft goes, and `replacement` stands in its place, as one step of undo. */
  cutDraftSelection(replacement: string): void {
    const { draft, draftSelection } = this.model;
    if (draftSelection === null) return;
    const cut = cutDraftRange(draft, draftSelection.from, draftSelection.to);
    this.editDraft(typeIntoDraft(cut.draft, replacement));
    for (const part of cut.removed) this.afterRemoval(part);
  }

  /** Ctrl+C over a selection in the draft: the text it stands for goes to the clipboard, and the selection stays. */
  copyDraftSelection(draft: Draft, { from, to }: { from: number; to: number }): void {
    const text = draftRangeText(draft, from, to);
    this.copy(text);
    this.update({ notice: `copied ${graphemes(text).length} chars to clipboard` });
  }

  onPaste(payload: string): void {
    if (
      this.model.draftSelection !== null &&
      this.keymap.resolve(this.contextOf(this.model), 'paste') === 'composer.paste'
    )
      this.cutDraftSelection('');
    const now = this.model;
    const action = this.keymap.resolve(this.contextOf(now), 'paste');
    if (action === 'question.paste') this.update({ answer: insert(now.answer, payload) });
    else if (action === 'search.paste') this.typed(payload);
    else this.editDraft(pasteIntoDraft(now.draft, { id: this.nextId('p'), payload }, this.limits()));
  }

  /** What the input draws now: the draft, the answer as typed or as stars, or the search. */
  inputText(): { shown: string; caretAt: number } {
    const { search, question, draft, answer, history } = this.model;
    if (search !== null) {
      const shown = searchRow(search, history, this.originals());
      return { shown, caretAt: shown.length };
    }
    if (question === null) return { shown: displayDraft(draft), caretAt: draft.cursor };
    if (!question.secret) return { shown: answer.text, caretAt: answer.cursor };
    return {
      shown: '*'.repeat(graphemes(answer.text).length),
      caretAt: graphemes(answer.text.slice(0, answer.cursor)).length,
    };
  }

  /** The rows of everything on the next frame: the transcript gets `max(0, R - F - C - O)`, nothing is estimated. */
  frame(rows: number, columns: number): ChatFrame {
    const now = this.model;
    const { question: asked, panel, view, expanded, notice } = now;
    const owner = focusOwner(now);
    const isLinear = this.env.linear === true;
    const hasChoices = owner === 'choices';
    const items = this.itemsOf(now);
    const mode = headerMode(rows, columns, isLinear);
    const questionRows = asked === null ? 0 : wrapWords(asked.question, columns).length;
    // The status row stands under the input whether or not it holds anything, so no notice moves the layout.
    const fixed = headerRows(mode) + STATUS_ROWS + questionRows;
    const { shown, caretAt } = this.inputText();
    const layout = composerLayout(shown, caretAt, {
      columns,
      maxRows: composerMaxRows(rows, fixed, isLinear),
      isLinear,
      mark: asked === null && now.search === null ? now.draftSelection : null,
    });
    const choiceRows = Math.min(QUESTION_ROWS, Math.max(1, rows - fixed - FILTER_ROWS));
    const inputRows = hasChoices ? choiceRows + FILTER_ROWS : layout.height;
    const isMenuOpen = panel === null && items.length > 0;
    const menuHeight = isMenuOpen ? menuRows(items.length, rows - fixed - inputRows - MENU_CHROME_ROWS - 1) : 0;
    // The menu stands under a blank row and a rule, so it never touches the last line above it.
    const menuBlock = isMenuOpen ? menuHeight + MENU_CHROME_ROWS : 0;
    // The open command window takes half of what the header and the input leave, and the chat keeps the rest.
    const height = windowHeight(rows - fixed - inputRows - menuBlock, now.isWindowOpen);
    const budget = transcriptBudget({ rows, fixed, composer: inputRows, overlay: menuBlock + height });
    const isOffTail = view.kind === 'anchor';
    this.drawn = {
      columns,
      budget,
      expanded,
      // A folded answer starts on the screen: the fold's own row and its lines fit what the terminal has left.
      foldLines: Math.max(1, Math.min(FOLD_LINES, budget - 1)),
    };
    this.drawnInput = {
      safe: layout.safe,
      width: layout.width,
      first: layout.first,
      // One-based, as a mouse report counts: above the box's lower border and the status row.
      firstRow: rows - STATUS_ROWS - (isLinear ? 0 : 1) - layout.rows.length + 1,
      rowCount: layout.rows.length,
    };
    const window = transcriptWindow(this.shownEntries(), view, this.drawn);
    // An expanded last entry can be taller than the budget: its newest rows show, and Page Up reaches the rest.
    const cut = Math.max(0, window.rows.length - this.drawn.budget);
    const transcript =
      cut === 0 ? window : { ...window, rows: window.rows.slice(cut), hiddenAbove: window.hiddenAbove + cut };
    // The rows stand at the bottom of their area, under the header.
    this.drawnRows = {
      top: headerRows(mode) + 1 + Math.max(0, this.drawn.budget - transcript.rows.length),
      rows: transcript.rows,
    };
    const shownWindow = this.measureWindow(height, headerRows(mode) + budget + 1, columns);
    return {
      owner,
      mode,
      isLinear,
      hasChoices,
      items,
      layout,
      choiceRows,
      menuHeight,
      isOffTail,
      transcript,
      status: statusLine(now.brief, { connected: now.connected, polledAt: now.polledAt, now: this.env.now() }),
      statusRow: this.statusRow(isOffTail ? transcript.hiddenBelow : 0),
      hasNotice: notice !== null,
      marks: this.marksOf('chat', transcript.rows.length),
      window: shownWindow,
      graphic: this.placement,
    };
  }

  /** The cells the selection covers on each drawn row of one area, none when it lies in the other. */
  marksOf(area: Area, rowCount: number): Array<RowMark | null> {
    const { selection } = this.model;
    return selection?.area === area ? selectionMarks(selection, rowCount) : [];
  }

  /** The command window's rows, its rule on the screen row `first`, or null while it is closed. */
  measureWindow(height: number, first: number, columns: number): ChatFrame['window'] {
    const now = this.model;
    const body = windowBody(height, now.panel !== null);
    // A live panel draws in place of the rows, so no row of the window is drawn or scrolled meanwhile.
    const dims: TranscriptDims = { columns, budget: now.panel === null ? body : 0, ...NO_FOLD };
    const picture = this.pictureSlot(columns, dims.budget);
    const slots = new Map(picture === null ? [] : [[picture.id, picture.box.rows]]);
    const shown = transcriptWindow(resultEntries(now.results, this.env.timeZone, slots), now.windowView, dims);
    // The rows stand at the bottom of the window, under its rule.
    const ruleRows = windowChrome(height, now.panel !== null).rule ? 1 : 0;
    const top = first + ruleRows + Math.max(0, dims.budget - shown.rows.length);
    this.drawnWindow = { first, last: first + height - 1, top, rows: shown.rows, dims };
    this.placement = now.isWindowOpen && picture !== null ? this.placed(picture, shown.rows, top) : null;
    if (!now.isWindowOpen) return null;
    return { height, rows: shown.rows, marks: this.marksOf('window', shown.rows.length), body };
  }

  /** The picture placed over the frame, as the last frame measured it. */
  placement: Placement | null = null;
  /** The drawing of the newest picture at the box it was drawn for, so a Sixel picture is encoded once a size. */
  drawing: { key: string; placement: Placement } | null = null;

  /**
   * The newest result's picture and the box it takes: the window's width past the lead, and its rows but the three the
   * command line, the name and the description take. Only the newest picture is drawn; an older one keeps its text.
   */
  pictureSlot(
    columns: number,
    body: number
  ): { id: string; graphic: ResultGraphic; box: ReturnType<typeof graphicBox>; indent: number } | null {
    const { results } = this.model;
    const at = results.findLastIndex((one) => one.graphic !== undefined);
    const result = results[at];
    if (result?.graphic === undefined || body <= PICTURE_CHROME_ROWS) return null;
    const indent = cellWidth(lineLead(result.at, at + 1, this.env.timeZone, leadDigits(results.length)));
    const box = graphicBox(result.graphic, columns - indent, body - PICTURE_CHROME_ROWS);
    return { id: result.id, graphic: result.graphic, box, indent };
  }

  /** Where the picture is drawn: only while every one of its rows is in the window, else nowhere. */
  placed(
    picture: NonNullable<ReturnType<ChatController['pictureSlot']>>,
    rows: ReadonlyArray<TranscriptRow>,
    top: number
  ): Placement | null {
    const id = `${picture.id}${GRAPHIC_SUFFIX}`;
    const first = rows.findIndex((row) => row.entryId === id);
    if (first < 0 || rows.filter((row) => row.entryId === id).length !== picture.box.rows) return null;
    const { box } = picture;
    const key = `${picture.id}|${box.columns}x${box.rows}|${top + first}`;
    if (this.drawing?.key !== key)
      this.drawing = {
        key,
        placement: placementOf(picture.graphic, box, { row: top + first, column: 1 + picture.indent, key: picture.id }),
      };
    return this.drawing.placement;
  }

  /** The slash commands the menu offers. */
  commands(): ChatEnv['commands'] {
    const { commands } = this.env;
    return commands;
  }

  whoOf(entryId: string): ShownEntry['who'] | undefined {
    if (entryId.startsWith(TIME_PREFIX)) return 'system';
    return this.entries().find((one) => one.id === entryId)?.who;
  }

  itemsOf = (now: Model): Array<MenuCommand> =>
    now.question === null ? menuOf(displayDraft(now.draft), this.env.commands) : [];

  /** Closes the question. Its draft waits in the composer, and a held Enter must not send it unseen. */
  endQuestion(): void {
    this.update({ question: null, answer: emptyInput(), enterHeldUntil: this.env.now() + ANSWER_BURST_MS });
  }

  completeCommand(item: MenuCommand): void {
    const { draft } = this.model;
    this.update({ draft: replaceDraftText(draft, `/${item.name} `), selected: 0 });
  }

  send(): void {
    const now = this.model;
    if (now.question !== null) {
      now.question.answer(now.answer.text);
      this.endQuestion();
      return;
    }
    if (this.env.now() < now.enterHeldUntil) {
      this.update({ enterHeldUntil: this.env.now() + ANSWER_BURST_MS });
      return;
    }
    const shown = displayDraft(now.draft);
    const item = this.itemsOf(now)[now.selected];
    if (item !== undefined && !this.commands().some((one) => shown === `/${one.name}`)) {
      this.completeCommand(item);
      return;
    }
    const assembled = assembleDraft(now.draft);
    if (!assembled.ok) {
      this.update({ notice: 'A pasted text is gone and the message stays here: Backspace removes its chip.' });
      return;
    }
    const line = assembled.text;
    const { attachments } = assembled;
    const isCommand = line.trim().startsWith('/');
    // A marker typed with no blank after it, as `[#34]hi`, is still read when the line goes.
    const marker = isCommand || assembled.replyTo !== null ? null : replyMarker(line);
    const replyNumber = isCommand ? null : (assembled.replyTo ?? marker?.number ?? null);
    const text = marker?.text ?? line;
    if (replyNumber !== null && text.trim() === '' && attachments.length === 0) {
      this.update({ notice: `Write the reply to line #${replyNumber} after its marker.` });
      return;
    }
    if (replyNumber !== null) {
      const typed = assembled.replyTo === null ? line : `${displayDraft({ parts: leadingPart(now.draft) })}${line}`;
      this.sendReply(replyNumber, typed, text, attachments);
      return;
    }
    this.sendLine(line, attachments);
  }

  /** Enter sends a reply only once line `number` is found: the draft stays until then, and stays when it is not found. */
  replyPending = false;

  sendReply(number: number, typed: string, text: string, attachments: ReadonlyArray<ChatAttachment>): void {
    const { replyParent } = this.env;
    const refuse = (): void => this.update({ notice: `No line #${number} in this chat.` });
    if (replyParent === undefined) {
      refuse();
      return;
    }
    if (this.replyPending) return;
    this.replyPending = true;
    const draft = this.model.draft;
    const found = (parent: string | null): void => {
      this.replyPending = false;
      if (parent === null) refuse();
      else if (this.model.draft !== draft)
        this.update({ notice: `The draft changed before line #${number} was found.` });
      else this.sendLine(typed, attachments, { number, parent, text });
    };
    replyParent(number).then(found, () => found(null));
  }

  /** The draft goes: a command to the window, a chat line to her, a reply with its parent and without its marker. */
  sendLine(
    line: string,
    attachments: ReadonlyArray<ChatAttachment>,
    reply: { number: number; parent: string; text: string } | null = null
  ): void {
    const now = this.model;
    const isCommand = line.trim().startsWith('/');
    // A slash line goes alone: the images stay in the input for the message that follows it.
    const kept = isCommand
      ? attachments.reduce(attachToDraft, draftFromText(this.nextId('d'), '', 0))
      : draftFromText(this.nextId('d'), '', 0);
    this.update({
      draft: kept,
      past: [],
      future: [],
      selected: 0,
      browsing: null,
      held: null,
      notice: null,
    });
    if (line.trim() === '' && attachments.length === 0) return;
    if (/^\/attach(\s|$)/.test(line.trim())) {
      this.runAttach(line.trim().slice('/attach'.length).trim());
      return;
    }
    const sent = isCommand ? [] : attachments;
    if (line.trim() !== '') {
      const history = submit(insert(emptyInput(now.history), line), { secret: false }).next.history;
      this.recalled.set(line, sent);
      this.update({ history });
      this.env.saveHistory(history, { text: line, attachments: sent });
    }
    if (line.trim() === '/clear') {
      this.update({ entries: [], view: TAIL, expanded: new Set() });
      return;
    }
    if (isCommand) {
      this.runCommand(line);
      return;
    }
    // A chat line goes to her alone: it asks for no panel and replaces no command's request.
    this.update({ view: TAIL });
    if (reply === null) {
      this.addEntry({ who: 'owner', text: line, attachments: sent });
      void this.env.send(line, sent);
      return;
    }
    this.addEntry({ who: 'owner', text: reply.text, attachments: sent, replyTo: reply.number });
    void this.env.send(reply.text, sent, reply.parent);
  }

  /**
   * A slash line: the command window opens with the line and its time, and the answer joins it there, as text or as a
   * live panel. The older request's answer is dropped whatever it is, and nothing of a command reaches the chat.
   */
  runCommand(line: string): void {
    const typed = line.trim();
    this.panelRequest += 1;
    const request = this.panelRequest;
    const result: CommandResult = { id: this.nextId('c'), line: typed, at: this.env.now(), answer: null };
    if (this.panelLoading && this.loadingResult !== null)
      this.answerResult(this.loadingResult, 'Cancelled.', { reopens: false });
    this.panelLoading = true;
    this.loadingResult = result.id;
    this.update({
      results: [...this.model.results, result],
      isWindowOpen: true,
      windowView: TAIL,
      panel: null,
      selection: null,
    });
    const failed = (error: unknown): void =>
      this.answerResult(result.id, error instanceof Error ? error.message : 'The command failed.');
    void this.env
      .panelOf(typed)
      .then((opened) => {
        if (request !== this.panelRequest) return;
        this.panelLoading = false;
        this.loadingResult = null;
        if (opened === null) {
          const answer = this.env.send(line, []);
          if (answer === undefined) this.answerResult(result.id, '');
          else void answer.then((text) => this.answerResult(result.id, text), failed);
        } else if (opened.rows === undefined && opened.picker === undefined)
          this.answerResult(result.id, opened.lines.join('\n'));
        else {
          this.answerResult(result.id, [opened.title, ...opened.lines].join('\n'));
          this.update({ panel: opened });
        }
      })
      .catch((error: unknown) => {
        this.panelLoading = false;
        this.loadingResult = null;
        failed(error);
      });
  }

  say = (text: string): void => this.addEntry({ who: 'system', text });

  /** A staged image for the draft it was asked for: a draft sent or cleared meanwhile gets nothing, and the staging is freed. */
  attachStaged(draftId: string, result: StageResult, source: string): void {
    if (!result.ok) {
      this.update({ notice: `${source} was not attached: ${STAGE_REFUSALS[result.code] ?? result.code}.` });
      return;
    }
    if (this.draftId() !== draftId) {
      this.releaseImage(result.staged.id);
      return;
    }
    this.update({ draft: attachToDraft(this.model.draft, result.staged), notice: null });
  }

  /**
   * `/attach <file>`, `/attach open`, `/attach save <file>`, `/attach open #N [k]` and `/attach save #N [k] [dir]`:
   * handled here, so a path never reaches the core as text.
   */
  runAttach(argument: string): void {
    const numbered = /^(open|save)\s+#(\d+)(?:\s+(\d+))?(?:\s+(.+))?$/.exec(argument);
    if (numbered !== null && (numbered[1] === 'save' || numbered[4] === undefined)) {
      const [, verb = 'open', line = '0', index, directory] = numbered;
      this.runLineFile(verb === 'save', Number(line), index === undefined ? null : Number(index), directory ?? '.');
      return;
    }
    if (/^(open|save)\s+#/.test(argument)) {
      this.update({ notice: 'Usage: /attach open #N [file number] or /attach save #N [file number] [dir]' });
      return;
    }
    if (argument === 'open' || argument === 'save' || argument.startsWith('save ')) {
      this.runReceived(argument);
      return;
    }
    const { images } = this.env;
    if (images === undefined || argument === '') {
      this.update({
        notice: images === undefined ? 'Images are not available in this chat.' : 'Usage: /attach <file>',
      });
      return;
    }
    const file = argument.replace(/^(['"])(.*)\1$/, '$2');
    const draftId = this.draftId();
    void images
      .stageFile(file)
      .then((result) => this.attachStaged(draftId, result, file))
      .catch(() => this.update({ notice: `${file} was not attached.` }));
  }

  /** Shows or saves the newest image she sent. A failed save says so, and the same command tries again. */
  runReceived(argument: string): void {
    const image = this.entries()
      .flatMap((one) => (one.who === 'her' ? one.attachments : []))
      .at(-1);
    const { received } = this.env;
    if (received === undefined || image === undefined) {
      this.update({ notice: 'No received image to act on.' });
      return;
    }
    if (argument === 'open') {
      const id = this.openResult('/attach open');
      const read = (maxBytes: number): Promise<KeptRead | null> =>
        received
          .bytesOf(image)
          .then((bytes) =>
            bytes === null ? null : { size: bytes.length, bytes: bytes.length <= maxBytes ? bytes : null }
          );
      this.showFile(id, { name: image.name, kind: 'image', description: image.alt ?? null }, read, null);
      return;
    }
    const destination = argument.slice('save'.length).trim();
    if (destination === '') {
      this.update({ notice: 'Usage: /attach save <file>' });
      return;
    }
    void received.save(image, destination).then((done) => {
      if (done.status === 'failed') this.update({ notice: `${image.name}: ${done.reason}.` });
      else this.update({ notice: `Saved ${image.name} to ${done.file}.` });
    });
  }

  /** A result of `line` in the command window, opened at its tail, its answer to come. */
  openResult(line: string): string {
    const result: CommandResult = { id: this.nextId('c'), line, at: this.env.now(), answer: null };
    this.update({
      results: [...this.model.results, result],
      isWindowOpen: true,
      windowView: TAIL,
      panel: null,
      selection: null,
    });
    return result.id;
  }

  /** The number the next kitty image takes, apart from the 31 of the terminal query. */
  kittyIds = 100;

  /** Shows `file` in the result `id`: a picture through the terminal, a text file's content, or why it cannot. */
  showFile(
    id: string,
    file: ViewedFile,
    read: (maxBytes: number) => Promise<KeptRead | null>,
    path: string | null
  ): void {
    const { graphics = noGraphics } = this.deps;
    this.kittyIds += 1;
    viewFile(file, { read, path, graphics, kittyId: this.kittyIds })
      .then(({ answer, graphic }) => {
        const { results } = this.model;
        this.update({
          results: results.map((one) =>
            one.id === id
              ? { ...one, answer, finishedAt: this.env.now(), ...(graphic === null ? {} : { graphic }) }
              : one
          ),
        });
      })
      .catch(() => this.answerResult(id, `${file.name} could not be shown.`));
  }

  /**
   * Shows or saves a file of the stored line with that number. A line with several files and no `index` lists them
   * numbered from 1 instead.
   */
  runLineFile(save: boolean, number: number, index: number | null, directory: string): void {
    const { lineFiles, received } = this.env;
    if (lineFiles === undefined || received === undefined) {
      this.update({ notice: 'The files of a line are not available in this chat.' });
      return;
    }
    const command = `/attach ${save ? 'save' : 'open'} #${number}`;
    const id = save ? null : this.openResult(index === null ? command : `${command} ${index}`);
    const say = (text: string): void => {
      if (id === null) this.update({ notice: text });
      else this.answerResult(id, text);
    };
    lineFiles(number)
      .then((answer) => {
        if (!answer.ok) return say(answer.reason);
        const { files } = answer;
        if (files.length === 0) return say(`Line #${number} holds no file.`);
        if (index === null && files.length > 1) {
          const rows = files.map((file, at) => `${at + 1}. ${file.name} (${file.kind})`);
          return say([`Line #${number} holds ${files.length} files:`, ...rows, `${command} <n> takes one.`].join('\n'));
        }
        const file = files[(index ?? 1) - 1];
        if (file === undefined) return say(`Line #${number} holds no file ${index}.`);
        const { path } = file;
        if (path === null) return say(`${file.name} was not kept, so it cannot be shown or saved.`);
        if (id !== null) return this.showFile(id, file, (maxBytes) => received.readKept(path, maxBytes), path);
        return received.saveFile(path, directory, file.name).then((done) => {
          if (done.status === 'saved') say(`Saved ${file.name} to ${done.file}.`);
          else say(`${file.name} was not saved: ${done.reason}.`);
        });
      })
      .catch(() => say(`The files of line #${number} could not be read.`));
  }

  /** Ctrl+V: a picture from this machine's clipboard. A read that ends after the draft changed hands attaches nothing. */
  pasteImage(): void {
    const { images } = this.env;
    if (images === undefined) {
      this.update({ notice: 'Images are not available in this chat.' });
      return;
    }
    const draftId = this.draftId();
    void images
      .clipboard()
      .then(async (read) => {
        if (this.draftId() !== draftId) return;
        if (read.status === 'image')
          this.attachStaged(
            draftId,
            await images.stageBytes(read.bytes, { name: 'clipboard.png' }),
            'The clipboard image'
          );
        else if (read.status === 'empty') this.update({ notice: 'The clipboard holds no image.' });
        else this.update({ notice: `No clipboard image: ${read.reason}. /attach <file> takes a file.` });
      })
      .catch(() => this.update({ notice: 'The clipboard could not be read. /attach <file> takes a file.' }));
  }

  /** Up and Down over the history. Past the newest row the draft that browsing set aside comes back. */
  browseHistory(delta: -1 | 1): void {
    const now = this.model;
    const moved = browse({ ...emptyInput(now.history), browsing: now.browsing }, delta);
    if (moved.browsing === null) {
      if (now.browsing !== null)
        this.update({ draft: now.held ?? draftFromText(this.nextId('d'), '', 0), browsing: null, held: null });
      return;
    }
    if (moved.browsing === now.browsing) return;
    this.update({
      draft: draftFromHistory(this.nextId('d'), moved.text, this.recalled.get(moved.text) ?? [], this.limits()),
      browsing: moved.browsing,
      held: now.browsing === null ? now.draft : now.held,
    });
  }

  /** Up and Down: a row inside a multiline draft, and the history from its first and last row or while browsing. */
  rowOrHistory(delta: -1 | 1): void {
    const now = this.model;
    const { safe, width } = this.drawnInput;
    const caret = caretCell(safe, now.draft.cursor, width);
    const rowCount = wrapCells(safe, width).length;
    const target = caret.row + delta;
    if (now.browsing !== null || target < 0 || target >= rowCount) this.browseHistory(delta);
    else this.placeDraftCaret(caretFromCell(safe, { row: target, col: caret.col }, width));
  }

  /** A caret that moved ends the word being typed, so the next letter starts its own undo step. */
  placeDraftCaret(offset: number): void {
    this.update({ draft: placeCaret(this.model.draft, offset), isTypingWord: false, draftSelection: null });
  }

  /** The caret to the start or the end of its row. */
  rowEdge(edge: 'start' | 'end'): void {
    const now = this.model;
    const { safe, width } = this.drawnInput;
    const row = wrapCells(safe, width)[caretCell(safe, now.draft.cursor, width).row];
    if (row !== undefined) this.placeDraftCaret(edge === 'start' ? row.start : row.end);
  }

  editDraft(edited: Draft): void {
    // A reply marker typed or pasted at the start becomes one chip as soon as the blank after it is typed.
    const draft = markReply(edited);
    this.update({
      ...edits(applyEdit(this.model, draft)),
      isTypingWord: false,
      browsing: null,
      held: null,
      selected: 0,
      notice: null,
      draftSelection: null,
    });
  }

  /** Text that is not a key. A chunk that is not a bracketed paste stays text, whatever it holds: only a paste can collapse. */
  typed(text: string): void {
    const now = this.model;
    const plain = text.replaceAll('\r', '\n');
    if (now.question !== null) this.update({ answer: insert(now.answer, plain) });
    else if (now.search !== null) this.moveSearch({ ...now.search, query: now.search.query + plain, skip: 0 });
    else {
      const draft = typeIntoDraft(now.draft, plain);
      const isLetter = graphemes(plain).length === 1 && !/\s/.test(plain);
      this.editDraft(draft);
      // The letters of one word are one undo step; a space or a whole chunk starts the next.
      if (isLetter && now.isTypingWord) this.update(edits(coalesceEdit(now, draft)));
      this.update({ isTypingWord: isLetter });
    }
  }

  /** The entries as they arrived: a search and a jump read these, never the drawn marks. */
  originals = (): Array<{ id: string; who: string; text: string }> =>
    this.entries().map((one) => ({ id: one.id, who: one.who, text: one.original }));

  /** A new query or step of the search. A match in the transcript comes on the screen at once. */
  moveSearch(search: Search): void {
    if (search.kind === 'history') {
      this.update({ search });
      return;
    }
    const match = searchTranscript(this.originals(), search.query).at(-1 - search.skip);
    const view: TranscriptView =
      match === undefined ? search.viewBefore : { kind: 'anchor', entryId: match.entryId, row: 0 };
    this.update({ search, view });
  }

  acceptSearch(search: Search): void {
    const now = this.model;
    const match = search.kind === 'history' ? searchHistory(now.history, search.query, search.skip) : null;
    if (match === null) {
      this.update({ search: null });
      return;
    }
    const attachments = this.recalled.get(match.text) ?? [];
    this.update({
      ...edits(applyEdit(now, draftFromHistory(this.nextId('d'), match.text, attachments, this.limits()))),
      search: null,
    });
  }

  /** Ctrl+O: the newest entry on the screen that folds or is expanded changes alone. */
  toggleFold(): void {
    const now = this.model;
    const shownRows = transcriptWindow(this.shownEntries(), now.view, this.drawn).rows;
    const target = shownRows.toReversed().find((row) => row.kind === 'fold' || now.expanded.has(row.entryId));
    if (target === undefined) return;
    const expanded = new Set(now.expanded);
    if (!expanded.delete(target.entryId)) expanded.add(target.entryId);
    this.update({ expanded });
  }

  moveMenu(delta: -1 | 1): void {
    const now = this.model;
    const last = this.itemsOf(now).length - 1;
    this.update({ selected: Math.max(0, Math.min(last, now.selected + delta)) });
  }

  /** Undo and redo cannot bring back an image whose staged bytes went when its chip was removed. */
  withoutFreed(state: EditorState): EditorState {
    const { parts } = state.draft;
    const gone = parts.filter((part) => part.kind === 'attachment' && this.freed.has(part.id));
    const draft = gone.reduce((held, part) => removePart(held, part.id), state.draft);
    return { ...state, draft };
  }

  /** A chip Backspace, Delete or Esc took: an image's staged bytes go with it. */
  afterRemoval(removed: DraftPart | null): void {
    if (removed?.kind !== 'attachment') return;
    this.freed.add(removed.id);
    this.releaseImage(removed.attachment.id);
  }

  /** Ctrl+G: the terminal goes to the editor, and the draft waits. The answer changes the draft only if it is still the same. */
  openEditor(): void {
    const { editDraft: edit } = this.env;
    const now = this.model;
    const assembled = assembleDraft(now.draft);
    if (edit === undefined || !assembled.ok) {
      this.update({
        notice: edit === undefined ? 'No external editor here.' : 'A pasted text is gone, so the draft stays.',
      });
      return;
    }
    const draftId = now.draft.id;
    void this.suspendTerminal(async () => {
      const result = await edit(assembled.text);
      const held = this.model;
      if (result.status === 'failed') this.update({ notice: 'The editor failed, and the draft stays as it was.' });
      else if (result.status === 'edited' && held.draft.id === draftId)
        this.editDraft(replaceDraftText(held.draft, result.text));
    });
  }

  /** The draft's offset under a report, its row clamped to the drawn rows of the input. */
  draftOffsetAt(report: MouseReport): number {
    const { safe, width, first, firstRow, rowCount } = this.drawnInput;
    const row = Math.max(0, Math.min(rowCount - 1, report.row - firstRow));
    const col = Math.max(0, report.column - DRAFT_FIRST_COLUMN);
    return caretFromCell(safe, { row: first + row, col }, width);
  }

  /** Where a click lands in the draft, or nothing outside its rows. A drag from there selects in the draft alone. */
  clickInDraft(report: MouseReport): void {
    const { firstRow, rowCount } = this.drawnInput;
    const row = report.row - firstRow;
    if (row < 0 || row >= rowCount || this.model.search !== null) return;
    const offset = this.draftOffsetAt(report);
    this.placeDraftCaret(offset);
    this.draftDrag = offset;
  }

  /**
   * The drag of a selection in the draft: both the cell where it went down and the cell under the pointer are selected,
   * whichever way it went, and the caret stands after the selection.
   */
  dragInDraft(report: MouseReport, anchor: number): void {
    const { safe } = this.drawnInput;
    const focus = this.draftOffsetAt(report);
    if (focus === anchor) {
      this.update({ draftSelection: null });
      return;
    }
    const last = Math.max(anchor, focus);
    const to = last + (graphemes(safe.slice(last))[0]?.length ?? 0);
    const from = Math.min(anchor, focus);
    this.update({ draft: placeCaret(this.model.draft, to), draftSelection: { from, to }, isTypingWord: false });
  }

  /** The area a screen row belongs to: the command window's rows and rule, else the chat. */
  areaAt(row: number): Area {
    const { first, last } = this.drawnWindow;
    return this.model.isWindowOpen && row >= first && row <= last ? 'window' : 'chat';
  }

  /** The rows of an area as last drawn and the screen row of the first. */
  drawnIn(area: Area): { top: number; rows: ReadonlyArray<TranscriptRow> } {
    return area === 'chat' ? this.drawnRows : this.drawnWindow;
  }

  /** The cell of an area under a report, clamped to its drawn rows; null off them unless `clamp` asks for the nearest. */
  cellIn(area: Area, report: MouseReport, clamp: boolean): TranscriptCell | null {
    const { top, rows } = this.drawnIn(area);
    const row = report.row - top;
    if (rows.length === 0 || (!clamp && (row < 0 || row >= rows.length))) return null;
    return { row: Math.max(0, Math.min(rows.length - 1, row)), col: Math.max(0, report.column - 1) };
  }

  /** Puts the text on the terminal's clipboard and says so on the notice row. */
  copySelection(text: string): void {
    this.copy(text);
    this.update({ selection: null, notice: `copied ${graphemes(text).length} chars to clipboard` });
  }

  /** The left button down: the caret in the input, or the start of a selection in the chat or the command window. */
  pressAt(report: MouseReport): void {
    const { firstRow, rowCount } = this.drawnInput;
    const isInDraft = report.row >= firstRow && report.row < firstRow + rowCount;
    const area = this.areaAt(report.row);
    const cell = isInDraft ? null : this.cellIn(area, report, false);
    this.draftDrag = null;
    this.update({
      selection: cell === null ? null : { area, anchor: cell, focus: cell, dragging: true, text: '' },
      draftSelection: null,
    });
    // A live panel holds the keys, so a click leaves the caret of the input where it is.
    if (isInDraft && focusOwner(this.model) === 'input') this.clickInDraft(report);
  }

  /** The button up: a drag copies what it covers, and a click without one leaves nothing selected. */
  releaseAt(report: MouseReport): void {
    this.draftDrag = null;
    const { selection } = this.model;
    if (selection?.dragging !== true) return;
    const focus = this.cellIn(selection.area, report, true) ?? selection.focus;
    const isClick = focus.row === selection.anchor.row && focus.col === selection.anchor.col;
    const ended = { ...selection, focus, dragging: false };
    if (isClick && selection.area === 'chat') this.clickNumber(focus);
    const text = isClick ? '' : selectedText(ended, this.drawnIn(selection.area).rows);
    if (text === '') {
      this.update({ selection: null });
      return;
    }
    this.copySelection(text);
    // The selection stays lit until the next key, click or scroll, and Ctrl+C copies it again.
    this.update({ selection: { ...ended, text } });
  }

  /** A click on the grey `[#N]` of a line of the owner or of hers: the next message replies to line N. */
  clickNumber(cell: TranscriptCell): void {
    const { rows } = this.drawnRows;
    const row = rows[cell.row];
    if (row?.lead === undefined) return;
    const who = this.whoOf(row.entryId);
    const found = /^\[#(\d+)\]/.exec(row.text);
    if ((who !== 'owner' && who !== 'her') || found === null || cell.col >= found[0].length) return;
    if (focusOwner(this.model) === 'input') this.editDraft(setReply(this.model.draft, Number(found[1])));
  }

  /** A wheel notch: the command window under the pointer scrolls alone, else the slash menu moves or the chat scrolls. */
  wheel(report: MouseReport, delta: -1 | 1): void {
    const now = this.model;
    if (this.areaAt(report.row) === 'window') {
      const entries = resultEntries(now.results, this.env.timeZone);
      const windowView = scrollView(entries, now.windowView, delta * WHEEL_ROWS, this.drawnWindow.dims);
      this.update({ selection: null, windowView });
    } else if (this.itemsOf(now).length > 0) this.moveMenu(delta);
    else
      this.update({ selection: null, view: scrollView(this.shownEntries(), now.view, delta * WHEEL_ROWS, this.drawn) });
  }

  onMouse(report: MouseReport): void {
    const now = this.model;
    // A live panel in the command window keeps its keys, and the mouse still scrolls and selects around it.
    if (focusOwner(now) === 'choices' || now.question !== null) return;
    const isLeft = report.button === 0;
    if (report.kind === 'press' && isLeft) this.pressAt(report);
    else if (report.kind === 'drag' && isLeft && this.draftDrag !== null) this.dragInDraft(report, this.draftDrag);
    else if (report.kind === 'drag' && isLeft) {
      const { selection } = now;
      const cell = selection?.dragging === true ? this.cellIn(selection.area, report, true) : null;
      if (selection !== null && cell !== null) this.update({ selection: { ...selection, focus: cell } });
    } else if (report.kind === 'release') this.releaseAt(report);
    else if (report.kind === 'wheel-up' || report.kind === 'wheel-down')
      this.wheel(report, report.kind === 'wheel-up' ? -1 : 1);
  }

  contextOf = (now: Model): FocusContext => {
    if (now.question !== null) return 'secret';
    if (now.search !== null) return 'search';
    if (this.itemsOf(now).length > 0) return 'menu';
    return chipBeforeCaret(now.draft) === null ? 'composer' : 'attachment';
  };

  // health: allow function-length until 2027-04-01 -- one switch over every key action of the chat, split would hide the table
  // health: allow complexity until 2027-04-01 -- one table of the keys of the chat, and split up it would hide which key does what
  run(action: KeyAction): void {
    const now = this.model;
    switch (action) {
      case 'chat.leave':
        if (displayDraft(now.draft) === '') this.exit();
        return;
      case 'composer.submit':
      case 'menu.accept':
      case 'question.submit':
        this.send();
        return;
      case 'composer.newline':
        this.typed('\n');
        return;
      case 'composer.clear':
        // The open command window goes first, and the draft waits for the next Esc.
        if (now.isWindowOpen) {
          this.closeWindow();
          return;
        }
        // A reply target goes next, and the draft stays for the message without it.
        if (replyOf(now.draft) !== null) {
          this.editDraft(dropReply(now.draft));
          return;
        }
        if (displayDraft(now.draft) === '' && !this.panelLoading) this.cancelRunningTurn();
        // The panel still on its way opens nothing now.
        this.panelLoading = false;
        this.panelRequest += 1;
        for (const part of now.draft.parts) this.afterRemoval(part);
        this.editDraft(draftFromText(this.nextId('d'), '', 0));
        return;
      case 'composer.backspace':
      case 'composer.delete': {
        const edit = action === 'composer.backspace' ? backspaceInDraft(now.draft) : deleteInDraft(now.draft);
        this.editDraft(edit.draft);
        this.afterRemoval(edit.removed);
        return;
      }
      case 'cursor.left':
        this.update({ draft: moveInDraft(now.draft, -1), isTypingWord: false });
        return;
      case 'cursor.right':
        this.update({ draft: moveInDraft(now.draft, 1), isTypingWord: false });
        return;
      case 'draft.selectAll': {
        const length = displayDraft(now.draft).length;
        if (now.search === null && length > 0)
          this.update({ draft: placeCaret(now.draft, length), draftSelection: { from: 0, to: length } });
        return;
      }
      case 'cursor.home':
        this.rowEdge('start');
        return;
      case 'cursor.end':
        this.rowEdge('end');
        return;
      case 'history.previous':
        this.rowOrHistory(-1);
        return;
      case 'history.next':
        this.rowOrHistory(1);
        return;
      case 'history.search':
        this.update({ search: { kind: 'history', query: '', skip: 0, viewBefore: now.view } });
        return;
      case 'transcript.search':
        this.update({ search: { kind: 'transcript', query: '', skip: 0, viewBefore: now.view } });
        return;
      case 'transcript.expand':
        this.toggleFold();
        return;
      case 'transcript.pageUp':
      case 'transcript.pageDown': {
        // At the top of what is drawn, Page Up asks the store for the page before it.
        if (
          action === 'transcript.pageUp' &&
          transcriptWindow(this.shownEntries(), now.view, this.drawn).hiddenAbove === 0
        )
          this.loadStoredPage();
        const page = Math.max(1, this.drawn.budget - 1);
        const delta = action === 'transcript.pageUp' ? -page : page;
        this.update({ view: scrollView(this.shownEntries(), now.view, delta, this.drawn) });
        return;
      }
      case 'prompt.previous':
      case 'prompt.next': {
        const rows = transcriptWindow(this.shownEntries(), now.view, this.drawn).rows;
        const top =
          rows.find((row) => !row.entryId.startsWith(GAP_PREFIX) && !row.entryId.startsWith(TIME_PREFIX))?.entryId ??
          '';
        const entryId = jumpToPrompt(this.originals(), top, action === 'prompt.previous' ? -1 : 1);
        if (entryId !== null) this.update({ view: { kind: 'anchor', entryId, row: 0 } });
        return;
      }
      case 'edit.undo':
        this.update({ ...edits(this.withoutFreed(undo(now))), isTypingWord: false, selected: 0 });
        return;
      case 'edit.redo':
        this.update({ ...edits(this.withoutFreed(redo(now))), isTypingWord: false, selected: 0 });
        return;
      case 'draft.stash':
        this.update(edits(displayDraft(now.draft) === '' ? popStash(now) : stashDraft(now, this.nextId('d'))));
        return;
      case 'editor.external':
        this.openEditor();
        return;
      case 'image.paste':
        this.pasteImage();
        return;
      case 'menu.complete': {
        const item = this.itemsOf(now)[now.selected];
        if (item !== undefined) this.completeCommand(item);
        return;
      }
      case 'menu.previous':
        this.moveMenu(-1);
        return;
      case 'menu.next':
        this.moveMenu(1);
        return;
      case 'search.accept':
        if (now.search !== null) this.acceptSearch(now.search);
        return;
      case 'search.cancel':
        this.update({ search: null, view: now.search?.viewBefore ?? now.view });
        return;
      case 'search.next':
        if (now.search !== null) this.moveSearch({ ...now.search, skip: now.search.skip + 1 });
        return;
      case 'search.backspace':
        if (now.search !== null)
          this.moveSearch({ ...now.search, query: graphemes(now.search.query).slice(0, -1).join(''), skip: 0 });
        return;
      case 'question.cancel':
        now.question?.answer('');
        this.endQuestion();
        return;
      case 'question.left':
        this.update({ answer: moveCursor(now.answer, -1) });
        return;
      case 'question.right':
        this.update({ answer: moveCursor(now.answer, 1) });
        return;
      case 'question.backspace':
        this.update({ answer: backspace(now.answer) });
        return;
      case 'composer.paste':
      case 'search.paste':
      case 'question.paste':
      case 'panel.activate':
      case 'panel.close':
      case 'panel.paste':
        // The paste channel and an open panel take these themselves: no key of this handler reaches them.
        return;
    }
  }
}
