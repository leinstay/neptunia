// The chat's state and everything a key, a paste or a mouse report does to it, in one object that lives as long as the
// chat. The state is read and written synchronously, because several keys can arrive before the next render, and every
// change asks for a paint. Keys resolve through cli/keymap.ts and dispatch in `run`. `frame` measures what the next render
// draws, so the transcript gets exactly the rows the other parts leave. Keys and a paste have one owner at a time
// (`focusOwner`), and the answer of a panel that was replaced or closed opens nothing and runs nothing. Clearing the display
// touches nothing else, and leaving ends only this process. The commands and their answers come from the caller: this file
// knows no command's meaning but `/clear` and `/attach`. cli/app.ts draws it.
import type { Key } from 'ink';
import { alternativeText } from './attachment-actions.ts';
import type { AttachmentActions } from './attachment-actions.ts';
import { composerLayout, composerMaxRows, headerMode, headerRows, menuRows } from './chat-view.ts';
import type { ComposerLayout, HeaderMode } from './chat-view.ts';
import type { ClipboardResult } from './clipboard.ts';
import {
  DEFAULT_PASTE_LIMITS,
  assembleDraft,
  attachToDraft,
  backspaceInDraft,
  chipBeforeCaret,
  deleteInDraft,
  displayDraft,
  draftFromHistory,
  draftFromParts,
  draftFromText,
  inspectPart,
  moveInDraft,
  pasteIntoDraft,
  placeCaret,
  removePart,
  replaceDraftText,
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
import { buildKeymap, keyHints, keyNameOf } from './keymap.ts';
import type { FocusContext, KeyAction, KeyBinding, Keymap } from './keymap.ts';
import { caretCell, graphemes, transcriptBudget, wrapCells, wrapWords } from './layout.ts';
import { caretFromCell } from './mouse.ts';
import type { MouseReport } from './mouse.ts';
import type { Panel } from './panel.ts';
import { FOLD_LINES, backspace, browse, emptyInput, insert, menuOf, moveCursor, statusLine, submit } from './state.ts';
import type { InputState, MenuCommand, StatusBrief } from './state.ts';
import { TAIL, displaySafe, scrollView, transcriptWindow } from './transcript.ts';
import type { TranscriptDims, TranscriptView, TranscriptWindow } from './transcript.ts';
import { activeTurn, emptyTurns, queuedTurns, reduceTurns, requestCancel, turnOf } from './turn-state.ts';
import type { ClientTurnEvent, TurnsState } from './turn-state.ts';

export type ChatEntry = {
  who: 'owner' | 'her' | 'system';
  text: string;
  attachments?: ReadonlyArray<ChatAttachment>;
};
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
  /** One line typed: a command or a chat line, with its staged images. The answer, when it is text for the chat, comes through `onEntry`. */
  send: (line: string, attachments?: ReadonlyArray<ChatAttachment>) => void;
  /** Asks the core to cancel a turn. Clearing a draft or leaving the chat never reaches this. */
  cancelTurn?: (turnId: string) => void;
  /** The text of a panel a command opens, or null when this line opens none. */
  panelOf: (line: string) => Promise<Panel | null>;
  /** Registers the listeners of what arrives from the core. */
  subscribe: (listeners: {
    entry: (entry: ChatEntry) => void;
    question: (question: Question) => void;
    connected: (connected: boolean) => void;
    /** What the core says of the turns (cli/turn-state.ts). */
    turn: (event: ClientTurnEvent) => void;
    /** Another core answers now: the turns the last one held are gone. */
    coreRestarted: () => void;
    /** The transcript as a resumed or branched chat shows it, in place of what is on the screen. */
    view: (entries: ReadonlyArray<ChatEntry>) => void;
  }) => void;
  status: () => Promise<StatusBrief | null>;
  /** The history after a submit, newest first, and the draft that was added to it. */
  saveHistory: (
    history: ReadonlyArray<string>,
    added?: { text: string; attachments: ReadonlyArray<ChatAttachment> }
  ) => void;
  now: () => number;
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
  /** Whether the terminal's mouse reports are taken (`cli.mouse`, cli/mouse.ts). */
  mouse?: boolean;
  /** The draft's text in the owner's editor, with the terminal handed over meanwhile. */
  editDraft?: (text: string) => Promise<{ status: 'edited' | 'cancelled' | 'failed'; text: string }>;
  /**
   * The stored lines of the command line's chat, oldest first: the newest page with `before` null, else the page that
   * ends just before the stored line `before`. Absent: the chat shows the lines of this process only.
   */
  storedPage?: (before: string | null) => Promise<ReadonlyArray<ChatEntry & { id: string }>>;
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
};

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
  panel: Panel | null;
  question: Question | null;
  /** what is typed for the open question: a buffer of its own, so an answer reaches neither the draft nor a store */
  answer: InputState;
  connected: boolean;
  brief: StatusBrief | null;
  polledAt: number | null;
  /** one row of feedback, gone with the next key */
  notice: string | null;
  /** until when Enter is swallowed, after a question closed */
  enterHeldUntil: number;
  /** what the core said of the turns */
  turns: TurnsState;
};

