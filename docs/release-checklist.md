# Release checklist: desktop apps

Automated checks cover the gateway itself (`npm run check`), the catalog against the real servers
(`npm run catalog:verify`) and the framework clients (`npm run conformance`: the MCP TypeScript SDK, the OpenAI Agents
SDK in JavaScript and Python, and LangChain / LangGraph). Desktop apps can't be driven headless, so before each release
a person runs this list on at least one computer, and on Windows and macOS for a minor release. Take a screenshot at each
**[shot]**; they go into the docs pages.

Use a **test agent** with a test mandate and a **test workspace** for the tool (a Notion workspace with one test page is
enough). Never a real customer's.

## 0. Before you start

- [ ] The release's npm version and its GitHub release (with the `.mcpb` base bundle and `.sha256`) both exist.
- [ ] The MetaMynd dashboard you test against pins this version (`GATEWAY_VERSION` in the backend).
- [ ] The test agent's mandate grants `notion-read` only; `notion-write` is **not** granted.
- [ ] The Notion integration has only *Read content*, *Read comments* and *Read user information without email
      addresses*, and is connected to the one test page.

## 1. Claude Desktop: the timed first action (phase 1 "done when")

Start a timer when you open the agent's page; stop it when the first governed call returns. Target: **under 5 minutes**,
using only the dashboard and Claude Desktop.

- [ ] **Connect to an AI app**, Claude Desktop. Tick *Search pages and databases by title*. No grant is asked for.
      **[shot]**
- [ ] Build, download, open the `.mcpb`. Claude Desktop shows "MetaMynd: <agent>" and asks for exactly *Agent key*
      and *Notion integration token*, both hidden as you type. **[shot]**
- [ ] If Notion was already connected to Claude Desktop another way, remove it (the dashboard's step says so).
- [ ] Ask Claude to search Notion for the test page. It finds it. **[shot]** Time: ____
- [ ] The call appears in the agent's governance activity as allowed.

## 2. Claude Desktop: what must be refused or held

- [ ] Ask Claude to add a line to the test page. The tool isn't listed (not picked), so Claude says it can't.
- [ ] Rebuild with *Add content to a page or block* ticked: the dashboard asks to **grant `notion-write`** and won't
      build until it is granted. Grant it, rebuild, reinstall.
- [ ] Revoke the `notion-write` mandate on the agent's page. Ask Claude to add a line: the call is refused with
      `MANDATE_REVOKED` (or `NO_MANDATE`), explained in the chat, and the page is unchanged. **[shot]**
- [ ] Contain the agent. Any call is refused. Reinstate it afterwards.
- [ ] With an approval rule on the agent, a call is answered "held for approval"; approve it in the dashboard, ask
      again with the same request, and it runs once. **[shot]**

## 3. Cursor

- [ ] **Connect to an AI app**, Cursor. Download the folder, unzip it, run each `secret set` command shown (the value
      is hidden as you type). **[shot]**
- [ ] Enter the folder; paste the snippet into `.cursor/mcp.json`; restart Cursor. The `metamynd` server shows its tools
      as governed (the description says so). **[shot]**
- [ ] A search works; an over-limit or ungranted call is refused with its reason in the chat.
- [ ] The folder holds no key: `mcp-gateway.json` names `keychain:` references only, and `agent.metamynd.json` has no
      `agentKey`.

## 4. VS Code (Copilot agent mode)

- [ ] Same as Cursor, with the snippet in `.vscode/mcp.json` (`servers`, not `mcpServers`). **[shot]**
- [ ] VS Code asks before running a tool that changes something, and doesn't for a read: the hints come from the
      reviewed `effect`, not from the server.

## 5. After

- [ ] Remove the extension and the IDE entries; delete the keychain items (`mm-<agent>-…`).
- [ ] Revoke the test agent's grants if they are no longer needed.
- [ ] Record the timed result and the date in the release notes. File anything that didn't match as an issue.
