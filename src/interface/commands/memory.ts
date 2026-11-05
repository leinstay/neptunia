// The owner's browser of memory: `/memory users`, `places`, `graph`, `inspect` and the domain routes, over the typed readers
// of src/memory/db/. Each answers the reader's own result as JSON, so a script and a panel see the same typed ids. A read goes
// straight to its reader with the owner's internal context: it runs no operation, asks no model, changes no setting and writes
// no row, and what it answers never reaches her memory or a request. Only the `cli` principal reaches this module
// (src/interface/neptunia-cli.ts), and no operation of hers names it. A refusal has a status other than `ok` and a stable
// `code`. Linking and unlinking go through the one writer. `/memory inspect` reads through a snapshot the core holds for the
// owner: a command without `--snapshot` opens one and names it in its answer, and `--snapshot` goes on reading that moment.

import {
  graphEdges,
  graphKinds,
  graphNeighbors,
  graphNode,
  graphNodes,
  graphPath,
  graphWalk,
} from '../../memory/db/graph-read.ts';
import type { GraphDirection, GraphEdgeRequest } from '../../memory/db/graph-read.ts';
import { listPeople, personDetail } from '../../memory/db/people-read.ts';
import { listPlaces, placeDetail, placeLore } from '../../memory/db/places-read.ts';
import { privateByPerson } from '../../memory/db/private-read.ts';
import { coded } from '../../memory/db/read-page.ts';
import { internalContext } from '../../memory/db/scope.ts';
import type { Db } from '../../memory/db/types.ts';
import { callMethod, objOf } from '../../tools/types.ts';

type Answer = { text: string; status: string; code?: string };
type Args = Record<string, unknown>;
type Deps = { memoryDb: unknown; hot: unknown };

/** How deep a walk or a path goes when the line names no depth. Past it the answer says so and leaves a frontier. */
const DEFAULT_DEPTH = 32;

/** The reasons a reader refuses for what was asked rather than for how the database stands. */
const ASKED_WRONG = /^(INSPECTION|PERSON|PLACE|NODE|RECORD|ACCOUNT)_/;

const word = (args: Args, key: string): string => (typeof args[key] === 'string' ? args[key] : '');
const wordOrNull = (args: Args, key: string): string | null => {
  const value = word(args, key);
  return value === '' ? null : value;
};
const listOrNull = (args: Args, key: string): Array<string> | null => {
  const value = wordOrNull(args, key);
  return value === null ? null : value.split(',').filter((one) => one !== '');
};

const ok = (data: unknown): Answer => ({ text: JSON.stringify(data), status: 'ok' });
const refused = (name: string, code: string, why: string): Answer => ({
  text: `/${name.replaceAll('.', ' ')}: ${why}`,
  status: 'invalid',
  code,
});
const closedDatabase = (name: string): Answer => ({
  text: `/${name.replaceAll('.', ' ')}: the memory database is closed`,
  status: 'failed',
});

/** A reader's detail: its own shape when found, its code otherwise. */
function detail(name: string, view: { found: boolean; code?: string }): Answer {
  return view.found ? ok(view) : refused(name, view.code ?? 'RECORD_NOT_FOUND', 'nobody stored that');
}

/** The live bounds of `memoryDb.inspection`, read at each use. */
function boundsOf(hot: unknown): InspectionBounds {
  const inspection = objOf(objOf(objOf(hot).config).memoryDb).inspection;
  const { pageRows, snapshotIdleSeconds, snapshotMaxSeconds } = objOf(inspection);
  if (typeof pageRows !== 'number' || typeof snapshotIdleSeconds !== 'number' || typeof snapshotMaxSeconds !== 'number')
    throw new Error('memoryDb.inspection is not set');
  return { pageRows, snapshotIdleSeconds, snapshotMaxSeconds };
}

/** The whole number of a flag; what is no number comes back as NaN for the reader's own bound check to refuse. */
const numberOf = (args: Args, key: string, absent: number): number => {
  const value = word(args, key);
  return value === '' ? absent : Number(value);
};

