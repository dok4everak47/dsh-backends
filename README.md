# dsh-backends

Three dsh-tui backend plugins, each an `@dok4ever/dsh-backend-*` package the
`dsh-tui` profile links in through `link:` dependencies. They are private to
this machine's setup: nothing here is published, and none of it is offered
upstream.

| Folder | Package | Backend id | Drives |
| --- | --- | --- | --- |
| `hermes/` | `@dok4ever/dsh-backend-hermes` | `hermes` | Hermes over ACP (JSON-RPC on stdio) |
| `pi-cli/` | `@dok4ever/dsh-backend-pi-cli` | `pi-cli` | the `pi` CLI, one process per turn |
| `pi-durable/` | `@dok4ever/dsh-backend-pi` | `pi` | `@earendil-works/pi-durable` in-process |

## Build

Each folder builds on its own:

```sh
cd pi-cli && ./node_modules/.bin/tsc -p tsconfig.json
```

`dist/` is committed. `dst` loads it directly through the profile's `link:`
dependency, so a rebuild is what makes a change live, and a restart of `dst` is
what loads the rebuild.

## The `models` capability

`/model` in `dst` is offered only when the backend's session exposes
`capabilities.models`. Without it the command is refused as
backend-unavailable and the picker never opens. Each plugin therefore:

- declares `"capabilities": ["models"]` in **both** `dsh-plugin.json` (which the
  host's admission reads) and its `BackendManifest` (which the session reports);
- implements `list()` / `current()` / `set()` / `display()` over its own real
  catalog, so every row the picker shows is a route the backend can actually
  serve.

The catalogs come from what each backend will really run against:

- **hermes** — the models Hermes itself reports in its ACP `session/new` /
  `session/load` reply.
- **pi-durable** — `~/.pi/agent/models.json`, one provider built per block whose
  `api` is `openai-completions` (the only api this backend streams). A provider
  declared with another api is filtered out rather than offered and then failed.
- **pi-cli** — `pi --list-models`, so the picker matches the CLI's own table.

## Hooks

`hermes` also carries the ACP client and the session/model plumbing; the other
two translate their engine's event stream into dsh-tui's `AgentEvent` shapes.
