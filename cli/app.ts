// The interactive chat's screen, written with `React.createElement`, so no build step appears: a header with the rotating
// galaxy and the status line, the conversation with long answers folded, the input with its slash menu, and panels over
// the chat for `/help`, `/status` and `/config` with a search, and the model selector for `/model`. The commands and their
// answers come from the caller, this file knows no command's meaning. A question the core asks replaces the input and
// keeps the draft it interrupted, a secret drawn as stars and kept out of the history, and a closed question is a selector
// over its choices. Keys and a paste have one owner at a time (`focusOwner`), and the answer of a panel that was replaced
// or closed opens nothing and runs nothing. Clearing the display touches nothing else, and leaving ends only this process.
// The state lives in one ref and is read and written synchronously, because several keys can arrive before the next
// render. cli/index.ts starts it.

import { createElement as h, useEffect, useReducer, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { Box, Text, useApp, useInput, usePaste, useStdout } from 'ink';
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
  replaceDraftText,
  typeIntoDraft,
} from './composer.ts';
import type { ChatAttachment, Draft, DraftPart, PasteLimits } from './composer.ts';
import { graphemes } from './layout.ts';
import { galaxyFrame } from './galaxy.ts';
import { alternativeText } from './attachment-actions.ts';
import type { AttachmentActions } from './attachment-actions.ts';
import type { ClipboardResult } from './clipboard.ts';
import { ModelPicker } from './model-picker.ts';
import { PanelView } from './panel-view.ts';
import type { Panel } from './panel.ts';
export type { Panel } from './panel.ts';
import { ChoiceSelector } from './selector.ts';
import { backspace, browse, emptyInput, foldedText, insert, menuOf, moveCursor, statusLine, submit } from './state.ts';
import type { InputState, MenuCommand, StatusBrief } from './state.ts';

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
  /** The text of a panel a command opens, or null when this line opens none. */
  panelOf: (line: string) => Promise<Panel | null>;
  /** Registers the listeners of what arrives from the core. */
  subscribe: (listeners: {
    entry: (entry: ChatEntry) => void;
    question: (question: Question) => void;
    connected: (connected: boolean) => void;
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
};

const GALAXY_MS = 200;
const POLL_MS = 15_000;
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

type Model = {
  entries: ReadonlyArray<ChatEntry>;
  draft: Draft;
  history: ReadonlyArray<string>;
  /** the history row on show, and the unfinished draft that browsing set aside */
  browsing: number | null;
  held: Draft | null;
  selected: number;
  expanded: boolean;
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
};

/** Who takes the keys and a paste now. A question goes first, because the core is waiting on it. */
function focusOwner({ question, panel }: Pick<Model, 'question' | 'panel'>): 'choices' | 'input' | 'panel' {
  if (question !== null) return (question.choices?.length ?? 0) > 0 ? 'choices' : 'input';
  return panel === null ? 'input' : 'panel';
}

/** The text of the caret's row as three pieces, the caret on a whole grapheme so a style never splits a character. */
function caretPieces(shown: string, cursor: number): { before: string; on: string; after: string } {
  const rest = graphemes(shown.slice(cursor));
  return { before: shown.slice(0, cursor), on: rest[0] ?? ' ', after: rest.slice(1).join('') };
}

function Header({ env, line }: { env: ChatEnv; line: string }) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (env.still) return undefined;
    const timer = setInterval(() => setTick((value) => value + 1), GALAXY_MS);
    return () => clearInterval(timer);
  }, [env.still]);
  return h(
    Box,
    { paddingX: 1, gap: 2, marginBottom: 1 },
    h(Text, { color: 'magenta' }, galaxyFrame(tick).join('\n')),
    h(
      Box,
      { flexDirection: 'column' },
      h(Text, { bold: true, color: 'cyan' }, env.title),
      h(Text, { wrap: 'wrap' }, line)
    )
  );
}

/** An entry's text and a row for each of its images, so a terminal that cannot draw one still says what it was. */
function entryText(entry: ChatEntry): string {
  const images = (entry.attachments ?? []).map((one) => `[image] ${alternativeText(one)}`);
  return (entry.text === '' ? images : [entry.text, ...images]).join('\n');
}

