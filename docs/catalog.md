# The catalog

`catalog/<id>.json` holds MCP servers MetaMynd has reviewed, so a non-technical owner can connect them from the MetaMynd
dashboard without drafting or reviewing a mapping themselves (decision 1). The dashboard turns the tools an owner picks
into a gateway config (`configFromCatalog` in `src/catalog.mjs`) and a Claude Desktop extension. MetaMynd never sees the
tools' credentials: they are entered at install, in Claude Desktop (decision 3).

## An entry

| Field | Meaning |
|---|---|
| `id` | The upstream name (`<id>__<tool>` is what apps see); the file is `catalog/<id>.json`. |
| `server` | The npm `package` and its **exact** `version`; the gateway runs `npx -y <package>@<version>`. |
| `credentials` | Each credential the server needs: `env` (how the server reads it), `title` and `description` for the owner. |
| `actions` | The mandate actions this entry's tools use, each described for the owner granting it. |
| `probeEnv` | Dummy credentials that let CI start the server and list its tools — never real ones. |
| `reviewed` | Who reviewed it, and when. |
| `tools` | Every tool the server offers: `summary` (plain language), `action`, `effect` (`read` / `write` / `destructive`), `allowedArgs`, value fields (`amount`, `currency`, `merchant`) for tools that move money, `context.riskLevel`, and the pinned `schemaHash`. |
| `serviceSetup` | Optional. The service's own permissions to set on the credential: `title`, `where` they are set, `scope` (which data to share with it), and `byAction`, the minimum permissions each action's tools need. Every action must be listed. The dashboard and `mcp-gateway extension` show the ones the picked tools need. |

## Rules

- **Least privilege at the source too.** The gateway decides each call, but the credential is the outer fence: if anything
  upstream were misconfigured, or the credential leaked, the service's own permissions are what remain. An entry's
  `serviceSetup` says which permissions each action needs, so an owner who only grants reads creates a read-only credential.

- **Every tool is reviewed by a person.** The server's own annotations are suggestions: Notion marks its search
  "destructive" (it only reads), and a server could mark a payment "read-only". The reviewer decides.
- **Exact versions only.** A new server version is a new review.
- **CI checks the pins.** `npm run catalog:verify` installs each pinned server in an empty directory, lists its tools
  with the dummy credentials, and fails if any tool changed, vanished or appeared unreviewed. It runs on every catalog
  change and weekly (`.github/workflows/catalog.yml`).
- **Servers that list tools only with a real key** (such as Stripe's, which proxies to Stripe's hosted server) need a
  test-mode key in CI before they can be listed.

## Adding a server

```bash
node scripts/catalog-draft.mjs <id> <package> <exact-version> ENV_NAME=dummy-value   # prints a draft entry
```

Review every tool (summary, action, effect, risk), write `catalog/<id>.json`, then `npm test` and
`npm run catalog:verify <id>`.
