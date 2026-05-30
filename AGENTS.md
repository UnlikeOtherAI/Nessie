# Nessie Agent Standards

## Workflow

- Work directly on `main`. Never create branches or PRs.
- Commit and push to `main` after every turn. No exceptions. If there is nothing to commit, skip.
- Rebuild the admin (`pnpm --filter @nessie/admin build`) after every turn where admin code changed.
- Rebuild the worker (`pnpm --filter @nessie/worker build`) after every turn where worker code changed: in local mode the API runs the worker embedded from its built `dist`, so source edits don't take effect until rebuilt and the API restarts.
- After every build or server restart, verify the new version is actually running: check the process is up, hit a health endpoint, or confirm the expected log output appears.
- Package manager: **pnpm**.

## Code Quality

- Strict linting. Builds must not pass without all lints passing.
- No patches on patches. No fallbacks unless required by functionality. Diagnose and fix root causes.
- Before reusing code that hasn't been reused before: pause, plan a refactor, execute it maintaining best architectural practices, then reuse.

## Verification

- Every UI change must be visually verified using kelpie before considering the work complete.
- Run `kelpie "http://localhost:5555/<path>"` to screenshot the affected page and confirm the feature renders correctly.
- Use Playwright (`mcp__plugin_playwright`) only as a fallback if kelpie cannot be launched. Always run Playwright headless unless the user explicitly requests otherwise.
- This applies to all frontend work: new components, layout changes, styling fixes, and interaction flows.

## Architecture

- All standards, specs, and design decisions live in `docs/`.
- When a document is finished, move it to `docs/done/`.
- Legacy code lives in `src/`. New code goes into `api/`, `admin/`, `web/`, `worker/`, `packages/`.
- Do not import from `src/` in new code. All reusable concepts must be re-implemented in `packages/`.
- Follow the provider system and frontend architecture in `docs/provider-system-and-frontend-architecture.md`.
- Follow the implementation phases in `docs/implementation-phases.md`.
