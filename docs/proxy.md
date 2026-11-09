# Proxy

This document is for an operator who wants the persona's outbound traffic to leave from another address. One proxy URL carries the core's connections, the video downloads and every agent run, and the engine goes direct while the proxy does not answer.

## What takes the proxy

The proxy URL is the `proxy` service of `keys.json`: an `http://`, `https://` or `socks5h://` URL with its login, password, host and port. While `proxy.enabled` is `true`, `startEngineProxy` in [src/net/engine-proxy.ts](../src/net/engine-proxy.ts) puts the URL in force for the core process through Node's `http.setGlobalProxyFromEnv`, which covers `fetch`, `http`, `https` and the `undici` client of that process. Node takes the http form of the URL, so a `socks5h://` URL is passed as `http://` with the same login, host and port, and the proxy has to serve both on one port. `localhost`, `127.0.0.1`, `::1` and `openrouter.ai` stay direct: the residential proxy twice answered `Malformed_HTTP_Response` to chat completions on `openrouter.ai`, so OpenRouter is reached around it while searches and downloads keep the proxy.

yt-dlp gets the stored URL as it is, through `--proxy`, for every video site. Every agent run gets `HTTPS_PROXY`, `HTTP_PROXY`, `https_proxy` and `http_proxy` in the http form, with `NO_PROXY` and `no_proxy` for the local hosts and `openrouter.ai`. An errand carries the proxy to its runner in `secrets.proxy` (see [Errands](errands.md#the-proxy-of-an-errand)). A run on the direct path gets none of these variables, and a proxy variable of the host environment or of the caller is dropped.

The interfaces are not proxied. An interface runs as a unit, a process of its own, and connects directly.

## Commands

The `proxy` group of [src/interface/commands/proxy.ts](../src/interface/commands/proxy.ts) runs in the chat, in `neptunia -p` and from a shell. No answer shows the URL, its login, its password or its address.

| Command | What it does |
|---|---|
| `/proxy set` | Asks for the URL in a masked question and stores it as the `proxy` service. A value without a usable scheme, host or port is refused, and nothing is written |
| `/proxy on` | Writes `proxy.enabled: true`. Refused with `not_configured` while no URL is stored |
| `/proxy off` | Writes `proxy.enabled: false` |
| `/proxy status` | Says whether the proxy is on, which route connections take now and whether a curl user agent is set. A bare `/proxy` runs it |
| `/proxy test` | Probes the stored URL once and answers `ok` or `failed` |
| `/proxy useragent [<value>]` | Writes `proxy.userAgent` and the `.curlrc` of every installed harness home. Without a value it clears both |

`/keys service set proxy` and `/keys service clear proxy` change the same stored value. A switch or a new URL takes effect at the monitor's next check, and the core checks every five seconds.

## Health and the direct path

`createProxyMonitor` in [src/net/proxy.ts](../src/net/proxy.ts) probes the proxy once every `proxy.health.everySeconds` (default `60`) with an HTTPS request through an agent of its own, so a proxy that refuses the login fails the probe as well as one that does not answer. A probe waits `proxy.health.timeoutMs` (default `8000`). After `proxy.health.failures` failed probes in a row (default `3`) every connection goes direct, and after `proxy.health.recoveries` good probes in a row (default `2`) the proxy is in force again. The monitor goes on probing while the engine is direct.

The core starts on the direct route. Its first check probes the proxy at once, and the first answer puts the proxy in force without a notice. A proxy that fails `proxy.health.failures` probes before it ever answered stays off the route and is announced as `proxy-down`, like an outage. A new URL, or the proxy turned on again, starts the same way, with both counts at zero.

A request of the core that cannot reach the proxy does not wait for the next probe. `startEngineProxy` reads Node's `http.client.request.error` and undici's `undici:client:connectError` diagnostics channels, and an error that `isProxyConnectionFailure` counts, such as `ECONNREFUSED`, `ECONNRESET`, `ETIMEDOUT` or `ERR_PROXY_TUNNEL`, probes the proxy at once. When that probe fails, every connection goes direct without waiting for the failure count. Such a probe goes out at most once per `proxy.health.timeoutMs`, and the failed request is not retried, since it may have had side effects.

Each switch reaches the persona as a `proxySwitched` fact at her next turn, worded by `wake.feedback.proxySwitched` and the code `proxy-down` or `proxy-back` (see [the prompt contract](prompt-contract.md)). `/proxy off` goes direct without a notice.

The watcher and the development worker run in processes of their own, without a monitor. Before each agent run they probe the stored URL once with `proxyForRun` and give the run the proxy only when it answered.

## curl in agent runs

Every agent run has `CURL_HOME` set to its harness home, `data/subharness/<backend>/home`, so curl reads the `.curlrc` there. `/proxy useragent` writes `user-agent = "<value>"` into that file for each installed backend, mode `600`, with the quotes and backslashes of the value escaped.

The settings of the proxy are listed in [Configuration](configuration.md#proxy).
