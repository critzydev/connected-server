# Session hub (server/api). Built from the REPO ROOT context so the canonical
# protocol package rides along (src/protocol.ts re-exports it by relative path):
#   docker build -f server/api/Dockerfile ../..
# Node 26 runs the TypeScript source directly — no build step.

FROM node:26-alpine

WORKDIR /app
COPY packages/protocol packages/protocol
COPY server/api/package.json server/api/
COPY server/api/src server/api/src

WORKDIR /app/server/api
RUN npm install --omit=dev --no-audit --no-fund

EXPOSE 8787
CMD ["node", "src/main.ts"]
