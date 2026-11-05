// The settings schema of `proxy` (src/config/schema.ts): one entry per key, in the order of config/config.json.

import type { SchemaEntry } from '../schema.ts';

export const PROXY: ReadonlyArray<SchemaEntry> = [
  {
    'key': 'proxy.enabled',
    'types': ['boolean'],
    'reader': 'src/net/proxy.ts',
    'default': false,
    'text': "Send the core's connections, yt-dlp and every agent run through the proxy stored by `/proxy set`",
  },
  {
    'key': 'proxy.userAgent',
    'types': ['string'],
    'reader': 'src/interface/commands/proxy.ts',
    'default': '',
    'text': "The user agent curl sends in agent runs, written to each harness home's `.curlrc` by `/proxy useragent`",
  },
  {
    'key': 'proxy.health.everySeconds',
    'types': ['number'],
    'reader': 'src/net/proxy.ts',
    'default': 60,
    'text': 'Seconds between two probes of the proxy',
  },
  {
    'key': 'proxy.health.failures',
    'types': ['number'],
    'reader': 'src/net/proxy.ts',
    'default': 3,
    'text': 'Failed probes in a row that send every connection direct',
  },
  {
    'key': 'proxy.health.recoveries',
    'types': ['number'],
    'reader': 'src/net/proxy.ts',
    'default': 2,
    'text': 'Good probes in a row that take the proxy back',
  },
  {
    'key': 'proxy.health.timeoutMs',
    'types': ['number'],
    'reader': 'src/net/proxy.ts',
    'default': 8000,
    'text': 'How long one probe waits for an answer',
  },
];
