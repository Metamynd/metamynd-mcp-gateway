# The remote gateway (docs/remote.md), for the customer's own server. MetaMynd does not host it (docs/design.md,
# decision 3). The image refuses plain HTTP on a public address until you choose TLS in the container
# (--tls-cert/--tls-key) or say a TLS-terminating proxy is in front (--behind-tls-proxy).
#
#   docker build -t metamynd-mcp-gateway .
#   docker run --rm -v mmgw-state:/home/node/.metamynd metamynd-mcp-gateway token create --label grok-bot
#   docker run -d -p 127.0.0.1:8787:8787 -v mmgw-state:/home/node/.metamynd -v "$PWD/agent:/config:ro" \
#     -e MCPGW_AGENT_KEY -e NOTION_TOKEN \
#     metamynd-mcp-gateway serve --http --host 0.0.0.0 --behind-tls-proxy --config /config/mcp-gateway.json
#
# Publish the port on 127.0.0.1 only, with your TLS proxy on the same host: --behind-tls-proxy is your word that one is
# in front, and the gateway can't check it. With a different --port, or TLS in the container, set MCPGW_HEALTH_URL.

# node 22.23.3 on Alpine 3.24 (multi-arch index digest), pinned; Dependabot proposes updates.
FROM node:26.13.1-alpine3.24@sha256:6bd9ab43c0ec0190ca7b2d193906cb8b7edf6e7f4afa43ddeccd6452710bffb5

ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force
COPY src ./src
COPY catalog ./catalog
COPY LICENSE README.md SECURITY.md ./

# Not root. State (access-token hashes, the held-request journal) lives in a volume.
USER node
ENV HOME=/home/node
RUN mkdir -p /home/node/.metamynd/mcp-gateway
VOLUME ["/home/node/.metamynd"]
EXPOSE 8787
ENV MCPGW_HEALTH_URL=http://127.0.0.1:8787/healthz
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s \
  CMD ["node", "-e", "fetch(process.env.MCPGW_HEALTH_URL).then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]

ENTRYPOINT ["node", "/app/src/cli.mjs"]
# Deliberately incomplete: without TLS or --behind-tls-proxy this stops with the reason, rather than serve plain HTTP.
CMD ["serve", "--http", "--host", "0.0.0.0", "--config", "/config/mcp-gateway.json"]
