# Nessie Agent Standards

## Workflow

- Work directly on `main`. Never create branches or PRs.
- Commit and push to `main` after every turn. No exceptions. If there is nothing to commit, skip.
- Rebuild the admin (`pnpm --filter @nessie/admin build`) after every turn where admin code changed.
- Package manager: **pnpm**.

## Code Quality

- Strict linting. Builds must not pass without all lints passing.
- No patches on patches. No fallbacks unless required by functionality. Diagnose and fix root causes.
- Before reusing code that hasn't been reused before: pause, plan a refactor, execute it maintaining best architectural practices, then reuse.

## Verification

- Every UI change must be visually verified using Playwright before considering the work complete.
- Use `mcp__plugin_playwright` to navigate to the affected page, take a screenshot, and confirm the feature renders correctly.
- This applies to all frontend work: new components, layout changes, styling fixes, and interaction flows.

## Architecture

- All standards, specs, and design decisions live in `docs/`.
- Legacy code lives in `src/`. New code goes into `api/`, `admin/`, `web/`, `worker/`, `packages/`.
- Do not import from `src/` in new code. All reusable concepts must be re-implemented in `packages/`.
- Follow the provider system and frontend architecture in `docs/provider-system-and-frontend-architecture.md`.
- Follow the implementation phases in `docs/implementation-phases.md`.
