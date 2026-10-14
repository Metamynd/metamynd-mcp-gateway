# MetaMynd MCP Gateway

**Status: design — not yet released.** The design is in [docs/design.md](docs/design.md).

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

## License

[MIT](LICENSE)
