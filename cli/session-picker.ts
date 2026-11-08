// The panels of `/sessions`, `/branch` and `/checkpoints`, over what the caller reads from the core: bin/chat-panels.ts supplies
// the client. Opening a panel only reads. Resuming, branching and restoring each happen on their own row, and a branch's row
// shows the exact stored line it cuts at. Memory is another resource: the panels say so and never promise a forgetting.
import type { Panel, PanelResult, PanelRow } from './panel.ts';
import { displaySafe } from './transcript.ts';

export type SessionRowView = {
  id: string;
  name: string;
  parentId: string | null;
  lines: number;
  lastAt: number | null;
};
export type SessionLineView = { id: string; at: number; who: string; text: string };
export type SessionClient = {
  list(): Promise<ReadonlyArray<SessionRowView>>;
  inspect(id: string): Promise<{ id: string; memory: string; lines: ReadonlyArray<SessionLineView> }>;
  resume(id: string): Promise<PanelResult>;
  branch(id: string, boundary: string): Promise<PanelResult>;
};

const firstLine = (text: string): string => displaySafe(text.split('\n')[0] ?? '');

const MEMORY_STATEMENT =
  'A branch changes which lines this chat shows and sends as context. Memory stays continuous: what she saw and learned stays known, including what came after this point.';

/** The sessions, each resumed by its own row, a branch told from its parent by its lineage. */
export async function sessionsPanel(client: SessionClient): Promise<Panel> {
  const sessions = await client.list();
  if (sessions.length === 0) return { title: 'Sessions', lines: ['No chat is stored yet.'], rows: [] };
  const rows = sessions.map((one): PanelRow => ({
    id: one.id,
    label: displaySafe(one.name),
    detail: [
      one.parentId === null ? 'The whole chat' : `Branch of ${one.parentId}`,
      `${one.lines} lines`,
      one.lastAt === null ? 'nothing said yet' : `last line ${new Date(one.lastAt).toISOString().slice(0, 16)}`,
      'Enter resumes it',
    ].join(' · '),
    group: 'Sessions',
    apply: () => client.resume(one.id),
  }));
  return { title: 'Sessions', lines: [], rows };
}

/** The lines of a session as branch points. A row carries its exact stored text and branches when activated. */
export async function boundaryPanel(client: SessionClient, sessionId: string): Promise<Panel> {
  const shown = await client.inspect(sessionId);
  const rows = shown.lines.map((line): PanelRow => ({
    id: line.id,
    label: `${line.who}: ${firstLine(line.text)}`,
    detail: `Enter branches right after this line. ${MEMORY_STATEMENT}`,
    group: 'Lines',
    value: line.text,
    apply: () => client.branch(sessionId, line.id),
  }));
  return {
    title: 'Branch',
    lines: rows.length === 0 ? ['This chat has no line to branch at.', MEMORY_STATEMENT] : [MEMORY_STATEMENT],
    rows,
  };
}

export type CheckpointPoint = {
  id: string;
  revision: number;
  changes: ReadonlyArray<{ path: string; change: string }>;
  restore: (id: string) => Promise<PanelResult>;
};

/** The file checkpoints of the development worktrees. A backend that cannot restore shows why and has no row to press. */
export function checkpointPanel(
  capability: { restore: true } | { restore: false; reason: string },
  points: ReadonlyArray<CheckpointPoint>
): Panel {
  if (!capability.restore)
    return { title: 'Checkpoints', lines: [`File checkpoints are unavailable: ${capability.reason}.`], rows: [] };
  const rows = points.map((point): PanelRow => {
    const paths = point.changes.map((one) => `${one.change} ${one.path}`).join(', ');
    return {
      id: point.id,
      label: `Restore ${point.id}`,
      detail: `Enter restores these files: ${paths === '' ? 'nothing differs' : paths}. The state it replaces stays as a new checkpoint.`,
      group: 'Checkpoints',
      value: paths,
      apply: () => point.restore(point.id),
    };
  });
  return {
    title: 'Checkpoints',
    lines:
      rows.length === 0
        ? ['No checkpoint yet. /checkpoints take <task> takes one of a development task.']
        : ['A restore touches this worktree alone, never data, credentials, settings or what she already sent.'],
    rows,
  };
}
