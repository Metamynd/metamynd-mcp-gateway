# Releasing

Pushing a version tag publishes `@metamynd/mcp-gateway` to npm (`.github/workflows/release.yml`).

1. In a pull request, set `version` in `package.json` (semver; the CLI pins it in every snippet and extension it
   generates). Merge it once CI is green, keeping MetaMynd as author and committer (fast-forward `main` to the branch).
2. Tag that commit and push the tag, as MetaMynd:
   ```bash
   git -c user.name=MetaMynd -c user.email=noreply@metamynd.ai tag -a v0.1.0 -m "v0.1.0"
   git push origin v0.1.0
   ```
3. The workflow checks the tag matches `package.json`, the package is not private and not already published, runs
   typecheck and tests, shows what will be packed, builds the **base bundle**, publishes, and creates the GitHub
   release with `metamynd-mcp-gateway-<version>.mcpb` and its `.sha256`.

The base bundle is the gateway, its production dependencies and the catalog, under a manifest that names no agent. The
MetaMynd dashboard downloads it once per gateway version, checks the SHA-256, and composes each agent's Claude Desktop
extension from it (`composeExtension`): no install and no network per request, and nothing secret inside.
`mcp-gateway extension --base <file>` does the same locally.

4. Before announcing it, a person runs the **[release checklist](release-checklist.md)** in Claude Desktop, Cursor and
   VS Code (they can't be driven headless), including the timed first action.

## npm authentication

- **Trusted publishing** (the normal case): no stored token. Configured once on npmjs.com →
  `@metamynd/mcp-gateway` → Settings → Trusted publishing → GitHub Actions: organization `Metamynd`, repository
  `metamynd-mcp-gateway`, workflow `release.yml`, environment `npm`. Provenance is attached automatically (the
  repository is public).
- **`NPM_TOKEN` (or `NPM`) secret** (the first release only — npm allows trusted publishing only once a package exists): a
  granular token with read and write on `@metamynd` and "Bypass two-factor authentication". The workflow uses it while
  the secret exists. **Delete the secret once trusted publishing is configured**, so no token can expire or leak.