function Entry({ entry, expanded }: { entry: ChatEntry; expanded: boolean }) {
  const folded = foldedText(entryText(entry), expanded);
  const mark = entry.who === 'owner' ? '> ' : '';
  return h(
    Box,
    { flexDirection: 'column' },
    h(Text, { dimColor: entry.who === 'system' }, `${mark}${folded.text}`),
    folded.hidden > 0 ? h(Text, { dimColor: true }, `… ${folded.hidden} more lines, ctrl+o shows them`) : null
  );
}

function Menu({ items, selected }: { items: ReadonlyArray<MenuCommand>; selected: number }) {
  return h(
    Box,
    { flexDirection: 'column' },
    ...items
      .slice(Math.max(0, selected - 7), Math.max(0, selected - 7) + 8)
      .map((item, index) =>
        h(
          Text,
          { key: item.name, inverse: index + Math.max(0, selected - 7) === selected },
          `/${item.name}  `,
          h(Text, { dimColor: index + Math.max(0, selected - 7) !== selected }, item.help)
        )
      )
  );
}

export function ChatApp({ env }: { env: ChatEnv }): ReactElement {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [rows, setRows] = useState<number>((stdout as { rows?: number }).rows || 24);
  useEffect(() => {
    const resize = (): void => setRows((stdout as { rows?: number }).rows || 24);
    stdout.on('resize', resize);
    return () => {
      stdout.off('resize', resize);
    };
  }, [stdout]);
  const serial = useRef(0);
  const nextId = (prefix: string): string => `${prefix}${(serial.current += 1)}`;
  const limits = (): PasteLimits => env.composer ?? DEFAULT_PASTE_LIMITS;
  const model = useRef<Model>({
    entries: [],
    draft:
      env.initialParts === undefined
        ? draftFromText('d0', env.initialInput ?? '', env.initialInput?.length ?? 0)
        : draftFromParts('d0', env.initialParts),
    history: env.history,
    browsing: null,
    held: null,
    selected: 0,
    expanded: false,
    panel: null,
    question: null,
    answer: emptyInput(),
    connected: true,
    brief: null,
    polledAt: null,
    notice: null,
    enterHeldUntil: 0,
  });
  const [, paint] = useReducer((tick: number) => tick + 1, 0);
  const update = (change: Partial<Model>): void => {
    model.current = { ...model.current, ...change };
    paint();
  };
  const subscribed = useRef(false);
  // Counts the panel requests: an answer that is not of the newest one belongs to an overlay the owner left.
  const panelRequest = useRef(0);
  const recalled = useRef(new Map(env.recalled ?? []));
  // Set while a child closes itself on a key: the same key must not reach the composer that just got the focus back.
  const keyTaken = useRef(false);
  const takeKey = (): void => {
    keyTaken.current = true;
    queueMicrotask(() => {
      keyTaken.current = false;
    });
  };

  useEffect(() => {
    if (subscribed.current) return;
    subscribed.current = true;
    env.subscribe({
      entry: (entry) => update({ entries: [...model.current.entries, entry] }),
      question: (asked) => {
        // Only one question fits the screen: the older command gets the empty answer of a cancelled one.
        model.current.question?.answer('');
        update({ question: asked, answer: emptyInput() });
      },
      connected: (now) => update({ connected: now }),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `update` only writes the ref and asks for a paint
  }, [env]);

  // A read of what the core already knows: no probe and no provider call for the display.
  useEffect(() => {
    const poll = (): void => {
      void env
        .status()
        .then((answer) => {
          if (answer !== null) update({ brief: answer, polledAt: env.now() });
        })
        .catch(() => {});
    };
    poll();
    const timer = setInterval(poll, POLL_MS);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `update` only writes the ref and asks for a paint
  }, [env]);

  const itemsOf = (now: Model): Array<MenuCommand> =>
    now.question === null ? menuOf(displayDraft(now.draft), env.commands) : [];

  /** Closes the question. Its draft waits in the composer, and a held Enter must not send it unseen. */
  function endQuestion(): void {
    update({ question: null, answer: emptyInput(), enterHeldUntil: env.now() + ANSWER_BURST_MS });
  }

  function completeCommand(item: MenuCommand): void {
    const { draft } = model.current;
    update({ draft: replaceDraftText(draft, `/${item.name} `), selected: 0 });
  }

  function send(): void {
    const now = model.current;
    if (now.question !== null) {
      now.question.answer(now.answer.text);
      endQuestion();
      return;
    }
    if (env.now() < now.enterHeldUntil) {
      update({ enterHeldUntil: env.now() + ANSWER_BURST_MS });
      return;
    }
    const shown = displayDraft(now.draft);
    const item = itemsOf(now)[now.selected];
    if (item !== undefined && !env.commands.some((one) => shown === `/${one.name}`)) {
      completeCommand(item);
      return;
    }
    const assembled = assembleDraft(now.draft);
    if (!assembled.ok) {
      update({ notice: 'A pasted text is gone and the message stays here: Backspace removes its chip.' });
      return;
    }
    const line = assembled.text;
    const { attachments } = assembled;
    const isCommand = line.trim().startsWith('/');
    // A slash line goes alone: the images stay in the input for the message that follows it.
    const kept = isCommand
      ? attachments.reduce(attachToDraft, draftFromText(nextId('d'), '', 0))
      : draftFromText(nextId('d'), '', 0);
    update({ draft: kept, selected: 0, browsing: null, held: null, notice: null });
    if (line.trim() === '' && attachments.length === 0) return;
    if (/^\/attach(\s|$)/.test(line.trim())) {
      runAttach(line.trim().slice('/attach'.length).trim());
      return;
    }
    const sent = isCommand ? [] : attachments;
    if (line.trim() !== '') {
      const history = submit(insert(emptyInput(now.history), line), { secret: false }).next.history;
      recalled.current.set(line, sent);
      update({ history });
      env.saveHistory(history, { text: line, attachments: sent });
    }
    if (line.trim() === '/clear') {
      update({ entries: [] });
      return;
    }
    update({ entries: [...model.current.entries, { who: 'owner', text: line, attachments: sent }] });
    // A chat line replaces no overlay; a command does, and the older request's answer is dropped whatever it is.
    if (isCommand) panelRequest.current += 1;
    const request = panelRequest.current;
    void (line.trim() === '' ? Promise.resolve(null) : env.panelOf(line.trim()))
      .then((opened) => {
        if (request !== panelRequest.current) return;
        if (opened === null) env.send(line, sent);
        else update({ panel: opened });
      })
      .catch((error: unknown) => say(error instanceof Error ? error.message : 'The command failed.'));
  }

  const say = (text: string): void => update({ entries: [...model.current.entries, { who: 'system', text }] });

  /** A staged image for the draft it was asked for: a draft sent or cleared meanwhile gets nothing, and the staging is freed. */
  function attachStaged(draftId: string, result: StageResult, source: string): void {
    if (!result.ok) {
      update({ notice: `${source} was not attached: ${STAGE_REFUSALS[result.code] ?? result.code}.` });
      return;
    }
    if (model.current.draft.id !== draftId) {
      void env.images?.release(result.staged.id);
      return;
    }
    update({ draft: attachToDraft(model.current.draft, result.staged), notice: null });
  }

  /** `/attach <file>`, `/attach open`, `/attach save <file>`: handled here, so a path never reaches the core as text. */
  function runAttach(argument: string): void {
    if (argument === 'open' || argument === 'save' || argument.startsWith('save ')) {
      runReceived(argument);
      return;
    }
    const { images } = env;
    if (images === undefined || argument === '') {
      update({ notice: images === undefined ? 'Images are not available in this chat.' : 'Usage: /attach <file>' });
      return;
    }
    const file = argument.replace(/^(['"])(.*)\1$/, '$2');
    const draftId = model.current.draft.id;
    void images
      .stageFile(file)
      .then((result) => attachStaged(draftId, result, file))
      .catch(() => update({ notice: `${file} was not attached.` }));
  }

  /** Open or save the newest image she sent. A failed save says so, and the same command tries again. */
  function runReceived(argument: string): void {
    const image = model.current.entries.flatMap((one) => (one.who === 'her' ? (one.attachments ?? []) : [])).at(-1);
    const { received } = env;
    if (received === undefined || image === undefined) {
      update({ notice: 'No received image to act on.' });
      return;
    }
    const destination = argument.slice('save'.length).trim();
    if (argument.startsWith('save') && destination === '') {
      update({ notice: 'Usage: /attach save <file>' });
      return;
    }
    const outcome = argument === 'open' ? received.open(image) : received.save(image, destination);
    void outcome.then((done) => {
      if (done.status === 'failed') update({ notice: `${image.name}: ${done.reason}.` });
      else
        update({ notice: done.status === 'saved' ? `Saved ${image.name} to ${done.file}.` : `Opened ${image.name}.` });
    });
  }

  /** Ctrl+V: a picture from this machine's clipboard. A read that ends after the draft changed hands attaches nothing. */
  function pasteImage(): void {
    const { images } = env;
    if (images === undefined) {
      update({ notice: 'Images are not available in this chat.' });
      return;
    }
    const draftId = model.current.draft.id;
    void images
      .clipboard()
      .then(async (read) => {
        if (model.current.draft.id !== draftId) return;
        if (read.status === 'image')
          attachStaged(draftId, await images.stageBytes(read.bytes, { name: 'clipboard.png' }), 'The clipboard image');
        else if (read.status === 'empty') update({ notice: 'The clipboard holds no image.' });
        else update({ notice: `No clipboard image: ${read.reason}. /attach <file> takes a file.` });
      })
      .catch(() => update({ notice: 'The clipboard could not be read. /attach <file> takes a file.' }));
  }

  /** A chip Backspace or Delete took: an image's staged bytes go with it. */
  function afterRemoval(removed: DraftPart | null): void {
    if (removed?.kind === 'attachment') void env.images?.release(removed.attachment.id);
  }

  /** Up and Down over the history. Past the newest row the draft that browsing set aside comes back. */
  function browseHistory(delta: -1 | 1): void {
    const now = model.current;
    const moved = browse({ ...emptyInput(now.history), browsing: now.browsing }, delta);
    if (moved.browsing === null) {
      if (now.browsing !== null)
        update({ draft: now.held ?? draftFromText(nextId('d'), '', 0), browsing: null, held: null });
      return;
    }
    if (moved.browsing === now.browsing) return;
    update({
      draft: draftFromHistory(nextId('d'), moved.text, recalled.current.get(moved.text) ?? [], limits()),
      browsing: moved.browsing,
      held: now.browsing === null ? now.draft : now.held,
    });
  }

  function editDraft(draft: Draft): void {
    update({ draft, browsing: null, held: null, selected: 0, notice: null });
  }

  /** Text that is not a key. A chunk that is not a bracketed paste stays text, whatever it holds: only a paste can collapse. */
  function typed(text: string): void {
    const now = model.current;
    const plain = text.replaceAll('\r', '\n');
    if (now.question !== null) update({ answer: insert(now.answer, plain) });
    else editDraft(typeIntoDraft(now.draft, plain));
  }

  function moveMenu(delta: -1 | 1, count: number): void {
    update({ selected: Math.max(0, Math.min(count - 1, model.current.selected + delta)) });
  }

  // health: allow complexity until 2027-04-01 -- one table of the keys of the chat, and split up it would hide which key does what
  function keyOfInput(text: string, key: Parameters<Parameters<typeof useInput>[0]>[1]): void {
    const now = model.current;
    const items = itemsOf(now);
    const item = items[now.selected];
    if (now.notice !== null) update({ notice: null });
    if (key.ctrl && text === 'o') {
      const chip = chipBeforeCaret(now.draft);
      const inspected = chip === null ? null : inspectPart(now.draft, chip.id);
      if (inspected !== null) update({ panel: { title: 'Pasted text', lines: inspected.split('\n') } });
      else update({ expanded: !now.expanded });
    } else if (key.ctrl && text === 'd' && displayDraft(now.draft) === '' && now.question === null) exit();
    else if (key.ctrl && text === 'j') typed('\n');
    else if (key.return && key.meta) typed('\n');
    else if (key.return) send();
    else if (key.tab && item !== undefined) completeCommand(item);
    else if (key.escape) {
      if (now.question !== null) {
        now.question.answer('');
        endQuestion();
        return;
      }
      // The panel still on its way opens nothing now.
      panelRequest.current += 1;
      for (const part of now.draft.parts) afterRemoval(part);
      update({ draft: draftFromText(nextId('d'), '', 0), browsing: null, held: null, selected: 0 });
    } else if (key.upArrow) {
      if (items.length > 0) moveMenu(-1, items.length);
      else if (now.question === null) browseHistory(-1);
    } else if (key.downArrow) {
      if (items.length > 0) moveMenu(1, items.length);
      else if (now.question === null) browseHistory(1);
    } else if (key.leftArrow) {
      if (now.question !== null) update({ answer: moveCursor(now.answer, -1) });
      else update({ draft: moveInDraft(now.draft, -1) });
    } else if (key.rightArrow) {
      if (now.question !== null) update({ answer: moveCursor(now.answer, 1) });
      else update({ draft: moveInDraft(now.draft, 1) });
    } else if (key.backspace) {
      if (now.question !== null) update({ answer: backspace(now.answer) });
      else {
        const edit = backspaceInDraft(now.draft);
        editDraft(edit.draft);
        afterRemoval(edit.removed);
      }
    } else if (key.delete) {
      if (now.question !== null) update({ answer: backspace(now.answer) });
      else {
        const edit = deleteInDraft(now.draft);
        editDraft(edit.draft);
        afterRemoval(edit.removed);
      }
    } else if (key.ctrl && text === 'v') {
      if (now.question === null) pasteImage();
    } else if (text !== '' && !key.ctrl && !key.meta) typed(text);
  }

  const owner = focusOwner(model.current);

  useInput((text, key) => {
    if (key.ctrl && text === 'c') {
      exit();
      return;
    }
    if (owner !== 'input' || focusOwner(model.current) !== 'input' || keyTaken.current) return;
    // A held Enter can come as one chunk of returns, which Ink hands over as text.
    if (/^\r{2,}$/.test(text)) for (let press = 0; press < text.length; press += 1) send();
    else keyOfInput(text, key);
  });

  // Only while the input holds the keys: otherwise Ink hands a paste to the owner's key handler, as text.
  usePaste(
    (payload) => {
      const now = model.current;
      if (now.question !== null) update({ answer: insert(now.answer, payload) });
      else editDraft(pasteIntoDraft(now.draft, { id: nextId('p'), payload }, limits()));
    },
    { isActive: owner === 'input' }
  );

  const { entries, draft, question, panel, answer, selected, expanded, notice, brief, connected, polledAt } =
    model.current;
  const items = itemsOf(model.current);
  const closePanel = (): void => {
    takeKey();
    update({ panel: null });
  };
  const closeQuestion = (value: string): void => {
    takeKey();
    question?.answer(value);
    endQuestion();
  };
  const shown =
    question === null ? displayDraft(draft) : question.secret ? '*'.repeat(answer.text.length) : answer.text;
  const caret = caretPieces(
    shown,
    question === null ? draft.cursor : question.secret ? [...answer.text.slice(0, answer.cursor)].length : answer.cursor
  );
  return h(
    Box,
    { flexDirection: 'column', minHeight: Math.max(10, rows) },
    h(Header, { env, line: statusLine(brief, { connected, polledAt, now: env.now() }) }),
    h(
      Box,
      { flexDirection: 'column', flexGrow: 1 },
      h(
        Box,
        { flexDirection: 'column', flexGrow: 1, justifyContent: 'flex-end' },
        ...entries.map((entry, index) => h(Entry, { key: String(index), entry, expanded }))
      ),
      panel === null
        ? null
        : panel.picker !== undefined
          ? h(ModelPicker, {
              key: String(panelRequest.current),
              env: panel.picker,
              active: owner === 'panel',
              close: closePanel,
            })
          : h(PanelView, {
              key: String(panelRequest.current),
              panel,
              active: owner === 'panel',
              close: closePanel,
              prefill: (line: string) => {
                takeKey();
                update({ panel: null, draft: replaceDraftText(draftFromText(nextId('d'), '', 0), line) });
              },
            })
    ),
    h(
      Box,
      { flexDirection: 'column', flexShrink: 0 },
      panel === null && items.length > 0 ? h(Menu, { items, selected }) : null,
      question === null ? null : h(Text, { bold: true }, question.question),
      notice === null ? null : h(Text, { color: 'yellow', wrap: 'truncate' }, notice),
      owner === 'choices' && question !== null
        ? h(ChoiceSelector, {
            key: question.question,
            choices: question.choices ?? [],
            active: true,
            height: QUESTION_ROWS,
            answer: closeQuestion,
            cancel: () => closeQuestion(''),
          })
        : h(
            Box,
            { borderStyle: 'round', paddingX: 1 },
            h(Text, null, '> ', caret.before, h(Text, { inverse: true }, caret.on), caret.after)
          ),
      h(
        Text,
        { dimColor: true },
        question !== null
          ? owner === 'choices'
            ? '↑↓ select · type to filter · Enter choose · Esc cancel'
            : 'Enter continue · Esc cancel'
          : '/ commands · /setup connections · /config settings · Ctrl+O expand'
      )
    )
  );
}
