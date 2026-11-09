// The chat's semantic colour and weight tokens, the one place a colour is named. A token asks the terminal for an ANSI
// style, and the emulator's palette and font decide how it looks. Every status and selection also carries text or a shape,
// so nothing here is the only sign of anything. The values are this project's choice of 2026-11-05, with no capture of
// another program behind them, and the owner's red is his word of 2026-11-08. interfaces/cli/chat-view.ts draws with them.

/** One colour for the owner's lines, the header's title and its galaxy. */
const OWNER_COLOUR = 'red';

export const THEME = {
  text: {},
  /** the line numbers, the time rows and every other service mark */
  muted: { dimColor: true },
  title: { bold: true, color: OWNER_COLOUR },
  /** the header's galaxy */
  mark: { color: OWNER_COLOUR },
  /** the owner's lines in the chat, and his commands in the command window */
  owner: { color: OWNER_COLOUR },
  /** the rule above the slash menu */
  rule: { color: 'white' },
  activeBorder: { borderColor: 'cyan' },
  inactiveBorder: { borderColor: 'gray' },
  selection: { inverse: true },
  caret: { inverse: true },
  code: { color: 'cyan' },
  quote: { italic: true },
  heading: { bold: true },
  success: { color: 'green' },
  warning: { color: 'yellow' },
  error: { color: 'red' },
} as const;
