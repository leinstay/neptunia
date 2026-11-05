// The panel's data contract: bin/chat-panels.ts supplies rows and their existing command handlers. The renderer
// knows only selection, editing and feedback, so a screen never writes settings or chooses credentials itself.
import type { PickerEnv } from './model-picker.ts';

export type PanelResult = { status: string; text: string; code?: string };
export type PanelRow = {
  id: string;
  label: string;
  detail: string;
  group: string;
  value?: string;
  edit?: { kind: 'text' | 'boolean'; value: string };
  apply?: (value: string) => Promise<PanelResult>;
  prefill?: string;
};
export type Panel = {
  title: string;
  lines: ReadonlyArray<string>;
  rows?: ReadonlyArray<PanelRow>;
  /** the panel is the nested model selector, over these reads and this commit */
  picker?: PickerEnv;
};

/** Search spans every tab; without a search the selected tab supplies its rows. */
export function panelRows(panel: Panel, group: string, search: string): Array<PanelRow> {
  const asked = search.trim().toLowerCase();
  return (panel.rows ?? []).filter((row) =>
    asked === '' ? row.group === group : `${row.id} ${row.label} ${row.detail}`.toLowerCase().includes(asked)
  );
}
