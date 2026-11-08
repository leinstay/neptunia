// The chat's semantic colour and weight tokens, the one place a colour is named. A token asks the terminal for an ANSI
// style, and the emulator's palette and font decide how it looks. Every status and selection also carries text or a shape,
// so nothing here is the only sign of anything. The values are this project's choice of 2026-11-05, with no capture of
// another program behind them. cli/chat-view.ts draws with them.

export const THEME = {
  text: {},
  muted: { dimColor: true },
  title: { bold: true, color: 'cyan' },
  mark: { color: 'magenta' },
  /** the owner's lines and their time rows in the chat, and his commands in the command window */
  owner: { color: 'cyan' },
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
