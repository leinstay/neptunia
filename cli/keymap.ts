// One registry of the chat's keys, read by dispatch and by help alike, so the two cannot drift apart. A key resolves
// against the focus context first, and each context binds each key at most once. The secret context binds nothing that
// could copy what is typed into a store that outlives the dialog. `cli.bindings` overrides a key, and an override that
// collides or names an action the context does not allow is reported and not bound. cli/app.ts dispatches through it.
import type { Key } from 'ink';

export type FocusContext = 'composer' | 'menu' | 'secret' | 'attachment' | 'panel' | 'search';

/** What each action does, for help. */
const ACTIONS = {
  'chat.leave': 'Leave the chat, when the input is empty',
  'composer.submit': 'Send',
  'composer.newline': 'Insert a newline',
  'composer.clear': 'Clear the input',
  'composer.paste': 'Put a paste into the draft',
  'composer.backspace': 'Delete before the caret',
  'composer.delete': 'Delete after the caret',
  'cursor.left': 'Move the caret left',
  'cursor.right': 'Move the caret right',
  'cursor.home': 'Move the caret to the start of its row',
  'cursor.end': 'Move the caret to the end of its row',
  'history.previous': 'A row up in the draft, or an older line of the history',
  'history.next': 'A row down in the draft, or a newer line of the history',
  'history.search': 'Search the history',
  'transcript.search': 'Search the transcript',
  'transcript.expand': 'Expand or fold the newest folded answer on the screen',
  'transcript.pageUp': 'Scroll the transcript up',
  'transcript.pageDown': 'Scroll the transcript down',
  'prompt.previous': 'Jump to your line above',
  'prompt.next': 'Jump to your line below',
  'edit.undo': 'Undo',
  'edit.redo': 'Redo',
  'draft.stash': 'Stash the draft, or bring it back on an empty input',
  'editor.external': 'Edit the draft in $VISUAL or $EDITOR',
  'image.paste': 'Attach an image from the clipboard',
  'menu.accept': 'Run the exact command or complete the selected one',
  'menu.complete': 'Complete the selected command',
  'menu.previous': 'Select the row above',
  'menu.next': 'Select the row below',
  'search.accept': 'Take the match',
  'search.cancel': 'Leave the search with the draft as it was',
  'search.next': 'The next older match',
  'search.paste': 'Add a paste to the query',
  'search.backspace': 'Delete from the query',
  'question.submit': 'Answer the question',
  'question.cancel': 'Cancel the question',
  'question.paste': 'Put a paste into the answer',
  'question.left': 'Move the caret left',
  'question.right': 'Move the caret right',
  'question.backspace': 'Delete before the caret',
  'panel.activate': 'Open or toggle the selected row',
  'panel.close': 'Close the panel',
  'panel.paste': 'Put a paste into the search or the value',
} as const;

export type KeyAction = keyof typeof ACTIONS;
export type KeyBinding = { context: FocusContext; key: string; action: string };
export type KeyConflict = KeyBinding & { reason: 'key-taken' | 'unknown-action' | 'not-allowed' };
export type HelpRow = { key: string; action: KeyAction; help: string };

const INPUT_BINDINGS = {
  'ctrl+d': 'chat.leave',
  enter: 'composer.submit',
  'alt+enter': 'composer.newline',
  'ctrl+j': 'composer.newline',
  escape: 'composer.clear',
  paste: 'composer.paste',
  backspace: 'composer.backspace',
  delete: 'composer.delete',
  left: 'cursor.left',
  right: 'cursor.right',
  home: 'cursor.home',
  end: 'cursor.end',
  up: 'history.previous',
  down: 'history.next',
  'ctrl+r': 'history.search',
  'ctrl+f': 'transcript.search',
  'ctrl+o': 'transcript.expand',
  pageup: 'transcript.pageUp',
  pagedown: 'transcript.pageDown',
  'alt+up': 'prompt.previous',
  'alt+down': 'prompt.next',
  'ctrl+z': 'edit.undo',
  'ctrl+y': 'edit.redo',
  'ctrl+s': 'draft.stash',
  'ctrl+g': 'editor.external',
  'ctrl+v': 'image.paste',
} as const satisfies Readonly<Record<string, KeyAction>>;

const DEFAULTS: Readonly<Record<FocusContext, Readonly<Record<string, KeyAction>>>> = {
  composer: INPUT_BINDINGS,
  // The caret stands right after a chip: the same keys, so Backspace and Delete take the chip whole.
  attachment: INPUT_BINDINGS,
  menu: {
    ...INPUT_BINDINGS,
    enter: 'menu.accept',
    tab: 'menu.complete',
    up: 'menu.previous',
    down: 'menu.next',
  },
  secret: {
    enter: 'question.submit',
    escape: 'question.cancel',
    paste: 'question.paste',
    left: 'question.left',
    right: 'question.right',
    backspace: 'question.backspace',
    delete: 'question.backspace',
  },
  search: {
    enter: 'search.accept',
    escape: 'search.cancel',
    paste: 'search.paste',
    'ctrl+r': 'search.next',
    'ctrl+f': 'search.next',
    backspace: 'search.backspace',
    delete: 'search.backspace',
  },
  panel: { enter: 'panel.activate', escape: 'panel.close', paste: 'panel.paste' },
};

const isAction = (name: string): name is KeyAction => name in ACTIONS;

export type Keymap = {
  resolve(context: FocusContext, key: string): KeyAction | null;
  help(context: FocusContext): Array<HelpRow>;
  conflicts: ReadonlyArray<KeyConflict>;
};

export function buildKeymap(overrides: ReadonlyArray<KeyBinding> = []): Keymap {
  const tables = new Map(
    (Object.keys(DEFAULTS) as Array<FocusContext>).map((context) => [
      context,
      new Map<string, KeyAction>(Object.entries(DEFAULTS[context])),
    ])
  );
  const conflicts: Array<KeyConflict> = [];
  for (const binding of overrides) {
    const table = tables.get(binding.context);
    const { action, key } = binding;
    if (table === undefined || !isAction(action)) {
      conflicts.push({ ...binding, reason: 'unknown-action' });
    } else if (!Object.values(DEFAULTS[binding.context]).includes(action)) {
      conflicts.push({ ...binding, reason: 'not-allowed' });
    } else if ((table.get(key) ?? action) !== action) {
      conflicts.push({ ...binding, reason: 'key-taken' });
    } else {
      for (const [bound, name] of table) if (name === action) table.delete(bound);
      table.set(key, action);
    }
  }
  return {
    resolve: (context, key) => tables.get(context)?.get(key) ?? null,
    help: (context) =>
      [...(tables.get(context) ?? [])].map(([key, action]) => ({ key, action, help: ACTIONS[action] })),
    conflicts,
  };
}

/** The key's name in the registry's spelling, null for a key with none, such as a plain letter. */
export function keyNameOf(typed: string, key: Key): string | null {
  const alt = key.meta ? 'alt+' : '';
  if (key.return) return `${alt}enter`;
  if (typed === '\n') return 'ctrl+j';
  if (key.escape) return 'escape';
  if (key.tab) return 'tab';
  if (key.upArrow) return `${alt}up`;
  if (key.downArrow) return `${alt}down`;
  if (key.leftArrow) return 'left';
  if (key.rightArrow) return 'right';
  if (key.pageUp) return 'pageup';
  if (key.pageDown) return 'pagedown';
  if (key.home) return 'home';
  if (key.end) return 'end';
  if (key.backspace) return 'backspace';
  if (key.delete) return 'delete';
  return key.ctrl && typed !== '' ? `ctrl+${typed}` : null;
}
