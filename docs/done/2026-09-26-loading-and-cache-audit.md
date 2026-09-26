# Loading and cache audit — 26 September 2026

## Scope and findings

Reviewed the shared query client, session lifecycle, facade query policies,
navigation prewarming, project/board hosts, channel histories, realtime
invalidation, knowledge pagination and the existing authenticated image cache.
This is a client loading audit, not a production API latency measurement.

| Surface or layer | Finding | Change |
| --- | --- | --- |
| Whole admin | Inactive queries disappear after five minutes | Retain visited reads for 30 minutes; freshness stays separate |
| Reload and app reopen | Query memory is lost, so directories and boards start blank | Bounded, validated local snapshots hydrate the canonical query cache after live authentication |
| Projects and channels | Directories used infinite freshness and could miss changes while away | One minute freshness with focus revalidation, plus existing realtime invalidation |
| Project board entry | Prewarm fetched only the directory, then mounting started the card request | Prewarm selected cards too; explicit board ids allow parallel requests |
| Other project sections | The shared header queried board cards even on Docs, Settings and Overview | Fetch cards only when the board section is showing |
| Project board | Cold tickets rendered empty columns; a transient refresh failure removed cards | Cold skeleton; retain last cards with Retry on refresh failures |
| Scrum board | An unresolved sprint read could say “No active sprint” | Wait for that project's sprint result |
| Channel swaps | Previous-room messages could appear under the destination; missing ids fell back to the first room | Exact-entity cache reuse; no fallback room for an explicit URL |
| Board realtime | Board updates refreshed cards and sources but not the board definition | Refresh the cached board directory too |
| Images | Existing bounded object-URL cache already avoids repeated authenticated downloads within a session | Retained the existing cache and its logout cleanup |
| Docs, agents, dashboards, settings | Facades already share React Query; knowledge pages carry document bodies and agents can carry prompts/policy | Benefit from longer in-memory retention; these payloads are excluded from disk |

## Persistence boundaries

The owning surface is the existing project/channel interface; the doorways
are its sidebar, project list and channel rows. No parallel page, entity
provider or local writable database is introduced. Snapshot storage is a
projection of the one query cache, never authoritative for edits or access.
The existing board-task wire schema now lives beside `TaskRecordSchema` in
`@nessie/schemas`; the API re-exports it and the admin derives its types and
snapshot validation from it, so placement fields have one definition.

Saved reads are limited to project/channel/team directories, boards and board
cards. Message bodies, document bodies, private mail, membership decisions,
credentials and live runs are deliberately not persisted. They continue to
load through their entitled routes; recently visited content remains in memory.
The first authentication read and genuinely unvisited content still need the
network. This does not make the app an offline client.

Snapshots are capped at 60 queries and 1,000,000 characters, expire after
24 hours per result, and restore only for the same live identity/context and
entitlements. They always refresh in the background. See the standing
[navigation cache rules](../navigation/content-and-drafts.md).

## Verification

Unit coverage exercises immediate restore with mandatory revalidation,
schema allowlisting, identity isolation, expiry, corrupt/blocked storage,
logout races and rejected reads. Prewarm coverage checks the default board
and explicit-board parallel request. The headless read-cache suite drives
the real router, session provider, facades and board/channel components with
controlled HTTP responses at desktop and phone widths. It does not simulate
server authorization; that remains the API's responsibility.
