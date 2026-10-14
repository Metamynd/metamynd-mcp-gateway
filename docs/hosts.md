# Host matrix (phase 0)

What each phase-1 host actually does, from its own documentation as of **2026-10-14**. Where a vendor does not document
something, the cell says so; a figure from a forum or issue tracker is marked **(unofficial)** and treated as a risk to
design around, not a fact. Re-check before each release — hosts change quickly.

## How a user adds the gateway

| Host | How | Transports | Source |
|---|---|---|---|
| Claude Desktop | **Extension (`.mcpb`)** — preferred, see below. Or `claude_desktop_config.json` (macOS `~/Library/Application Support/Claude/`, Windows `%APPDATA%\Claude\`): `{"mcpServers":{"metamynd":{"command":"npx","args":["-y","@metamynd/mcp-gateway@x.y.z"]}}}`; full restart needed. Server stderr is logged to `mcp-server-<name>.log`. | stdio (remote servers are "custom connectors") | [connect local servers](https://modelcontextprotocol.io/docs/develop/connect-local-servers) |
| Claude Code | `claude mcp add --transport stdio metamynd -- npx -y @metamynd/mcp-gateway@x.y.z`; or `.mcp.json` (`mcpServers`, `${VAR}` expansion) | stdio, http, sse (deprecated), ws | [Claude Code MCP](https://code.claude.com/docs/en/mcp) |
| Cursor | `.cursor/mcp.json` or `~/.cursor/mcp.json`: `mcpServers`, `type: "stdio"`, `env` with `${env:NAME}`, `envFile` | stdio, SSE, Streamable HTTP | [Cursor MCP](https://cursor.com/docs/context/mcp) |
| VS Code (Copilot) | `.vscode/mcp.json` (top-level **`servers`**), user profile, or `code --add-mcp '{…}'` | stdio, http (SSE fallback), sse | [VS Code MCP servers](https://code.visualstudio.com/docs/copilot/customization/mcp-servers), [config reference](https://code.visualstudio.com/docs/agents/reference/mcp-configuration) |
| OpenAI Agents SDK | Python `MCPServerStdio(params={"command": "npx", "args": [...]})`; JS `new MCPServerStdio({ name, fullCommand })` | stdio, Streamable HTTP, SSE (deprecated), hosted | [Python](https://openai.github.io/openai-agents-python/mcp/), [JS](https://openai.github.io/openai-agents-js/guides/mcp/) |
| LangChain / LangGraph | **`langchain-mcp-adapters` is no longer maintained**; use `langchain[mcp]>=1.4.0` (`langchain.mcp`, beta) — `MCPAdapter` with an `MCPConfig` | stdio, http, sse | [adapters repo](https://github.com/langchain-ai/langchain-mcp-adapters), [LangChain MCP](https://docs.langchain.com/oss/python/langchain/mcp) |

## Limits that shape the gateway

| Topic | What the hosts do | Source |
|---|---|---|
| Tool name format | Spec (2026-07-28): SHOULD be 1–128 chars of `[A-Za-z0-9_.-]`; an aggregating proxy SHOULD prefix the server. Claude Code turns anything outside `[A-Za-z0-9_-]` into `_` and drops a tool whose `mcp__<server>__<tool>` exceeds 128. | [spec: tools](https://modelcontextprotocol.io/specification/2026-07-28/server/tools), Claude Code MCP |
| Name length | Cursor: server + tool ≤ ~60 characters **(unofficial)**. | [Cursor forum](https://forum.cursor.com/t/google-gws-cli-tool-names-too-long/153918) |
| Tool count | Cursor: ~40 tools in total **(unofficial)**. Others not documented. | [Cursor forum](https://forum.cursor.com/t/tools-limited-to-40-total/67976) |
| Call timeout | Claude Desktop ~60 s, `timeout` in config ignored **(unofficial)**; Cursor ~60 s **(unofficial)**; Claude Code default very long, per-server `timeout`; OpenAI Agents SDK (Python) `client_session_timeout_seconds` **default 5 s**; VS Code, LangChain not documented. | [Desktop issue](https://claudeissues.com/issue/43791-bug-timeout-field-in-claude-desktop-config-json-not-honored-for-mcp-servers), [Cursor forum](https://forum.cursor.com/t/agent-acp-mcp-tools-call-times-out-at-60s-with-no-way-to-configure-it/163925/5), Claude Code MCP, [Agents SDK server ref](https://openai.github.io/openai-agents-python/ref/mcp/server/) |
| `isError: true` results | Spec: SHOULD be given to the model. LangChain makes it a `ToolMessage(status="error")`. Claude Code truncates error text over ~11k chars. Others not documented. | spec, [LangChain MCP tools](https://docs.langchain.com/oss/python/langchain/mcp/tools), Claude Code MCP |
| Secrets | Desktop config `env` is plaintext; the extension's `sensitive` fields are stored securely (OS keychain per Anthropic). VS Code `inputs` with `password: true` → `${input:id}`. Cursor `${env:NAME}` / `envFile`. | [desktop extensions](https://www.anthropic.com/engineering/desktop-extensions), VS Code config reference, Cursor MCP |
| Annotations | VS Code skips its confirmation for `readOnlyHint`; ChatGPT treats tools without it as writes; OpenAI Agents SDK passes them to `require_approval` as advisory. | [VS Code AI MCP](https://code.visualstudio.com/api/extension-guides/ai/mcp), [Apps SDK](https://developers.openai.com/apps-sdk/build/mcp-server) |
| Elicitation | Claude Code, VS Code, Cursor support it; Claude Desktop not documented; LangChain re-runs the tool from the start on resume. | per host |

## Claude Desktop extension (`.mcpb`)

- Built with `@anthropic-ai/mcpb` (`mcpb init`, `mcpb pack`); `.dxt` still works. ([mcpb](https://github.com/modelcontextprotocol/mcpb))
- `manifest.json` ([MANIFEST.md](https://github.com/modelcontextprotocol/mcpb/blob/main/MANIFEST.md)): `manifest_version`, `name`, `version`,
  `description`, `author.name`, `server` (`type: "node"`, `entry_point`, `mcp_config` with `command`/`args`/`env` and
  `platform_overrides`), `user_config` entries `{type, title, description, sensitive, required}`, `compatibility.runtimes.node`.
- Values reach the server through `${user_config.<key>}` in `args`/`env` (also `${__dirname}`, `${HOME}`, …).
- **Claude Desktop ships Node.js**, so a `node` extension needs no separate install.

## SDK and protocol

- **MCP spec 2026-07-28** is the latest stable revision: stateless requests, every request carries
  `_meta["io.modelcontextprotocol/protocolVersion"]` plus client info and capabilities; `resultType` (`input_required`);
  `tools/list` gains `ttlMs`/`cacheScope` and must not vary per connection. Hosts are still moving to it.
- **TypeScript SDK v2** (released 2026-07-27, implements 2026-07-28): `@modelcontextprotocol/server` and
  `@modelcontextprotocol/client` (2.3.x). v1 (`@modelcontextprotocol/sdk` 1.32.x) is maintained for at least six months.

## Remote-only hosts (phase 3)

- **Claude.ai custom connectors:** remote only, reachable from the public internet; OAuth, static headers or none.
  ([help](https://support.claude.com/en/articles/11175166-getting-started-with-custom-connectors-using-remote-mcp))
- **ChatGPT apps:** Streamable HTTP at a public HTTPS endpoint; OAuth 2.1. ([Apps SDK](https://developers.openai.com/apps-sdk/build/mcp-server))

## Decisions this matrix drives

1. **Names:** exposed names `<upstream>__<tool>`, at most **48 characters** of `[A-Za-z0-9_-]` (no dots). With a short host
   key such as `metamynd`, server + tool stays under Cursor's reported ~60 and Claude Code's 128.
2. **Tool count:** warn above **40** governed tools; recommend fewer.
3. **Answer within ~45 s.** Never block on a person: a held request returns at once (`escalationWaitMs` is capped at
   30 s). Document `client_session_timeout_seconds` for the Python Agents SDK, whose 5 s default is shorter than an
   authorize round trip under load.
4. **Refusals and holds are `isError: true` results** with short text (well under 10k characters); JSON-RPC errors only for
   protocol faults.
5. **Secrets:** through `env` only, never `args`. The `.mcpb` marks tool keys `sensitive: true`; VS Code guides use
   `inputs` with `password: true`.
6. **Annotations:** the gateway sets `readOnlyHint` only from its own reviewed mapping (an action that moves no value),
   never forwards upstream annotations as truth.
7. **Approval never relies on elicitation** (undocumented in Claude Desktop; LangChain re-runs the tool on resume).
8. **SDK:** build on SDK v2; test against hosts on both 2025-11-25 and 2026-07-28 until they converge.
