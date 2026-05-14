FROM golang:1.24-alpine AS engram-builder
COPY engram/ /src/engram/
RUN cd /src/engram && GOTOOLCHAIN=auto go build -o /usr/local/bin/engram ./cmd/engram/

FROM node:22-alpine AS builder

RUN npm install -g pnpm

WORKDIR /app

COPY mcp-gateway/package.json mcp-gateway/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --ignore-scripts

COPY mcp-gateway/tsconfig.json ./
COPY mcp-gateway/src/ ./src/
RUN pnpm build

# --- runtime ---
FROM node:22-alpine

RUN apk add --no-cache docker-cli
COPY --from=engram-builder /usr/local/bin/engram /usr/local/bin/engram

RUN npm install -g pnpm

WORKDIR /app

COPY mcp-gateway/package.json mcp-gateway/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod --ignore-scripts

COPY --from=builder /app/dist ./dist
COPY mcp-gateway/servers.json ./

CMD ["node", "dist/server.js"]