/** Who takes the keys and a paste now. A question goes first, because the core is waiting on it. */
export function focusOwner({ question, panel }: Pick<Model, 'question' | 'panel'>): 'choices' | 'input' | 'panel' {
  if (question !== null) return (question.choices?.length ?? 0) > 0 ? 'choices' : 'input';
  return panel === null ? 'input' : 'panel';
}

/** An entry's text and a row for each of its images, so a terminal that cannot draw one still says what it was. */
function entryText(entry: ChatEntry): string {
  const images = (entry.attachments ?? []).map((one) => `[image] ${alternativeText(one)}`);
  return (entry.text === '' ? images : [entry.text, ...images]).join('\n');
}

/**
 * What the transcript draws for an entry: a blank row and `> ` for the owner, `· ` for a command's answer and no mark for
 * her, so the kinds differ without colour, and every control character made visible.
 */
function drawnText(entry: ChatEntry): string {
  const lines = displaySafe(entryText(entry).replaceAll('\r\n', '\n')).split('\n');
  if (entry.who === 'her') return lines.join('\n');
  const mark = entry.who === 'owner' ? '> ' : '· ';
  const body = lines.map((line, index) => `${index === 0 ? mark : '  '}${line}`).join('\n');
  return entry.who === 'owner' ? `\n${body}` : body;
}

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

const FOOTER_ROWS = 1;
const WHEEL_ROWS = 3;
/** Where the draft's text starts inside the box: border, padding and the `> ` prompt, one-based for a mouse report. */
const DRAFT_FIRST_COLUMN = 5;
const COMPOSER_HINTS: ReadonlyArray<[KeyAction, string]> = [
  ['history.search', 'search'],
  ['draft.stash', 'stash'],
  ['editor.external', 'editor'],
  ['image.paste', 'image'],
  ['transcript.expand', 'expand'],
];
const CHIP_HINTS: ReadonlyArray<[KeyAction, string]> = [
  ['composer.backspace', 'remove'],
  ['part.inspect', 'show'],
  ['edit.undo', 'undo'],
];
const SEARCH_HINTS: ReadonlyArray<[KeyAction, string]> = [
  ['search.accept', 'take'],
  ['search.next', 'older'],
  ['search.cancel', 'leave'],
];

const FILTER_ROWS = 1;
const OFF_TAIL_ROWS = 1;

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
  /** the running turn and the queue on one row, or null with neither */
  turnRow: string | null;
  footer: string;
};

export class ChatController {
  readonly env: ChatEnv;
  readonly exit: () => void;
  readonly suspendTerminal: (work: () => Promise<void>) => Promise<void>;
  readonly paint: () => void;
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
  // The input as last drawn: what a row key and a click measure against.
  drawnInput = { safe: '', width: 1, first: 0, firstRow: 0, rowCount: 0 };
  // Set while a child closes itself on a key: the same key must not reach the composer that just got the focus back.
  keyTaken = false;
  // A panel request is on its way: Esc takes that back before it asks anything of the core.
  panelLoading = false;