/** The page size a command reads: the bound of the settings, or less when the line asks for less. */
const limitOf = (args: Args, bounds: InspectionBounds): number =>
  Math.min(numberOf(args, 'limit', bounds.pageRows), bounds.pageRows);

function cursorOf(args: Args): string | null {
  return wordOrNull(args, 'cursor');
}

function edgeRequestOf(args: Args): GraphEdgeRequest {
  const mode = word(args, 'mode');
  if (mode !== '' && mode !== 'active' && mode !== 'historical')
    throw coded('INSPECTION_BAD_ARGUMENT', '--mode is active or historical');
  return {
    predicates: listOrNull(args, 'predicates'),
    mode: mode === 'historical' ? 'historical' : 'active',
    validAt: wordOrNull(args, 'valid-at'),
    recordedBefore: wordOrNull(args, 'recorded-before'),
  };
}

function directionOf(args: Args, absent: GraphDirection): GraphDirection {
  const direction = word(args, 'direction');
  if (direction === '') return absent;
  if (direction === 'in' || direction === 'out' || direction === 'both') return direction;
  throw coded('INSPECTION_BAD_ARGUMENT', '--direction is in, out or both');
}

function usersRead(db: Db, name: string, args: Args, bounds: InspectionBounds): Answer | null {
  const context = internalContext();
  const person = word(args, 'person');
  const leaf = name.slice('memory.users.'.length);
  if (leaf === 'list')
    return ok(
      listPeople(db, {
        context,
        filters: {
          name: wordOrNull(args, 'name'),
          interfaceId: wordOrNull(args, 'interface'),
          authorityId: wordOrNull(args, 'authority'),
        },
        limit: limitOf(args, bounds),
        cursor: cursorOf(args),
      })
    );
  if (leaf === 'private') return detail(name, privateByPerson(db, person, context));
  if (!['show', 'accounts', 'names', 'relationship'].includes(leaf)) return null;
  const view = personDetail(db, person, context);
  if (!view.found || leaf === 'show') return detail(name, view);
  if (leaf === 'accounts') return ok({ accounts: view.accounts, links: view.links });
  return ok(leaf === 'names' ? { names: view.names } : { affinity: view.affinity });
}

/** `/memory users link` and `unlink`: typed ids checked on the read connection, the write through the one writer. */
async function usersWrite(memoryDb: unknown, db: Db, name: string, args: Args): Promise<Answer> {
  const person = word(args, 'person');
  const account = word(args, 'account');
  const view = personDetail(db, person, internalContext());
  if (!view.found) return refused(name, view.code, 'nobody stored that person');
  const known = db.prepare('SELECT 1 AS ok FROM accounts WHERE id = ?').get(account) !== undefined;
  if (!known) return refused(name, 'ACCOUNT_NOT_FOUND', 'nobody stored that account');
  const linking = name === 'memory.users.link';
  if (!linking && !view.accounts.some((one) => one.id === account))
    return refused(name, 'ACCOUNT_NOT_LINKED', 'that account is not linked to that person');
  const update = linking
    ? { op: 'bind', accountId: account, target: { personId: person } }
    : { op: 'unbind', accountId: account };
  try {
    await (callMethod(memoryDb, 'personLink', update) as Promise<unknown>);
    return ok({ accountId: account, personId: person, linked: linking });
  } catch {
    return { text: `/${name.replaceAll('.', ' ')}: the link could not be written`, status: 'failed' };
  }
}

function placesRead(db: Db, name: string, args: Args, bounds: InspectionBounds): Answer | null {
  const context = internalContext();
  const place = word(args, 'place');
  switch (name) {
    case 'memory.places.list':
      return ok(
        listPlaces(db, {
          context,
          filters: {
            interfaceId: wordOrNull(args, 'interface'),
            authorityId: wordOrNull(args, 'authority'),
            rootsOnly: word(args, 'roots') === 'true',
          },
          limit: limitOf(args, bounds),
          cursor: cursorOf(args),
        })
      );
    case 'memory.places.show':
      return detail(
        name,
        placeDetail(db, place, { context, includeChildren: word(args, 'include-children') === 'true' })
      );
    case 'memory.places.tree': {
      const view = placeDetail(db, place, { context, includeChildren: true });
      if (!view.found) return detail(name, view);
      const limit = limitOf(args, bounds);
      if (!Number.isInteger(limit) || limit <= 0)
        throw coded('INSPECTION_BAD_LIMIT', '--limit is a positive whole number');
      return ok({
        place: view.place,
        descendants: view.descendants.slice(0, limit),
        cycles: view.cycles,
        omitted: Math.max(0, view.descendants.length - limit),
      });
    }
    case 'memory.places.lore':
      return detail(name, placeLore(db, place, context));
    default:
      return null;
  }
}

