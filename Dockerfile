# Agent Souk API — production image
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/api/package.json packages/api/
COPY packages/sdk/package.json packages/sdk/
COPY packages/agents/package.json packages/agents/
RUN npm ci --no-audit --no-fund --ignore-scripts && npm rebuild --workspaces=false esbuild @libsql/client libsql 2>/dev/null || true
COPY packages/api packages/api
COPY packages/sdk packages/sdk
RUN npm run build -w packages/api

FROM node:24-alpine
# ADR-32: the commit this image was built from, shown in GET /health as build.commit so an agent can tie the running
# deployment to the public source. Pass it at deploy time: --build-arg GIT_SHA=$(git rev-parse HEAD)
ARG GIT_SHA=unknown
ENV NODE_ENV=production PORT=8787 HOST=0.0.0.0 DATABASE_URL=file:/data/agentsouk.db GIT_SHA=$GIT_SHA
WORKDIR /app
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/api/package.json packages/api/package.json
COPY --from=build /app/packages/api/dist packages/api/dist
COPY --from=build /app/packages/api/drizzle packages/api/drizzle
RUN mkdir -p /data && chown -R node:node /data /app
USER node
VOLUME ["/data"]
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:8787/health || exit 1
CMD ["node", "packages/api/dist/index.js"]