  constructor(
    env: ChatEnv,
    { exit, suspendTerminal, paint }: Pick<ChatController, 'exit' | 'suspendTerminal' | 'paint'>
  ) {
    this.env = env;
    this.exit = exit;
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
      question: null,
      answer: emptyInput(),
      connected: true,
      brief: null,
      polledAt: null,
      notice:
        conflicts.length === 0
          ? null
          : conflicts.map((one) => `Key ${one.key} (${one.context}) not bound: ${one.reason}.`).join(' '),
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

  addEntry(entry: ChatEntry): void {
    const shown: ShownEntry = {
      id: this.nextId('e'),
      who: entry.who,
      text: drawnText(entry),
      original: entry.text,
      attachments: entry.attachments ?? [],
    };
    this.update({ entries: [...this.model.entries, shown] });
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
        }));
        this.update({ entries: [...shown, ...this.model.entries] });
      })
      .catch(() => {
        stored.loading = false;
        this.say('The stored lines of this chat could not be read.');
      });
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
    });
    this.loadStoredPage();
  }

  /** The core's word about a turn. A failure or a cancel leaves a line, and a streamed text shows until the end of its turn. */
  onTurnEvent(event: ClientTurnEvent): void {
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

  /** The row above the input: what runs, whether a cancel is on its way and how many lines wait. */
  turnRow(): string | null {
    const active = activeTurn(this.model.turns);
    const queued = queuedTurns(this.model.turns).length;
    const step = active?.progress.at(-1);
    const parts = [
      ...(active === null ? [] : [active.cancelRequested ? 'Cancelling her turn…' : 'Her turn is running']),
      ...(step === undefined ? [] : [`${step.name} ${step.detail}`]),
      ...(queued === 0 ? [] : [`${queued} queued`]),
    ];
    return parts.length === 0 ? null : parts.join(' · ');
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

  closePanel(): void {
    this.takeKey();
    this.update({ panel: null });
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
      this.exit();
      return;
    }
    if (renderedOwner !== 'input' || focusOwner(this.model) !== 'input' || this.keyTaken) return;
    // A held Enter can come as one chunk of returns, which Ink hands over as text.
    if (/^\r{2,}$/.test(text)) {
      for (let press = 0; press < text.length; press += 1) this.send();
      return;
    }
    if (this.model.notice !== null) this.update({ notice: null });
    const name = keyNameOf(text, key);
    const action = name === null ? null : this.keymap.resolve(this.contextOf(this.model), name);
    if (action !== null) this.run(action);
    else if (name === null && text !== '' && !key.meta) this.typed(text);
  }

  onPaste(payload: string): void {
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

  footer(hasChoices: boolean): string {
    if (this.model.question !== null)
      return hasChoices ? '↑↓ select · type to filter · Enter choose · Esc cancel' : 'Enter continue · Esc cancel';
    const context = this.contextOf(this.model);
    if (context === 'search') return keyHints(this.keymap, context, SEARCH_HINTS);
    if (context === 'attachment') return keyHints(this.keymap, context, CHIP_HINTS);
    return `/ commands · ${keyHints(this.keymap, context, COMPOSER_HINTS)}`;
  }

  /** The rows of everything on the next frame: the transcript gets `max(0, R - F - C - O)`, nothing is estimated. */
  frame(rows: number, columns: number): ChatFrame {
    const now = this.model;
    const { question: asked, panel, view, expanded, notice } = now;
    const owner = focusOwner(now);
    const isLinear = this.env.linear === true;
    const hasChoices = owner === 'choices';
    const items = this.itemsOf(now);
    // A panel takes the transcript's rows and the header's: it is what the owner opened it to read.
    const mode = panel === null ? headerMode(rows, columns, isLinear) : 'none';
    const questionRows = asked === null ? 0 : wrapWords(asked.question, columns).length;
    const turnRow = this.turnRow();
    const fixed =
      headerRows(mode) + FOOTER_ROWS + (notice === null ? 0 : 1) + (turnRow === null ? 0 : 1) + questionRows;
    const { shown, caretAt } = this.inputText();
    const layout = composerLayout(shown, caretAt, {
      columns,
      maxRows: composerMaxRows(rows, fixed, isLinear),
      isLinear,
    });
    const choiceRows = Math.min(QUESTION_ROWS, Math.max(1, rows - fixed - FILTER_ROWS));
    const inputRows = hasChoices ? choiceRows + FILTER_ROWS : layout.height;
    const menuHeight = panel === null && items.length > 0 ? menuRows(items.length, rows - fixed - inputRows - 1) : 0;
    const budget = transcriptBudget({ rows, fixed, composer: inputRows, overlay: panel === null ? menuHeight : rows });
    const isOffTail = view.kind === 'anchor' && budget > OFF_TAIL_ROWS;
    this.drawn = {
      columns,
      budget: isOffTail ? budget - OFF_TAIL_ROWS : budget,
      expanded,
      // A folded answer starts on the screen: the fold's own row and its lines fit what the terminal has left.
      foldLines: Math.max(1, Math.min(FOLD_LINES, budget - 1)),
    };
    this.drawnInput = {
      safe: layout.safe,
      width: layout.width,
      first: layout.first,
      // One-based, as a mouse report counts: above the footer and the box's lower border.
      firstRow: rows - FOOTER_ROWS - (isLinear ? 0 : 1) - layout.rows.length + 1,
      rowCount: layout.rows.length,
    };
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
      transcript: transcriptWindow(now.entries, view, this.drawn),
      status: statusLine(now.brief, { connected: now.connected, polledAt: now.polledAt, now: this.env.now() }),
      turnRow,
      footer: this.footer(hasChoices),
    };
  }

  /** The slash commands the menu offers. */
  commands(): ChatEnv['commands'] {
    const { commands } = this.env;
    return commands;
  }

  whoOf(entryId: string): ShownEntry['who'] | undefined {
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
    // A slash line goes alone: the images stay in the input for the message that follows it.
    const kept = isCommand
      ? attachments.reduce(attachToDraft, draftFromText(this.nextId('d'), '', 0))
      : draftFromText(this.nextId('d'), '', 0);
    this.update({ draft: kept, past: [], future: [], selected: 0, browsing: null, held: null, notice: null });
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
    this.update({ view: TAIL });
    this.addEntry({ who: 'owner', text: line, attachments: sent });
    // A chat line replaces no overlay; a command does, and the older request's answer is dropped whatever it is.
    if (isCommand) this.panelRequest += 1;
    const request = this.panelRequest;
    this.panelLoading = isCommand;
    void (line.trim() === '' ? Promise.resolve(null) : this.env.panelOf(line.trim()))
      .then((opened) => {
        if (request !== this.panelRequest) return;
        this.panelLoading = false;
        if (opened === null) this.env.send(line, sent);
        else this.update({ panel: opened });
      })
      .catch((error: unknown) => {
        this.panelLoading = false;
        this.say(error instanceof Error ? error.message : 'The command failed.');
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

  /** `/attach <file>`, `/attach open`, `/attach save <file>`: handled here, so a path never reaches the core as text. */
  runAttach(argument: string): void {
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

  /** Open or save the newest image she sent. A failed save says so, and the same command tries again. */
  runReceived(argument: string): void {
    const image = this.entries()
      .flatMap((one) => (one.who === 'her' ? one.attachments : []))
      .at(-1);
    const { received } = this.env;
    if (received === undefined || image === undefined) {
      this.update({ notice: 'No received image to act on.' });
      return;
    }
    const destination = argument.slice('save'.length).trim();
    if (argument.startsWith('save') && destination === '') {
      this.update({ notice: 'Usage: /attach save <file>' });
      return;
    }
    const outcome = argument === 'open' ? received.open(image) : received.save(image, destination);
    void outcome.then((done) => {
      if (done.status === 'failed') this.update({ notice: `${image.name}: ${done.reason}.` });
      else
        this.update({
          notice: done.status === 'saved' ? `Saved ${image.name} to ${done.file}.` : `Opened ${image.name}.`,
        });
    });
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
    this.update({ draft: placeCaret(this.model.draft, offset), isTypingWord: false });
  }

  /** The caret to the start or the end of its row. */
  rowEdge(edge: 'start' | 'end'): void {
    const now = this.model;
    const { safe, width } = this.drawnInput;
    const row = wrapCells(safe, width)[caretCell(safe, now.draft.cursor, width).row];
    if (row !== undefined) this.placeDraftCaret(edge === 'start' ? row.start : row.end);
  }

  editDraft(draft: Draft): void {
    this.update({
      ...edits(applyEdit(this.model, draft)),
      isTypingWord: false,
      browsing: null,
      held: null,
      selected: 0,
      notice: null,
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
    const shownRows = transcriptWindow(now.entries, now.view, this.drawn).rows;
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

  /** Where a click lands in the draft, or nothing outside its rows. */
  clickInDraft(report: MouseReport): void {
    const { safe, width, first, firstRow, rowCount } = this.drawnInput;
    const row = report.row - firstRow;
    if (row < 0 || row >= rowCount || this.model.search !== null) return;
    const col = Math.max(0, report.column - DRAFT_FIRST_COLUMN);
    this.placeDraftCaret(caretFromCell(safe, { row: first + row, col }, width));
  }

  onMouse(report: MouseReport): void {
    const now = this.model;
    if (focusOwner(now) !== 'input' || now.question !== null) return;
    if (report.kind === 'press' && report.button === 0) this.clickInDraft(report);
    else if (report.kind === 'wheel-up' || report.kind === 'wheel-down') {
      const delta = report.kind === 'wheel-up' ? -1 : 1;
      if (this.itemsOf(now).length > 0) this.moveMenu(delta);
      else this.update({ view: scrollView(now.entries, now.view, delta * WHEEL_ROWS, this.drawn) });
    }
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
        if (action === 'transcript.pageUp' && transcriptWindow(now.entries, now.view, this.drawn).hiddenAbove === 0)
          this.loadStoredPage();
        const page = Math.max(1, this.drawn.budget - 1);
        const delta = action === 'transcript.pageUp' ? -page : page;
        this.update({ view: scrollView(now.entries, now.view, delta, this.drawn) });
        return;
      }
      case 'prompt.previous':
      case 'prompt.next': {
        const top = transcriptWindow(now.entries, now.view, this.drawn).rows[0]?.entryId ?? '';
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
      case 'part.inspect': {
        const chip = chipBeforeCaret(now.draft);
        const inspected = chip === null ? null : inspectPart(now.draft, chip.id);
        if (inspected !== null) this.update({ panel: { title: 'Behind the chip', lines: inspected.split('\n') } });
        return;
      }
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
