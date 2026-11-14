# Repository Guidelines

## Project Structure & Module Organization

This repository is a TypeScript MCP gateway that exposes one HTTP MCP endpoint and forwards tool calls to configured upstream MCP servers. The deployed Docker service is expected at `http://maya.casa:20001/mcp`, with health checks at `http://maya.casa:20001/health`. Source code lives in `src/`: `server.ts` is the bootstrap (env parsing, listen, signal handling), `app.ts` owns the Express/Streamable HTTP app and MCP sessions (`createApp`), `gateway.ts` manages upstream MCP clients and tool routing, `config.ts` validates `servers.json` with Zod, and `version.ts` reads the version from `package.json`. Runtime configuration is in root `servers.json` (the only copy). Docker assets are `Dockerfile`, `docker-compose.yml`, and the SonarQube wrapper files at the repo root.

## Runtime Behavior

- **Sessions**: a request with an unknown `mcp-session-id` gets HTTP 404 so clients re-initialize (for example after a gateway restart); a transport is created only for an `initialize` request; closed or deleted sessions are released.
- **Tool list changes**: the gateway declares `tools.listChanged` and sends `notifications/tools/list_changed` to every live session when an upstream registers or drops tools.
- **Upstream liveness**: each connected upstream is pinged every `pingIntervalMs` (per server in `servers.json`, default 30000). A failed ping marks it disconnected, drops its tools and starts the reconnect loop. This is what detects HTTP upstreams that restart.
- **Name collisions**: when two servers resolve to the same tool name, the server listed first in `servers.json` owns it; the other server reports the name under `skippedTools` in `/health` and `/catalog`.
- **Config validation**: duplicate server names and `container` on a non-`stdio` server are rejected at startup; a duplicate `prefix` only logs a warning.
- **Shutdown**: `SIGTERM`/`SIGINT` close the HTTP server, the sessions and every upstream client. The compose files set `init: true` so the signal reaches the process.

## Build, Test, and Development Commands

- `pnpm install --frozen-lockfile`: install dependencies from `pnpm-lock.yaml`.
- `pnpm dev`: run `src/server.ts` with `tsx` for local development.
- `pnpm build`: compile TypeScript into `dist/`.
- `pnpm start`: run the compiled server from `dist/server.js`.
- `pnpm typecheck`: run TypeScript checks without emitting files.
- `pnpm test`: run Vitest in non-watch mode.
- `docker compose up --build`: build and run the gateway container on port `20001`.
- `curl http://maya.casa:20001/health`: verify the deployed Docker gateway is responding.
- `curl http://maya.casa:20001/catalog`: inspect connected MCP servers and published tools.

## Coding Style & Naming Conventions

Use strict TypeScript with ES modules and explicit `.js` extensions in relative imports, matching the existing NodeNext setup. Prefer 2-space indentation, `const` by default, typed interfaces for shared shapes, and Zod schemas for external configuration. Keep names descriptive: classes in `PascalCase`, functions and variables in `camelCase`, constants in `UPPER_SNAKE_CASE` for fixed runtime settings. `.npmrc` uses `node-linker=hoisted` so installs work reliably on the SMB-backed NAS checkout.

## Testing Guidelines

Vitest is the configured test runner. Add tests beside the relevant module as `*.test.ts` or under a future `src/__tests__/` directory. Focus coverage on config validation, tool-name resolution, timeout/error behavior, and HTTP session handling. Run `pnpm test` and `pnpm typecheck` before opening a pull request.

## Commit & Pull Request Guidelines

History currently uses concise, imperative commit subjects, for example `Initial commit: unified MCP gateway`. Continue with short subjects that describe the change and scope. Lefthook blocks direct commits on `main`, `master`, and `develop`, and runs `gitleaks protect` on staged content, so work from feature branches and avoid committing secrets. Pull requests should include a brief summary, linked issue or motivation, testing performed, and any configuration or Docker deployment impact.

## Security & Configuration Tips

Authentication is opt-in and off by default. Set `GATEWAY_TOKEN` to require `Authorization: Bearer <token>` on `/mcp` and `/catalog`; `/health` stays open but returns only `status` and `tools` to unauthenticated callers. Set `GATEWAY_ALLOWED_HOSTS` (comma separated) to restrict the `Host` header on `/mcp`; matching is exact and includes the port, for example `maya.casa:20001,127.0.0.1:20001`. Every MCP client must be updated with the header before the token is enabled.

Treat `servers.json`, bootstrap env files, Docker socket access, and mounted home directories as sensitive. Do not add tokens or private host details unless they are required and already managed through the repository’s deployment process.
