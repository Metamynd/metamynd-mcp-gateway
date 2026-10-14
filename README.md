# MetaMynd MCP Gateway

**Status: in development — not yet released.** The design is in [docs/design.md](docs/design.md); what each AI app
actually does is in [docs/hosts.md](docs/hosts.md).

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
```

`init` marks every drafted tool `"review": true`; the gateway will not start until each one has been checked against
the agent's mandate and the flag removed. Credentials are referenced, never written: `keychain:<name>` or `${VAR}`.
The configuration format is in [docs/design.md §4](docs/design.md#4-configuration).

## License

[MIT](LICENSE)
