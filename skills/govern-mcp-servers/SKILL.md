---
name: govern-mcp-servers
description: Put the MCP servers an AI app uses behind the MetaMynd MCP Gateway, so that every tool call is allowed, refused or held for a person before it runs. Use when the user wants limits, approvals or an audit trail on MCP tools in Claude Desktop, Claude Code, Cursor, VS Code, LangChain or the OpenAI Agents SDK, or asks to set up the MetaMynd gateway.
---

# Govern MCP servers with the MetaMynd gateway

`@metamynd/mcp-gateway` sits between an AI app and its MCP servers. The app connects to the
gateway. The gateway holds the tools' credentials and checks each call against the agent's mandate.
It is a developer preview and needs Node 22 or later.

Work through these steps in order. Credentials and tool reviews belong to the user: help them, but
do not do either on their behalf.

## 1. List what is connected

Find the MCP servers the app uses now and show them to the user, with the credential each one needs.
Agree which to put behind the gateway.

Notion, HubSpot and Brave Search have reviewed, version-pinned entries in the `catalog/` folder of
this repository. Prefer those exact package versions when the user picks one.

## 2. Get an agent identity

The gateway needs an `agent.metamynd.json`, from the MetaMynd dashboard or from
`npx create-metamynd-agent`. The user does the sign-in themselves. **That file can hold the agent's
secret key:** confirm it is in `.gitignore`, never print it, and never commit it.

## 3. Store each credential

Ask the user to run this themselves for each one, so the value never appears in the conversation:

```bash
npx @metamynd/mcp-gateway secret set payments-api-key
```

Never ask for a credential in chat, and never write one into a file.

## 4. Write `mcp-gateway.json`

Credentials are references only: `keychain:<name>` or `${VAR}`.

```json
{
  "agentConfig": "./agent.metamynd.json",
  "upstreams": {
    "payments": {
      "command": "npx",
      "args": ["-y", "<payments-mcp-package>@<exact-version>"],
      "env": { "API_KEY": "keychain:payments-api-key" }
    }
  },
  "tools": {}
}
```

The gateway refuses to start if an upstream has no credential configured.

## 5. Draft the mapping, then have a person review it

```bash
npx @metamynd/mcp-gateway init --config mcp-gateway.json
```

This drafts an entry for every tool on every server and marks each one `"review": true`. The
gateway will not start until every flag is removed.

Go through the entries with the user, one tool at a time, and for each one show:

- what the tool does, and the `action` it maps to, which must be one the mandate grants;
- the `effect`. The drafts come from the server's own annotations, which may be wrong;
- `allowedArgs`, kept to what the tool needs;
- `amount`, `currency` and `merchant`, which must name the real arguments on anything that moves money.

Remove a `review` flag only after the user has confirmed that tool. **Never remove the flags in
bulk, and never to get the gateway to start.** A tool the user does not want should be taken out of
the agent's reach rather than approved unread.

## 6. Connect the app

For Claude Desktop, build a one-click extension. Nothing secret goes inside it; Claude Desktop asks
for each credential at install.

```bash
npx @metamynd/mcp-gateway extension --config mcp-gateway.json --name "Accounts Payable"
```

For anything else, print the snippet. `--host` takes `claude-desktop`, `claude-code`, `cursor`,
`vscode`, `openai-agents-python`, `openai-agents-js` or `langchain`.

```bash
npx @metamynd/mcp-gateway config --host cursor --config mcp-gateway.json
```

## 7. Remove the direct route

A server the app can still reach directly is not governed. Delete each governed server's own entry
from the app's MCP settings, including any extension or connector for it. Disconnecting it is not
enough. Confirm this with the user before you finish.

## 8. Check it

Make one call the mandate allows and one it does not, and show the user both results. A call that
needs a person returns at once as held, and does not block the app while it waits.

## 9. Tell the user what this does not cover

- The gateway only governs traffic that goes through it, which is why step 7 matters.
- The credential is the outer fence. Give each one only the permissions its tools need, at the service itself.
- The allow or refuse decision comes from the hosted MetaMynd gate. MetaMynd never holds the tools' keys.
- This is a developer preview.

Documentation: https://github.com/Metamynd/metamynd-mcp-gateway
