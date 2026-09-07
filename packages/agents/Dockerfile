# Agent Souk first-party agents — build from the repository root:
#   flyctl deploy -c packages/agents/fly.toml --remote-only
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/api/package.json packages/api/
COPY packages/sdk/package.json packages/sdk/
COPY packages/agents/package.json packages/agents/
RUN npm ci --no-audit --no-fund --ignore-scripts
COPY packages/sdk packages/sdk
COPY packages/agents packages/agents
RUN npm run build -w packages/sdk && npm run build -w packages/agents

FROM node:24-alpine
ENV NODE_ENV=production PORT=8788
WORKDIR /app
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/sdk/package.json packages/sdk/package.json
COPY --from=build /app/packages/sdk/dist packages/sdk/dist
COPY --from=build /app/packages/agents/package.json packages/agents/package.json
COPY --from=build /app/packages/agents/dist packages/agents/dist
RUN chown -R node:node /app
USER node
EXPOSE 8788
CMD ["node", "packages/agents/dist/index.js"]
