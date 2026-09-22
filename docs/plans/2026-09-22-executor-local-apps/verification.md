# Verification: per-OS matrix, CI, and the live acceptance run

Back to [overview](overview.md).

## Per-OS matrix

| What | Windows 11 (this PC) | Linux | macOS (the Mac over SSH) |
|---|---|---|---|
| Executor unit + subprocess suites (`pnpm --filter @nessie/executor test`) | local | CI `ubuntu-latest` and WSL Ubuntu 26.04 (Node 22) | over SSH on the Mac (Node at `~/.local/node`) |
| Coding-session bridge with the scripted agent: start, fold-in follow-up, interrupt, close, host crash, grandchild kill, two owners, env | local | WSL, including a `systemd-run --user` restart case when WSL has systemd | over SSH |
| Kelpie detection and driving | local (Windows Kelpie build, loopback, alias-pinned) | — (no Kelpie build) | the Mac's Kelpie, when a GUI session runs it |
| Live Claude Code session | local (logged in) | not available (no Linux login) | needs the executor in a logged-in GUI session: SSH cannot read the login keychain where Claude keeps its credentials |
| Live Codex session | failure path only until the ChatGPT quota resets on 2026-09-26 | — | — |

## CI additions

- Windows Native job gains a Node step running the executor's coding-session
  and MCP suites, so `taskkill`/Job Object, `.cmd` shim and Windows path
  rewriting run in CI, not only here.
- Browser Suites gains the new fixture suites (launcher, run stop, lease,
  tool screenshots, coding sessions panel) and finally runs the existing
  `test:e2e:executor-local-mcp`; each fixture takes the three edits
  (vite input behind its flag, browser-suites env, turbo build env).
- `executor/package.json` `test:mcp` lists the new suites and the existing
  `ollama-search-mcp.test.ts`.

## Live acceptance run (after all PRs merge)

On a fresh local database, with the production default model
(`meta/muse-spark-1.3-contributor` through a 24 h Ledger key revoked at the
end), acting as a developer:

1. Bootstrap; ask the Agent Designer for a CTO that owns the Nessie project
   board and drives coding sessions on the machine. Check: no channel is
   created for it; its ticket tools are granted; the executor grant is
   confirmed from a card in chat; the portrait either renders or says why.
2. Pair this PC as a **private** executor; configure `kelpie` (alias-pinned)
   and `coding-sessions` (Claude Code, accept edits, a small allowlist of
   routine commands, root = the Nessie repository); review the policy in the
   UI and confirm the descriptor shows the coding-agent facts.
3. Create three or four real tickets from the remaining open findings.
4. In a project channel, launch **Local apps on this machine** once, with
   "Take the tickets one at a time". Check that the CTO starts one Claude Code
   session per ticket with a proper brief, waits (with no loop warnings),
   reviews with `coding_session_review`, sends a correction at least once,
   and reports only what review returned; that Claude works in its own
   worktree, opens a PR and merges it when green; that the ticket moves.
5. Mid-task, post "also add a test for the empty case" — the wait returns,
   the CTO ends its turn, the drained run carries the lease and relays it.
6. From another member's account, reply in the same thread: no executor
   tools, and the CTO says why.
7. Ask the CTO (or a web-evaluator agent) to evaluate two real sites with
   Kelpie: navigate, screenshot, read — the model describes the screenshots
   correctly, and the person sees them in the thought-process view.
8. End the lease: the indicator clears, the machine closes that owner's
   coding sessions, and a further reply has no executor tools.
9. Record timings, token use, every hiccup, and file them.