function graphRead(db: Db, name: string, args: Args, bounds: InspectionBounds): Answer | null {
  const context = internalContext();
  const limit = limitOf(args, bounds);
  const cursor = cursorOf(args);
  switch (name) {
    case 'memory.graph.kinds':
      return ok(graphKinds(db, context));
    case 'memory.graph.nodes':
      return ok(graphNodes(db, context, { kinds: listOrNull(args, 'kinds'), limit, cursor }));
    case 'memory.graph.edges':
      return ok(graphEdges(db, context, { ...edgeRequestOf(args), limit, cursor }));
    case 'memory.graph.node':
      return detail(name, graphNode(db, context, word(args, 'node')));
    case 'memory.graph.neighbors':
      return ok(
        graphNeighbors(db, context, {
          ...edgeRequestOf(args),
          node: word(args, 'node'),
          direction: directionOf(args, 'both'),
          limit,
          cursor,
        })
      );
    case 'memory.graph.walk':
      return ok(
        graphWalk(db, context, {
          ...edgeRequestOf(args),
          from: word(args, 'nodes-from').split(' '),
          direction: directionOf(args, 'out'),
          maxDepth: numberOf(args, 'depth', DEFAULT_DEPTH),
          maxNodes: Math.min(numberOf(args, 'nodes', bounds.pageRows), bounds.pageRows),
          cursor,
        })
      );
    case 'memory.graph.path':
      return ok(
        graphPath(db, context, {
          ...edgeRequestOf(args),
          from: word(args, 'from'),
          to: word(args, 'to'),
          direction: directionOf(args, 'out'),
          maxDepth: numberOf(args, 'depth', DEFAULT_DEPTH),
        })
      );
    default:
      return null;
  }
}

/** A command of this module run, a refusal of the reader as an answer with its code. */
async function answering(name: string, read: () => Answer | Promise<Answer> | null): Promise<Answer | null> {
  try {
    return await read();
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    const why = error instanceof Error ? error.message : String(error);
    if (typeof code === 'string' && ASKED_WRONG.test(code)) return refused(name, code, why);
    return { text: `/${name.replaceAll('.', ' ')}: ${why}`, status: 'failed' };
  }
}

/** The prefixes of the commands this module answers. */
const BROWSER_NAME = new RegExp(`^memory\\.(users|places|graph)\\.`);

/** Whether this module answers `name`: the writes that stay operations are the console's. */
export const isMemoryBrowserCommand = (name: string): boolean =>
  BROWSER_NAME.test(name) && !name.startsWith('memory.places.lore.') && !name.startsWith('memory.users.names.');

/** The answer of a browser command, for `requester`, the owner. */
export async function memoryBrowserCommand(
  { memoryDb, hot }: Deps,
  name: string,
  args: Args,
  requester: { id: string }
): Promise<Answer> {
  const answer = await answering(name, () => {
    const db = callMethod(memoryDb, 'database') as Db | null | undefined;
    if (db == null) return closedDatabase(name);
    if (name === 'memory.users.link' || name === 'memory.users.unlink') return usersWrite(memoryDb, db, name, args);
    const bounds = boundsOf(hot);
    return usersRead(db, name, args, bounds) ?? placesRead(db, name, args, bounds) ?? graphRead(db, name, args, bounds);
  });
  return answer ?? { text: `/${name.replaceAll('.', ' ')}: no such command; type /help`, status: 'invalid' };
}
