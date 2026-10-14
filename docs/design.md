# MetaMynd MCP Gateway — governing any MCP host without code

**Status:** Design — decided, not yet built. **Package:** `@metamynd/mcp-gateway` · **Repository:**
[Metamynd/metamynd-mcp-gateway](https://github.com/Metamynd/metamynd-mcp-gateway) · **Editors:** MetaMynd

Builds on [MAGP v1.0](https://metamynd.ai/developers/spec) and the published MetaMynd SDKs in
[Metamynd/agentsafe-guard](https://github.com/Metamynd/agentsafe-guard):
[`@metamynd/agentsafe-guard`](https://www.npmjs.com/package/@metamynd/agentsafe-guard) (agent side),
[`@metamynd/agentsafe-http-gateway`](https://www.npmjs.com/package/@metamynd/agentsafe-http-gateway) and
[`@metamynd/agentsafe-mcp-guard`](https://www.npmjs.com/package/@metamynd/agentsafe-mcp-guard) (service side), and
[`@metamynd/agentsafe-signer`](https://www.npmjs.com/package/@metamynd/agentsafe-signer) (key custody). The gateway
changes nothing in the MetaMynd gate, the protocol or its APIs.

## Decisions

| # | Question | Decision |
|---|---|---|
| 1 | Who is it for first? | **Non-technical users** of desktop AI apps. The one-click Claude Desktop extension and the dashboard's "Connect to …" are part of the first release, not later. |
| 2 | Must upstream credentials sit in the gateway? | **Yes, from day one.** There is no "convenience" mode without them: without the credentials the gateway is not an enforcement point, so it is not offered. |
| 3 | Will MetaMynd host gateways? | **No.** The gateway runs on the user's machine, or on the customer's own server. MetaMynd never holds customers' upstream credentials. |
| 4 | Which tools are governed? | **Every tool**, reads included, so the audit trail is complete. A tool is either governed or not offered. |
| 5 | Name and home | npm **`@metamynd/mcp-gateway`** (scoped, so the name can't be squatted), in its own public repository **`Metamynd/metamynd-mcp-gateway`**, MIT. New MetaMynd packages each get their own repository from now on. |

## 1. Problem

Putting an agent under MetaMynd governance today means changing its code: every tool is wrapped with `guardTool`
(JavaScript) or `guard_tool` (Python), or its HTTP calls go through `agentsafe-http-gateway`. That works across
frameworks, but:

- **Every framework is its own integration**, with a few lines in its own idiom and its own docs page.
- **It excludes people who don't write code.** Someone using Claude Desktop, ChatGPT or Cursor with a payments tool has
  no code to wrap.

The Model Context Protocol (MCP) has become the common way agents get tools; almost every host and framework is an MCP
client. A component on the MCP connection can govern tool calls in all of them, configured rather than coded.

## 2. Goals and non-goals

**Goals**

1. Govern the tool calls of **any MCP-capable host or framework** with configuration only.
2. **The model cannot exceed its mandate**, even when prompt-injected: the upstream credentials sit behind the
   gateway, never in the host (decision 2).
3. Reuse the published SDKs — signing, authorize/capture/void, payload binding, escalation resume. No change to the
   MetaMynd gate.
4. A first governed action in **under 5 minutes** for someone who has never written code (decision 1).

**Non-goals**

- Replacing the SDKs. Tools that aren't MCP (native function calls, plain HTTP clients) keep using `guardTool` or the
  HTTP gateway.
- Governance as a tool the model chooses to call (`metamynd_authorize`). A model can skip a tool; that is advice, not
  enforcement.
- An owner/management MCP (create agents, set mandates). Possibly later and separate; approving a held request always
  stays with a person, never with the agent.
- A MetaMynd-hosted gateway (decision 3).

## 3. How it works

```
 MCP host (Claude Desktop, Cursor, ChatGPT, LangGraph, …)
        │  MCP (stdio or Streamable HTTP)            the host sees ONE server: "metamynd"
        ▼
 ┌────────────────────────────── @metamynd/mcp-gateway ───────────────────────────┐
 │ 1. tools/list  → every governed upstream tool, renamed <upstream>__<tool>       │
 │ 2. tools/call  → map args → action/amount/currency/merchant (tools config)      │
 │ 3. sign with the agent's key (signer daemon / OS keychain), authorize at gate   │
 │ 4. allow → call upstream with ITS credentials; capture or void                  │
 │    refuse → tool error with reason; escalate → "held for approval", journal it  │
 └─────────────────────────────────────────────────────────────────────────────────┘
        │ MCP client per upstream (stdio child or HTTP)     ▲ upstream credentials live HERE only
        ▼                                                   │
 Upstream MCP servers (payments, CRM, records, …)           MetaMynd gate (unchanged)
```

The gateway is an **MCP server** to the host and an **MCP client** to each upstream server. To MetaMynd it is simply
the agent: it uses the agent's identity and the same authorize, capture and void calls that `guardTool` makes.

### 3.1 Per tool call

1. **Look up the mapping** for `<upstream>.<tool>`. A tool without one is never listed (§3.2).
2. **Check the arguments:** only the mapping's `allowedArgs` are accepted, and value fields must have the right type.
   Anything else is refused before authorizing.
3. **Authorize** with `action`; `amount`, `currency`, `merchant` for a tool that moves value (none for a read); the
   operator's `context` (e.g. `riskLevel`); and `payload` = the tool arguments, so the decision is bound to the exact
   arguments (MAGP §8.3.9).
4. **On `allow`/`observe`:** call the upstream tool with those arguments, then settle:
   - success → capture at the mapped amount (0 for a read);
   - a protocol error before the tool ran (unknown tool, invalid params) → void;
   - a result with `isError: true` → the tool may have acted, so capture (the hold stays counted against the cap),
     unless the mapping marks the tool safely retryable (`onToolError: "void"`).
5. **On `escalate`:** return *"Held for approval by your approver (ref esc_…). Ask me to try again once it is
   approved."* and journal the escalation (§3.3).
6. **On any refusal:** return the reason code and the gate's hint. The upstream tool is never called.

Refusals are **tool results with `isError: true`**, not JSON-RPC errors, so every host shows them to the model, which
explains them to the user.

### 3.2 Tool naming and listing

- Exposed names are `<upstream>__<tool>`, at most 48 characters of `[A-Za-z0-9_-]`, so tools from different servers
  can't collide and every phase-1 host accepts them ([hosts.md](hosts.md)). More than 40 governed tools draws a
  warning: some hosts show only about that many.
- Every listed tool is governed (decision 4). Unmapped tools are hidden; there is no "allow ungoverned" switch.
- Descriptions pass through from upstream with one line added: *"Governed by MetaMynd: may be refused or held for
  approval."*

### 3.3 Held requests and resume

MCP has no "pending" state and hosts time tool calls out, so the gateway never blocks waiting for a person:

1. On `escalate`, it journals `{escalationId, upstream, tool, argsDigest}` in its state directory (survives restarts,
   never shared between agents) and answers "held for approval".
2. When the model calls the same tool with the same arguments again, the gateway checks that escalation:
   - **approved** → claim the resume once at MetaMynd, run the tool, settle (the SDK's resume flow, including its
     request-mismatch and single-use checks);
   - **pending** → "held for approval" again;
   - **rejected or expired** → refused, journal entry removed.
3. Different arguments are a new request, decided afresh.
4. Optionally (`escalationWaitMs`, default 0, at most 30 s) it waits briefly for a decision. Several hosts give up on a
   tool call after about a minute ([hosts.md](hosts.md)), so every call is answered well within that.
5. Approval never relies on MCP elicitation: Claude Desktop does not document it, and some frameworks re-run the tool
   when an elicitation resumes.

**Prerequisite:** the signer daemon must gain a `sign-resume-claim` operation. Without it, a resume signed with a
daemon-held key is not claimed at MetaMynd, so two processes could resume one approval. This lands in
`@metamynd/agentsafe-signer` before the gateway ships held requests.

### 3.4 Upstreams that are themselves governed (later)

If an upstream server runs `agentsafe-mcp-guard`, the gateway can pass the signed request in the call's `_meta` and
settle in delegated mode, so the request is checked at both ends.

## 4. Configuration

### 4.1 `mcp-gateway.json`

```jsonc
{
  "agentConfig": "./agent.metamynd.json",          // the agent's identity; its key stays in the signer daemon
  "upstreams": {
    "payments": {                                   // a local stdio server …
      "command": "npx", "args": ["-y", "<payments-mcp-package>@<version>"],
      "env": { "API_KEY": "keychain:payments-api-key" }   // required: the gateway holds the credential (decision 2)
    },
    "crm": {                                        // … or a remote one
      "url": "https://crm.example.com/mcp",
      "headers": { "Authorization": "Bearer ${CRM_TOKEN}" }
    }
  },
  "tools": {
    "payments.create_payment": {
      "action": "payment.create",
      "amount": "amount", "currency": "currency", "merchant": "payee",
      "allowedArgs": ["amount", "currency", "payee", "reference"],
      "context": { "riskLevel": "medium" },
      "schemaHash": "sha256:…"                      // pinned tool definition (§6, T4)
    },
    "crm.lookup_customer": { "action": "records.read", "allowedArgs": ["customerId"], "schemaHash": "sha256:…" }
  }
}
```

- Value fields name tool arguments (dotted paths for nested ones). A read maps none.
- Secrets come from `keychain:<name>` (the OS keychain) or `${VAR}` (the environment); never written in the file.
- The gateway refuses to start if an upstream has no credential configured.

### 4.2 Drafting the mapping

`npx @metamynd/mcp-gateway init` connects to each upstream, reads `tools/list`, and drafts a mapping for **every**
tool (decision 4):

- tools annotated `readOnlyHint: true` are drafted as reads;
- arguments named like `amount` / `currency` / `payee` / `merchant` are drafted as value fields;
- each draft entry carries `"review": true`, and the gateway won't start until all are reviewed.

Annotations come from the upstream server, so they only shape the draft; they are never trusted at run time. For
non-technical users the same draft is produced and reviewed in the MetaMynd dashboard (§5.1).

## 5. Hosts

The gateway speaks standard MCP, so any MCP client can use it. What differs is **transport** and **installation**.
What each phase-1 host actually does — config files, name and tool-count limits, timeouts, secrets — is in
**[hosts.md](hosts.md)** (phase 0). The gateway is built on the MCP TypeScript SDK v2 (`@modelcontextprotocol/server`,
`@modelcontextprotocol/client`) and must work with hosts on both spec revisions 2025-11-25 and 2026-07-28 while they
move to the latter.

| Host family | Examples | Transport | How a user installs it | Phase |
|---|---|---|---|---|
| Desktop chat apps | Claude Desktop | stdio | **One-click extension** (`.mcpb`): asks for the agent file and the tool credentials, stored in the OS keychain | 1 |
| Coding assistants / IDEs | Claude Code, Cursor, VS Code (Copilot agent mode), Windsurf, Zed, Cline | stdio | A generated snippet per host | 1 |
| Agent frameworks | OpenAI Agents SDK, LangGraph / LangChain (`langchain[mcp]`), CrewAI, Google ADK, Microsoft Agent Framework, LlamaIndex, Mastra, Vercel AI SDK, Pydantic AI | stdio or HTTP | Point the framework's MCP client at the gateway — configuration, no governance code | 1 |
| Hosted chat products | ChatGPT (connectors / apps), Claude.ai custom connectors, Microsoft Copilot Studio | **remote HTTPS only** | A **self-hosted** gateway URL with OAuth sign-in | 3 |
| Workflow tools | n8n and others with an MCP client step | HTTP | A self-hosted gateway URL | 3 |

- **Language-neutral.** The gateway is its own process, so Python and other frameworks use it as-is.
- **Hosted products need a server the customer runs** (decision 3): they can't start a local process, and MetaMynd
  won't host one.

### 5.1 Non-technical setup (decision 1)

1. In the MetaMynd dashboard, on the agent's page: **Connect to Claude Desktop** (and other hosts).
2. Add the tools: pick each MCP server and review the drafted mapping in plain language ("*Create payment* — counts
   against the spending limit; *Look up customer* — read-only").
3. Download the extension (or, for other hosts, copy the generated snippet). The snippet always pins a scoped version:
   `npx -y @metamynd/mcp-gateway@x.y.z`.
4. Install: double-click the extension; enter each tool's API key when asked. Keys go to the OS keychain.
5. Restart the app and use it as before. Allowed calls just work; refusals and held requests are explained in the
   chat; everything appears in the MetaMynd activity log.

## 6. Threat model

The gateway is trusted on the user's side: it signs as the agent and decides whether to forward.

| # | Threat | Mitigation |
|---|---|---|
| T1 | The model reaches the upstream another way | Upstream credentials live only in the gateway (decision 2). Setup tells users to remove the server from the host's own config; a server still configured directly is ungoverned. |
| T2 | Prompt injection talks the model past a limit | MetaMynd enforces the mandate; the model's wording is irrelevant. |
| T3 | The model reads the agent's key | Key in the signer daemon or OS keychain; never in a file a filesystem tool can read or in an environment variable the host exposes. `init` warns about a plaintext key. |
| T4 | An upstream renames a tool, changes its schema or poisons its description | Mapping keyed by upstream + tool; `schemaHash` pins the definition, and a changed tool is withheld until re-approved. |
| T5 | Argument smuggling | Only `allowedArgs` accepted; value fields type-checked; the decision is bound to the exact arguments. |
| T6 | A retry executes twice | Authorizations are single-use; a resume is claimed once at MetaMynd (§3.3 prerequisite); journals are per agent. |
| T7 | MetaMynd unreachable | Fail closed: refused `GATE_UNREACHABLE`; the upstream is not called. |
| T8 | Supply chain of the gateway | Scoped, pinned package; few dependencies (the MCP SDK and MetaMynd's own SDKs); published from this public repository with npm provenance. |
| T9 | Someone else calls a remote gateway | Remote mode requires authorization (OAuth, or a bearer token for internal use) and TLS. It runs on the customer's own infrastructure (decision 3). |

Out of scope: governing the person. The owner can change their own setup; MetaMynd stops the *agent* exceeding the
authority the owner granted.

## 7. Deployment modes

| Mode | Runs where | Serves | Notes |
|---|---|---|---|
| **Local** (phase 1) | the user's machine, started by the host over stdio | desktop apps, IDEs, local frameworks | Keys and credentials never leave the machine. One agent per instance. |
| **Self-hosted remote** (phase 3) | the customer's server or container (Docker image) | hosted chat products, workflow tools, team setups | Streamable HTTP, TLS, OAuth per the MCP authorization spec. |

There is no MetaMynd-hosted mode (decision 3).

## 8. What changes where

| Area | Change |
|---|---|
| **This repository** | The gateway: MCP server, upstream clients, mapping, settlement, journal, `init` and `config --host` commands, the Claude Desktop extension, its own CI and npm release. Depends on the published `@metamynd/*` SDKs from npm. |
| `@metamynd/agentsafe-signer` | Add `sign-resume-claim` (§3.3). |
| `@metamynd/agentsafe-guard` | Export the payload-binding helpers (today re-exported only by `agentsafe-mcp-guard`). |
| MetaMynd dashboard | "Connect to …" on the agent page: tool picker, mapping review, extension download, per-host snippets. Display and onboarding only. |
| MetaMynd docs | Overview, per-host setup, mapping reference. |

The MetaMynd gate, mandates, evidence and APIs are unchanged.

## 9. Phases

| Phase | Scope | Done when |
|---|---|---|
| 0 | Spikes: each phase-1 host's transport, tool-name limits, timeouts and error display; `.mcpb` packaging; `sign-resume-claim` in the signer | **Done 2026-10-14:** [hosts.md](hosts.md); `sign-resume-claim` in `@metamynd/agentsafe-signer` 0.23.0 (released with the next MetaMynd tag) |
| 1 | Local gateway; held requests and resume; `init`; the **Claude Desktop extension**; dashboard "Connect to …"; snippets for Claude Code, Cursor, VS Code; OpenAI Agents SDK and LangGraph | A non-technical user reaches a first governed action in < 5 minutes from the dashboard alone; the bypass tests show no upstream execution without an allow |
| 2 | More hosts' snippets and guides (Windsurf, Zed, Cline, CrewAI, ADK, …) | Each listed host has a tested guide |
| 3 | Self-hosted remote mode: Streamable HTTP, OAuth, Docker image | ChatGPT and one workflow tool governed through a customer-run gateway |
| 4 | Delegated chaining with `agentsafe-mcp-guard` upstreams; several agents per remote gateway | — |

## 10. Testing

- **Unit:** mapping and argument checks, settlement rules, journal, schema pinning, every refusal path.
- **Conformance (CI):** a fake upstream MCP server and a mock MetaMynd gate; the gateway driven by real headless MCP
  clients (the MCP SDK client, Claude Code, the OpenAI Agents SDK, LangGraph), asserting identical verdicts across all
  of them.
- **Adversarial:** prompt-injected over-limit calls, argument smuggling, renamed or changed tools, replayed retries,
  MetaMynd unreachable.
- **GUI hosts:** a manual release checklist (Claude Desktop, Cursor, VS Code) with screenshots for the guides.
