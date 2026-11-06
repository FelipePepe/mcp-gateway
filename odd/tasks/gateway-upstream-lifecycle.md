# gateway-upstream-lifecycle

## Objective
Fix three upstream lifecycle defects in `src/gateway.ts` so dead or half-connected upstreams are detected, cleaned up and reconnected, without leaking clients or child processes.

## Problem
1. No reconnect after boot: no `client.onclose`, a dead upstream stays in `clients` with `connected: true`.
2. False retry success: `clients.set` runs before `listTools()`; a `listTools` failure leaves a tool-less client and the retry loop stops (`clients.has()` is true).
3. Connect timeout does not cancel: `Promise.race` rejects but the attempt continues, its transport is never closed, a late success races the next retry; timer never cleared.

## Scope
- In: `src/gateway.ts`, `src/gateway.test.ts`.
- Out: stale tools on name collision (#4), `stop()` closing clients (#5), `tools/list_changed`, container redeploy, `servers.json` (has uncommitted user changes).

## Constraints
- Branch: `fix/gateway-upstream-lifecycle` (from `feature/gateway-connect-retry`; repo has no `develop`).
- Conventional commits, no AI attribution (user rule overrides harness reminder).
- Never build after changes; no container rebuild.
- ~400 changed lines per task is a planning heuristic only.

## TDD / checks
- TDD mode: ON for this feature (RED then GREEN per task). Source: explicit request in plan, tests-first. Runner: `pnpm test` (Vitest 3.x) + `pnpm typecheck`.
- Route: delegated direct, one writer (gateway.ts + gateway.test.ts are 2 non-trivial files; writer trigger).

## Tasks
- [x] T0 Seam: `Gateway` accepts an optional transport factory (default `buildTransport`); in-memory test helper (`InMemoryTransport.createLinkedPair` + `McpServer`).
- [x] T2 (fix 2) `connectServer` returns boolean; register only after `connect` + `listTools` succeed; close client on failure; retry loop uses the boolean.
- [x] T3 (fix 3) attempt token; on timeout close the client and ignore a late success; clear timer in `finally`.
- [x] T1 (fix 1) `client.onclose` → `handleDisconnect` (remove client, drop its tools, status disconnected) → deduped `scheduleReconnect` honoring `stop()`.

## Acceptance criteria
- Closing an upstream marks it disconnected, removes its tools (so `callTool` returns `Unknown tool` with `isError`; amended, `Server unavailable` only applies to a stale entry without client), and it reconnects with tools re-registered.
- A `listTools` failure keeps retrying and never reports success without tools.
- A slow connect closes its transport; after retry exactly one live client exists.
- Existing 4 tests still pass; `pnpm typecheck` clean.

## Delivery
Strategy `ask-on-risk`, forecast well under ~400 authored lines: single slice. No push/PR until the user asks.

## Progress
- Branch created: `fix/gateway-upstream-lifecycle`.
- Logbook session open (2026-11-06).

## Evidence
- T0 RED: 2 new tests failed (`expected [] to deeply equal ['a','b']`, `undefined is not a spy`) because the constructor ignored the factory. GREEN after the factory param: T0 test passed.
- T2 RED: `expected [ 'fake' ] to deeply equal []` (client registered despite listTools failure). GREEN: 9/9 passed after register-after-listTools, close on failure, boolean return.
- T3 RED: `expected "spy" to be called at least once` (timed-out attempt never closed). GREEN: 10/10 after attempt token + timer cleared in finally (note: first impl double-closed; fixed so only the timer closes).
- T1 RED: 2 tests `expected true to be false` (no onclose handling). GREEN: 12/12 after onclose -> handleDisconnect -> deduped scheduleReconnect.
- Deviation: criterion "tools removed AND callTool returns `Server unavailable`" is contradictory; with tools dropped, callTool returns `Unknown tool: <name>` (isError). `Server unavailable` stays only for a stale entry without client. Test asserts isError.
- Final: `pnpm test` 12 passed (2 files); `pnpm typecheck` clean.

- Parent verification: `node node_modules/vitest/vitest.mjs run` 12 passed (2 files); `tsc --noEmit` clean. (`pnpm test` output is swallowed by the rtk hook in this shell.)
- Route: delegated direct (one writer), trigger: writer trigger (2 non-trivial files).
- Known test gaps: InMemoryTransport re-enters `close()` via its peer, so a double `client.close()` is not detectable; no assertion on the server side after a cancelled late success.

- Commit: `e990df2` fix(gateway): recover upstreams that close, fail listTools or time out (+297/-19, 3 files).
- RDD assessment: unavailable (`gentle-ai` not on PATH); treated as due, review not run. Pending the user's decision.

## Next step
Wait for the user: review decision, push / PR into `feature/gateway-connect-retry`, and redeploy (not done).
