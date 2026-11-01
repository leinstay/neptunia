// One instance of the engine as a child process for tests/second-instance.test.ts. It starts the core of the engine
// copy named by its first argument (`startCore` of that copy's `src/core.ts`) over the folders `NEPTUNIA_PRIVATE_DIR`
// and `NEPTUNIA_DATA_DIR` name, with a scripted model that answers `INSTANCE_ANSWER` and the fake interface of the
// same copy. It imports nothing of the checkout it sits in: the engine is the copy, so what the instance touches is
// what a clone of the public repository would touch. The parent drives it over IPC (instance-protocol.ts).
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import type { InstanceReply, InstanceRequest } from './instance-protocol.ts';

import type * as CoreModule from '../../src/core.ts';
import type * as FakeModule from '../../src/interface/fake-interface.ts';
import type * as PathsModule from '../../src/paths.ts';

type Core = typeof CoreModule;
type Fake = typeof FakeModule;
type Paths = typeof PathsModule;
type Running = Awaited<ReturnType<Fake['start']>>;

const engine = process.argv[2];
const answer = process.env.INSTANCE_ANSWER;
if (engine === undefined || answer === undefined || process.send === undefined) {
  throw new Error('usage: instance-runner.ts <engine root>, with INSTANCE_ANSWER set and an IPC channel');
}
const send = process.send.bind(process);
const load = async <T>(file: string): Promise<T> => (await import(pathToFileURL(join(engine, file)).href)) as T;

const { startCore } = await load<Core>('src/core.ts');
const fake = await load<Fake>('src/interface/fake-interface.ts');
const { resolvePaths } = await load<Paths>('src/paths.ts');

const requests: Array<string> = [];
let running: Running | null = null;
const core = await startCore({
  paths: resolvePaths({ rootDir: engine, env: process.env }),
  env: { OPENROUTER_CORE_KEY: 'test-key' },
  interfaces: [
    {
      name: 'fake',
      start: async (host) => {
        running = await fake.start(host, { self: { id: 'self-id', name: 'Nova' }, community: { id: 'g1', name: 'Alpha' } });
        return running;
      },
    },
  ],
  llm: {
    complete: (messages: unknown) => {
      requests.push(JSON.stringify(messages));
      return Promise.resolve({ text: `<msg>${answer}</msg>`, usage: {}, estimated: 10 });
    },
  },
  embedder: { embed: () => Promise.resolve([]) },
});

function live(): Running {
  if (running === null) throw new Error('the core never started the fake interface');
  return running;
}

async function serve(request: InstanceRequest): Promise<unknown> {
  switch (request.kind) {
    case 'seed': {
      // The fake adapter's seeders take the protocol's objects as the parent built them.
      live().adapter.seedConversation(request.info as Parameters<Running['adapter']['seedConversation']>[0]);
      live().adapter.seedEvent(request.event as Parameters<Running['adapter']['seedEvent']>[0]);
      return null;
    }
    case 'emit':
      return live().emit(request.event);
    case 'posted':
      return live()
        .adapter.messagesIn(request.conversationId)
        .filter((message) => message.authorId === 'self-id')
        .map((message) => message.text);
    case 'requests':
      return requests;
    case 'stop':
      await core.stop();
      return null;
  }
}

process.on('message', (request: InstanceRequest) => {
  serve(request).then(
    (value) => {
      send({ id: request.id, ok: true, value } satisfies InstanceReply);
      // After `stop` the process holds nothing but this channel: closing it must end the process by itself.
      if (request.kind === 'stop') process.disconnect?.();
    },
    (error: unknown) =>
      send({ id: request.id, ok: false, error: error instanceof Error ? error.message : String(error) } satisfies InstanceReply)
  );
});
send({ ready: true });
