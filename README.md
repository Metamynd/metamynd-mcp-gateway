# MetaMynd MCP Gateway

**Status: 0.2.2, developer preview.** The design is in [docs/design.md](docs/design.md); what each AI app actually
does is in [docs/hosts.md](docs/hosts.md). Releases: [docs/releasing.md](docs/releasing.md).

Put any AI agent that uses MCP tools under [MetaMynd](https://metamynd.ai) governance — Claude Desktop, Cursor,
VS Code, ChatGPT, LangGraph, the OpenAI Agents SDK and the rest — **without changing any code**.

The gateway sits between your AI app and the MCP servers it uses. Every tool call is checked against the agent's
mandate before it runs: allowed calls go through, calls over a limit are refused, and calls that need a person are
held for approval. The tools' API keys live in the gateway, not in the app, so the AI can't go around it.

```
 your AI app ──MCP──▶ @metamynd/mcp-gateway ──MCP──▶ your tools (payments, CRM, records, …)
                              │
                              └──▶ MetaMynd: allow · refuse · hold for approval
```

- **For non-developers first:** a one-click Claude Desktop extension and a "Connect to …" button in the MetaMynd
  dashboard.
- **Every tool governed,** reads included — a tool is either governed or not offered.
- **Runs on your machine** (or your own server for hosted chat products). MetaMynd never holds your tools' keys.

Built on the open-source MetaMynd SDKs in [Metamynd/agentsafe-guard](https://github.com/Metamynd/agentsafe-guard)
and the [MAGP v1.0 protocol](https://metamynd.ai/developers/spec).

## Commands (developer preview)

```bash
mcp-gateway secret set payments-api-key            # store a tool's key in the OS keychain (input hidden)
mcp-gateway init --config mcp-gateway.json         # draft a mapping for every tool of every server
mcp-gateway --config mcp-gateway.json              # run it for an AI app (stdio)
mcp-gateway extension --config mcp-gateway.json --name "Accounts Payable"   # one-click Claude Desktop extension
mcp-gateway config --host cursor --config mcp-gateway.json                 # the snippet for another app
```

`extension` builds a `.mcpb` for one agent. Nothing secret is inside it: each credential, and the agent's key, becomes
a field Claude Desktop asks for at install and stores securely. `config --host` knows `claude-desktop`, `claude-code`,
`cursor`, `vscode`, `openai-agents-python`, `openai-agents-js` and `langchain`
([docs/hosts.md](docs/hosts.md)).

`init` marks every drafted tool `"review": true`; the gateway will not start until each one has been checked against
the agent's mandate and the flag removed. Credentials are referenced, never written: `keychain:<name>` or `${VAR}`.
The configuration format is in [docs/design.md §4](docs/design.md#4-configuration).

## For integrators

The MetaMynd dashboard builds each agent's extension with two typed entry points:

```js
import { loadCatalog, configFromCatalog, credentialFields, serviceSetupFor } from '@metamynd/mcp-gateway/catalog';
import { planExtension, composeExtension } from '@metamynd/mcp-gateway/extension';
```

Pass `credentialFields(catalog, picks)` to `planExtension` as `fields` so Claude Desktop asks for each credential by its catalog
title ("Notion integration token"), and `serviceSetupFor(catalog, picks)` gives the service-side permissions to set on that credential,
so it can do no more than the picked tools need. The base bundle `composeExtension` builds from is attached to each GitHub release ([docs/releasing.md](docs/releasing.md)).

## License

[MIT](LICENSE)
