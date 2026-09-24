# Agent Tools access proof

Run this headless driver only against an isolated local database with the local
API and admin servers already healthy. It authenticates with a short-lived
local bearer supplied through the environment; it never creates credentials or
calls an upstream model.

`UI_TOKEN`, `UI_AGENT_ID`, and a nonempty `UI_ENTRIES` are required. `UI_ENTRIES` is a
JSON array of `[toolId, label]` pairs, or `[toolId, label, explanation]` when the
entry must also show a line of its explanation — a capability grant such as
`project_operator` explains itself beside its switch. The agent must start with
each tool off for `UI_PROOF_PHASE=enable`, and on for `UI_PROOF_PHASE=revoke`.
The admin is this worktree's (`scripts/dev-ports.mjs`), or `UI_PROOF_ADMIN_URL`.

```powershell
$env:UI_ENTRIES = '[["browser_open","Open Browser"]]'
# or, for the project-operator grant and its explanation:
# $env:UI_ENTRIES = '[["project_operator","Project operator","Acts as the person talking to it"]]'
$env:UI_PROOF_PHASE = 'enable' # then run again with revoke
node admin/e2e/tool-access-ui-proof/run.mjs
```

Set `UI_PROOF_CHROMIUM_PATH` when Chrome is not at `C:/Program Files/Google/Chrome/Application/chrome.exe`.

The run writes distinct `initial-`, `enabled-`, and `revoked-` screenshots to
`artifacts/tool-access-ui-proof`, plus one JSON result on stdout. It waits for
Save to settle, reloads the Agent Tools URL, and reads each switch state again.
Use the owner-only protected route for browser and peer tools; project ticket
tools exercise the ordinary policy route.
