# Remote mode: the gateway over HTTPS, on your own server

**Status:** developer preview, added for Grok Bot (owner decision 2026-11-17, which partly lifts the phase 3 hold for
Grok Bot; [design.md](design.md) §9). OAuth is not built yet; access is by bearer token.

Some AI apps can't start a local process; they connect to a URL. Grok Bot's **Remote HTTPS** connectors and hosted chat
products are like this. Remote mode serves the gateway's governed tools over MCP Streamable HTTP. Nothing about
governance changes: the same mapping, the same checks, every call decided at the MetaMynd gate, and the same held
requests.

**It runs on your server, never MetaMynd's** ([design.md](design.md), decision 3). The tools' credentials and the agent's
key stay on that server.

## Why remote, for Grok Bot

A Grok Bot **Command** connector runs on the Bot's own cloud computer. That computer is shared by all of the user's
Bots, and the Bot's shell can run as root there. So a gateway started that way keeps its credentials where the AI can
read them. The AI could then use the service directly, without MetaMynd (threat T1).

With remote mode, the Bot's computer holds only a revocable access token. The credentials are on your server. Tool calls
through the gateway are enforced, provided the services' credentials exist nowhere else the Bot can reach.

## Set it up

1. **Prepare the folder** as for any gateway: `mcp-gateway.json`, the agent file, the reviewed mapping
   ([design.md](design.md) §4). On a server there is usually no OS keychain, so reference credentials as `${VAR}` and
   pass the agent's key in `MCPGW_AGENT_KEY` (or `"agentKey": "${…}"`).
2. **Create one access token per app installation:**
   ```bash
   mcp-gateway token create --label "grok-bot: alice" --state-dir /srv/mmgw/state
   ```
   The token is printed once, on stdout; only its SHA-256 hash is kept (`http-tokens.json` in the state directory).
   Give it to the app, not to the AI: put it in the connector's HTTP header field, never in a chat or a prompt.
3. **Start it,** with TLS in the process or behind a TLS-terminating proxy:
   ```bash
   mcp-gateway serve --http --host 0.0.0.0 --port 8787 --tls-cert cert.pem --tls-key key.pem --config mcp-gateway.json --state-dir /srv/mmgw/state
   mcp-gateway serve --http --host 0.0.0.0 --behind-tls-proxy --config mcp-gateway.json --state-dir /srv/mmgw/state
   ```
   It refuses to start with plain HTTP on anything but a loopback address, and refuses to start with no active token.
4. **Add it to the app.** In Grok Bot: *Add a custom connector → Remote HTTPS*:
   - **Server URL:** `https://<your host>/mcp`;
   - **HTTP header:** `Authorization: Bearer <token>`.

   A server on a private network, or behind a private certificate authority, asks the user to approve it.
5. **Remove any direct connection** to the same services from the app (T1), and give each service's credential only the
   permissions its tools need ([design.md](design.md), decision 8).

To **revoke**, run `mcp-gateway token list`, then `mcp-gateway token revoke <id>`. A running gateway refuses the token
from its next request; no restart is needed.

### Docker

The [Dockerfile](../Dockerfile) runs as a non-root user and keeps its state in a volume. On its own, the default command
stops with the reason: you must choose TLS or `--behind-tls-proxy`.

```bash
docker build -t metamynd-mcp-gateway .
docker run --rm -v mmgw-state:/home/node/.metamynd metamynd-mcp-gateway token create --label grok-bot
docker run -d -p 127.0.0.1:8787:8787 -v mmgw-state:/home/node/.metamynd -v "$PWD/agent:/config:ro" -e MCPGW_AGENT_KEY -e NOTION_TOKEN \
  metamynd-mcp-gateway serve --http --host 0.0.0.0 --behind-tls-proxy --config /config/mcp-gateway.json
```

- **Publish the port on `127.0.0.1` only,** with the TLS proxy on the same host. `--behind-tls-proxy` is your word that
  a proxy is in front, and the gateway can't check it. Published on all interfaces, tokens would also be reachable
  in plain text.
- **Use a named volume** for the state. A bind-mounted folder owned by root can't be written by the image's `node`
  user, so `token create` fails until you `chown 1000:1000` it.
- **The health check** calls `MCPGW_HEALTH_URL` (default `http://127.0.0.1:8787/healthz`). Set it if you change
  `--port`, or serve TLS inside the container.

Upstreams started with `npx` download their package on first start. Pin exact versions, and allow for the time (or bake
the packages into your own image).

## What the front door does

| Check | Behaviour |
|---|---|
| Access token | Every request to `/mcp` needs `Authorization: Bearer mmgw_…`. Without a valid, unrevoked token: `401`, and nothing is parsed or asked of MetaMynd. Tokens are compared by hash, in constant time. |
| Failed sign-ins | More than 20 a minute from one client address, or 1,000 from all addresses together, get `429`. The address is the connection's own; `X-Forwarded-For` is never trusted. Behind a proxy every client shares one address, so **rate-limit at the proxy too**. A valid token is never held back by these. |
| Rate limit | 120 MCP requests a minute per token, then `429` with `Retry-After`. At most 16 requests or streams open at once per token. |
| Body size | Over 1 MiB: `413`, before anything is parsed, and the connection is closed. |
| Connections | Headers within 15 s, a request within 60 s, idle keep-alive 5 s, at most 1,000 connections and 100 headers. |
| Browser origins | A request with an `Origin` header is refused (`403`) unless that origin is passed with `--allowed-origin`. This guards against DNS rebinding. |
| TLS | Plain HTTP only on loopback (for testing), or with `--behind-tls-proxy`. TLS 1.2 or newer in-process. |
| Health | `GET /healthz` answers `200` with no token and reveals nothing. |
| Headers | `Authorization`, `Cookie`, `Host` and the framing headers are not passed further in. The URL handed to the MCP handler never comes from the client's `Host`. |
| Token file | `token create` and `token revoke` take an exclusive lock, so two at once can't undo each other. |

**One agent per instance.** Every token on an instance acts as the same MetaMynd agent, so they share its mandate and
its evidence. Use one instance per agent. Two Grok Bots of one user that should be told apart need two instances, each
with its own agent and token. Grok Bot itself sends no per-Bot identity.

## Not yet

- **OAuth** per the MCP authorization spec, for apps that only offer OAuth sign-in. Grok Bot accepts a header, so the
  token is enough for it.
- **Several agents on one instance** (phase 4).
- **Delegated chaining** to an upstream that runs `agentsafe-mcp-guard` (design §3.4), so the service re-verifies each
  call itself.
