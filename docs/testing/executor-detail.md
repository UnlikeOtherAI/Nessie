# Executor management review

The machine's detail page owns agent access, permissions and recent activity.
The Executors list opens it; an attention badge opens its Permissions tab.
The same machine can serve several agents. Adding or removing one agent changes
only that agent's assignment and grants, in one confirmed transaction.

## Element audit

| Element | Decision or action | Treatment |
| --- | --- | --- |
| Machine name, scope, status | Identify the machine and understand its availability | Keep together in the header; show last connection only when offline |
| Overview | Repeated status, permissions and diagnostics | Remove; Agents is the default |
| Access | Ambiguous mix of people, agents and raw access rules | Replace with the Agents table and a private-machine people dialog |
| Agents | See who has stored access and remove one agent | Shared DataTable, search and PaginationFooter; server filters rows and totals by entitlement |
| Add agent | Choose another eligible agent | Button opens a paginated picker; review names the agent, exact permission set, folders and permitted programs |
| Permissions | Review what the machine permits | Show only the latest signed proposal, using human operation names and its actual folders, programs and apps |
| Old pending revisions | No current decision; superseded by the latest proposal | Remove from the detail page and attention counts; retain server history |
| Review changes | Approve a current proposal | One dialog reuses the same permission details; no raw JSON, hashes or protocol identifiers |
| Attention | Find an outstanding decision | Count current proposals on the Executors navigation item, list row and Permissions tab; remove the separate tab |
| Sessions | Find recent work and its conversation | Rename Activity; shared table, latest 20 sessions, links only to authorized conversations |
| Session revocation button | Actually disconnects the whole machine | Remove from session rows; Disconnect executor lives in the Machine menu |
| Pause, Resume, Disconnect | Control the machine | Machine menu; review states the consequence before confirmation |
| Delete | Take a machine off the list for good | Machine menu in every state, pending pairing included; the review names the consequence and confirming returns to Executors |
| Private-machine people | Add, change or remove human access | Machine menu opens the shared dialog shell; agent access stays in its own table |
| Local models | Manage a separately connected local-model host | Machine menu item only when that connection exists; disconnection explicitly preserves executor pairing |
| Local Desktop controls | Manage this computer's folders and executor | Desktop-only menu doorway; no permanent browser panel |
| Local apps and nearby devices | Identify an unavailable app or a device needing pairing | Keep names, availability, observed age and remedies; remove tool counts, versions, addresses, display sizes and runtime details |
| Default security paragraphs | No decision on a routine status page | Move relevant consequences into the permission or destructive-action review |
| Fresh identity check | Authorize a change that widens access | Password only where the server supports it; SSO-only users see the missing provider capability and cannot submit. Disconnect and Delete never ask for it |

## Browser verification

Run `pnpm --filter @nessie/admin test:e2e:executor-detail` on this worktree's
fixed ports. The real page is exercised at 1280 and 390 pixels, including the
default roster, latest-only policy review, unavailable SSO verification,
conversation doorway, people dialog and nested local-model confirmation.
Screenshots are written to `e2e/screenshots/executor-detail/`.

The complementary `executor-agents`, `executor-attention`, `executor-pairing`
and `executor-local-mcp` suites cover pagination and mutation review, scoped
badges, pairing and app availability. Browser Suites runs these fixtures with
explicit Vite inputs; the fixture flags and cache requirements are documented
in [executor attention](executor-attention.md).

These are controlled browser responses. Database tests separately establish
entitlement, fresh verification, independent multi-agent grants and atomic
confirmation. They do not prove a signed release is installed on a device or
that UOA supplies a fresh-authentication assertion.
