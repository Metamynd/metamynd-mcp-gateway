# MetaMynd MCP Gateway

[![HOL Guard](https://img.shields.io/endpoint?url=https%3A%2F%2Fhol.org%2Fapi%2Fregistry%2Fbadges%2Fplugin%3Fslug%3Dmetamynd%252Fmetamynd-mcp-gateway%26metric%3Drelease)](https://hol.org/registry/plugins/metamynd%2Fmetamynd-mcp-gateway?utm_source=hol_marketplace&utm_medium=plugins_badge&utm_campaign=plugins&utm_content=metamynd%2Fmetamynd-mcp-gateway&ref=plugin-author-27aa10b0)

MetaMynd MCP Gateway — Secure AI Agent Tool Execution

Add real-time governance to MCP-based AI agents without modifying your agent code. Enforce policies, spending limits, permissions and approval requirements before tool execution, with an auditable record of decisions.

**Status: 0.2.5, developer preview.** The design is in [docs/design.md](docs/design.md); what each AI app actually
does is in [docs/hosts.md](docs/hosts.md). Releases: [docs/releasing.md](docs/releasing.md) and the
[release checklist](docs/release-checklist.md). Reviewed servers: [catalog/](catalog) (Notion, HubSpot, Brave Search).

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

## Install as an AI coding plugin

A small plugin walks your coding agent through this setup: storing credentials, drafting the mapping, reviewing each
tool with you, and connecting your app. It installs instructions only. It adds no MCP server, hooks or background process.

Claude Code:

```text
/plugin marketplace add Metamynd/metamynd-mcp-gateway
/plugin install metamynd-mcp-gateway@metamynd-gateway
```

Codex loads the same skill through `.codex-plugin/plugin.json`.

## For integrators

The MetaMynd dashboard builds each agent's setup with three typed entry points:

```js
import { loadCatalog, configFromCatalog, credentialFields, serviceSetupFor } from '@metamynd/mcp-gateway/catalog';
import { planExtension, composeExtension } from '@metamynd/mcp-gateway/extension';
import { hostSnippet, directAccessWarning } from '@metamynd/mcp-gateway/hosts';
```

Pass `credentialFields(catalog, picks)` to `planExtension` as `fields` so Claude Desktop asks for each credential by its catalog
title ("Notion integration token"), and `serviceSetupFor(catalog, picks)` gives the service-side permissions to set on that credential,
so it can do no more than the picked tools need. The base bundle `composeExtension` builds from is attached to each GitHub release ([docs/releasing.md](docs/releasing.md)).

## License

[MIT](LICENSE)
