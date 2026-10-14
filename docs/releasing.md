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
   typecheck and tests, shows what will be packed, and publishes.

## npm authentication

- **Trusted publishing** (the normal case): no stored token. Configured once on npmjs.com →
  `@metamynd/mcp-gateway` → Settings → Trusted publishing → GitHub Actions: organization `Metamynd`, repository
  `metamynd-mcp-gateway`, workflow `release.yml`, environment `npm`. Provenance is attached automatically (the
  repository is public).
- **`NPM_TOKEN` secret** (the first release only — npm allows trusted publishing only once a package exists): a
  granular token with read and write on `@metamynd` and "Bypass two-factor authentication". The workflow uses it while
  the secret exists. **Delete the secret once trusted publishing is configured**, so no token can expire or leak.
