# Repository Guidelines

## Project Structure & Module Organization

This repository is a TypeScript MCP gateway that exposes one HTTP MCP endpoint and forwards tool calls to configured upstream MCP servers. The deployed Docker service is expected at `http://maya.casa:20001/mcp`, with health checks at `http://maya.casa:20001/health`. Source code lives in `src/`: `server.ts` owns the Express/Streamable HTTP entrypoint, `gateway.ts` manages upstream MCP clients and tool routing, and `config.ts` validates `servers.json` with Zod. Runtime configuration is in root `servers.json`; keep `src/servers.json` aligned only if it is intentionally used by a build or image flow. Docker assets are `Dockerfile`, `docker-compose.yml`, and the SonarQube wrapper files at the repo root.

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

Treat `servers.json`, bootstrap env files, Docker socket access, and mounted home directories as sensitive. Do not add tokens or private host details unless they are required and already managed through the repository’s deployment process.
