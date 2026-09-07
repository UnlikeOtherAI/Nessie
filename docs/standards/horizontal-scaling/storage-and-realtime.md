# Storage and realtime

The two places where an instance quietly keeps something to itself: the local disk, and the order it publishes events in.

## 7. No local disk beyond per-request scratch the same request deletes

**A file one instance wrote is not there for the next call.** `filesystem` is
the default storage provider and nothing forbids it outside `local` (1.10/6.1,
`packages/config/src/index.ts:369-373`), so a deployment that forgets
`NESSIE_STORAGE_PROVIDER` writes uploads to ephemeral per-instance disk
silently. The `file_write`/`file_read`/`file_glob` builtins do raw `node:fs` I/O
on the worker's own disk under an operator-configured `allowedRoots` (6.2,
`worker/src/run/builtin-handlers/file-write.ts:60-71`), so a write on one worker
is invisible to the next tool call on another. The `docker` execution provider
shells out to the local daemon and its terminate job is routed to any worker
(6.3/8.2, `worker/src/control/execution/docker-provider.ts:105-177`); the
lease sweep's response to that is the second corollary below.

**Corollary, as built.** All three are refused outside `local` mode, and the
refusal names the setting, the mode it is illegal in, and what to use instead.
`local` keeps every one of them: it is the single-instance developer path, and
there the API runs the worker embedded in its own process — one disk, one
daemon.

The three descriptors, the message and the assertion live in one file,
`packages/config/src/local-only.ts`, so the inventory this invariant forbids is
one list rather than three scattered guards. Where each is *enforced* differs,
and the difference is not stylistic — only one of the three is configuration:

- **`filesystem` storage** is `storage.provider`, so it is refused in
  `loadConfig` (`packages/config/src/index.ts`), which both the API and the
  worker call before anything else. This is the boot-fatal one, and it is the
  case that matters most because `filesystem` is the **default**: a deployment
  that never sets `NESSIE_STORAGE_PROVIDER` now fails to start instead of
  writing uploads to a disk that disappears. It is also already wrong at one
  host — the API and the worker are separate containers with no shared volume.
- **The `docker` execution provider** is a column on
  `execution_environment_templates`, per-organisation data that configuration
  cannot see, so it is refused at the one chokepoint every probe, provision and
  terminate passes through (`worker/src/control/execution/providers.ts`).
  Provision **throws**; the probe **answers** `available: false` carrying the
  same sentence, because it runs in the boot-time runner-registration loop over
  every provider, where a refusal is a fact about the deployment rather than a
  boot failure.

  **Terminate is not gated, and the asymmetry is deliberate: refuse to create
  new single-host resources, never refuse to clean up existing ones.** For a
  self-hosted operator who mounted the Docker socket into the worker, a gated
  terminate would be an upgrade that strands every live container — job claimed,
  assertion fired, container running, row never leaving `terminating` — and
  nothing new is placed anyway, so draining what exists is all `docker` is still
  for. **Ungated is not unconditional, though: the mode decides what a terminate
  may CLAIM** (6.3, row 5.12). `docker rm -f` reaches this replica's daemon,
  which outside `local` need not be the container's host, so `No such container`
  proves nothing — swallowing it is what wrote `terminated` for a container still
  running. A terminate returns an **outcome** (`ProviderTerminationResult`) and
  only `terminated` may move the row there: `docker` answers `unverified` for a
  missing container in every mode but `local`, the one deployment with a single
  daemon; `gcloud` always answers `terminated`, its reference being a global
  address. Unverified leaves the instance `failed` with
  `EXECUTION_TERMINATE_UNVERIFIED`, `terminated_at` null and the container id and
  runner kept — a row `GET /api/execution-environment-instances` returns, so the
  honesty is in the database, not only in the refusal prose.
- **The `file_read`/`file_write`/`file_glob` builtins** take their
  `allowedRoots` from a column on `tool_registry_entries`, also
  per-organisation data, so they are refused in
  `worker/src/run/sandboxed-tool-dispatch.ts` — the single dispatcher for
  exactly those three. The refusal is a **failed tool result**, not a throw: the
  model asked for the tool, and what it needs back is the sentence saying the
  tool does not exist on this deployment and what to reach for instead.

**Residual.** Creating an execution environment template with provider `docker`
still succeeds on a non-`local` deployment; the refusal comes when it is first
used. The write door is
`createExecutionEnvironmentTemplate` in `api/src/services/execution-environments.ts`,
which is already past the 500-line file cap, so closing it there is a refactor
rather than a guard. Nothing is silently wrong in the meantime — the template is
inert and says so the first time anyone launches it.

**Corollary — a reaper never *reports* a host-local resource reclaimed.**
`expireExecutionLeases` now enqueues `execution.environment.terminate` for an
expired lease whose instance holds a provider reference (5.8/8.2, plan row 5.2),
because a lease that reaches expiry means the runner that provisioned the
machine has stopped renewing and nothing else points at it. It enqueues only for
**host-independent** references. A `gcloud` ref is
`gcloud:<kind>:<project>:<zone|region>:<name>` — a global address, so whichever
replica claims the job deletes the real VM or Cloud Run job. A `docker` ref is a
container id on one host's daemon, and queue jobs are not host-routed: a
terminate claimed elsewhere hits the wrong daemon and ends at
`EXECUTION_TERMINATE_UNVERIFIED`, which is honest but is not a reclaim, and
would replace the expiry reason with one that says less. So the sweep enqueues
nothing for `docker`; the instance keeps the honest terminal state it already has, `failed`
with `EXECUTION_LEASE_EXPIRED`, and **nothing automatic reclaims the container** — a person finds it on the runner's own host by the
`nessie.instance-id` label the provision put on it, with the host named by
`runnerLabel` in the instance metadata — the same refusal
`loadProvisioningContext` makes on the way in (`EXECUTION_RUNNER_NOT_LOCAL`).
The general rule: when a sweep cannot reach the resource, it records that it
could not, never a state it did not achieve.

The host-independence test in `enqueueAbandonedMachineTermination` is a guard,
not a branch that fires today: `docker` derives no reference before provisioning
and `persistProvisionSuccess` writes its container id in the same transaction
that completes the lease, so no reclaim path ever meets a docker row carrying
one. It stays because it is the single enforcement point for this invariant, for
both callers, the day a host-local provider does start naming its resource
early. A dead branch that *claimed* an abandoned container was named for an
operator lived here until it was deleted; do not reintroduce one — an
unreachable recovery reads as a recovery.

**Corollary — the address of a cloud resource is written before it is created,
not after.** A reaper can only reclaim what the database names, so the reference
has to be in the row before the call that spends money, not after it returns.
`persistProvisionSuccess` was the only writer of
`execution_environment_instances.provider_instance_ref`, and it commits in the
same transaction that moves the lease to `completed` — so the column was NULL
for exactly the crash the sweep above exists to catch (a worker killed between
`gcloud compute instances create` returning and that transaction landing), and
non-NULL only on rows whose lease the sweep no longer selects. The enqueue could
never fire on a state any production path produced.
`allocateExecutionEnvironmentInstance` therefore calls
`persistDerivedProviderInstanceRef` **before** `provisionProviderInstance`.

Three things make that safe rather than a second lie. First, the reference is
derived, never guessed: `deriveGcloudProviderInstanceRef` and the provision path
share `resolveGcloudVmTarget` / `resolveGcloudFunctionTarget`, so the string
written beforehand and the string `persistProvisionSuccess` overwrites it with
are produced by one function and cannot drift. Second, the window it opens —
a row naming a machine that may never be created — resolves honestly, because
`terminateGcloud` swallows a `not found` from `gcloud … delete` as already-gone.
A provider whose reference is only knowable *after* the fact derives nothing:
`docker`'s is the container id `docker run` prints, so a docker instance
abandoned mid-provision carries no reference and gets the ordinary
`EXECUTION_LEASE_EXPIRED`, which is the truth.

**Third, and the constraint that makes the other two matter: a row may only
name a machine no other row can name.** A launch config may pin
`instanceName`/`jobName`, and that pin lives on the *template*, so every
instance launched from it resolves the identical name. Written early, instance
B's row would name instance A's live VM: B's create fails as already-exists, B
is marked `failed`, and any later terminate of B — user-requested or enqueued by
a reclaim path — deletes A's machine. So `deriveGcloudProviderInstanceRef`
derives **only** when the name is `buildGcloudInstanceName(instance.id)`, and a
pinned-name template keeps exactly its pre-existing behaviour: the reference
appears only after a provision that succeeded. Pre-naming a resource is safe
only in proportion to how exclusively the row owns the name. **And a provision
may not ADOPT one another row can name either**: `containerName` is pinnable
too, and `provisionDocker` taking whatever held a name already in use made the
collision *succeed* — two rows, one container id, either terminate destroying
the other's live environment. Adoption now needs a `nessie.instance-id` label
naming **this** instance, which is the crash-retry case it exists for; anything
else fails `DOCKER_CONTAINER_NAME_IN_USE`, and `buildDockerProvisionArgs` stamps
the system labels *after* a template's own so that proof cannot be forged.

**Corollary — the failure path reclaims what it may have created.** A provider
that throws has not necessarily created nothing: `provisionGcloud` runs `deploy`
then `execute` for a Cloud Run job, so a throw from the second leaves a deployed
job behind. `markProvisionFailure` marks the instance `failed` and finalizes the
lease in one transaction, which puts the row permanently out of the lease
sweep's reach — so before the derived reference existed, a partial creation was
unreclaimable by construction. It now enqueues the *same*
`execution.environment.terminate` the sweep does, through the same
`enqueueAbandonedMachineTermination`: one host-independence rule, one actor
context, one idempotency-key scheme (`…:lease-expired:` and
`…:provision-failed:`, both namespaced apart from the API's user-requested
`execution-environment:terminate:<id>` so neither suppresses the others).

Both callers enqueue **only when their own write is the one that made the row
terminal** (`updateMany … count === 1` over `pending`/`provisioning`). One
instance can carry more than one non-terminal lease — `loadProvisioningContext`
re-claims an instance that is already `provisioning`, so a retried allocate job
mints a second lease while the first is still live — and expiring that first,
orphaned lease reaches a row a later attempt has since driven to `ready`.
Without the gate the sweep would terminate a machine that is running fine.
Reclaiming is for rows this pass abandoned, never for rows someone else owns.

`persistTermination` keeps a `failed` instance's `error_message` when it writes
`terminated`, because both reclaim paths mark the row with *why* and then
enqueue the terminate; clearing it would leave a `terminated` row and no record
of the failure. An unverified terminate writes its own message and keeps the
previous one under `errorBeforeTermination` in the metadata.

**Corollary — a conditional write that matched nothing rolls its transaction
back; it does not return.** A Prisma transaction commits unless its callback
throws, so `persistProvisionSuccess` returning `false` from inside one (row
5.13) committed the writes that had matched — worst of all an instance left
`ready` when a concurrent terminate had revoked the lease, naming the container
the caller then destroys in `cleanupProvisionedInstance`. It throws a private
`ProvisionPersistConflict` caught at the transaction boundary, so the rollback
does not change the contract: `false` still means "nothing persisted, clean up
what you created", and a real error still reaches `markProvisionFailure` — had
the sentinel escaped, that catch would have skipped the cleanup and leaked the
machine. Convert a rollback signal back where it was raised.

**Corollary — a sweep every replica runs on an interval reads a bounded batch.**
`expireExecutionLeases` takes the 50 oldest expired leases per pass and lets the
next pass take the rest. Unbounded, the first tick after a full-fleet outage
past the 5 min lease TTL loads the entire backlog into memory on every replica
at once, and each row costs a transaction plus a workflow-continuation read.
Batching is safe here because the work is claim-based: an expired lease leaves
the predicate once it is `expired`, so successive passes make forward progress
and skip nothing. Oldest first, so the machine billing longest is reclaimed
first.

**And a bounded, oldest-first batch must isolate each row's failure.** The two
properties combine into a starvation trap: a lease that throws deterministically
never leaves the predicate, so it is at the front of the next batch, and the
next, forever. One uncaught throw would mean no lease behind it is ever
reclaimed while the whole fleet keeps billing. Each iteration therefore has its
own `try`/`catch`; a poisoned row costs one slot of the batch per pass and is
reported — with its instance id, lease id and error — on every pass, because
nothing retires it and the machine it names may still be running.

**Corollary — a transfer that cannot finish inside the drain does not travel
through the API.** Every download was proxied (6.4), pinning a multi-GiB transfer
to a process a scale-in then killed, and Cloud Run's SIGTERM-to-SIGKILL grace is
a fixed ten seconds. Past `storage.signedDownloadMinBytes` (8 MiB: what a
pessimistic 1 MB/s client finishes inside the shortest drain the fleet runs with)
the API answers `302` with a signed URL granting one GET, on one key, for sixty
seconds, type and filename pinned in; the 302 is `private, no-store` and
`no-referrer`. **The mint is downstream of the access check, always** — routes
authorise first and call `fileService.openDownload` second, which refuses another
organisation's row and takes the key off the row, not the request. **And nothing
about signing may fail a download:** `signedDownloadUrl` is optional on `Storage`,
defined only when `storage.publicEndpoint` declares a client-reachable address
allowing the admin origin by CORS, so an absence or a throw proxies instead.
## 9. Realtime publishes under a per-scope lock, so id order is commit order

**And a listener never advances a connection watermark past an id it did not
deliver.** The defect (2.1) was that insert and `NOTIFY` were two autocommit
statements on two pools, so notifications could arrive out of id order: the
per-connection watermark then dropped the lower id permanently, and because the
client's `Last-Event-ID` had already advanced past it, replay (`id > $2`) never
returned it either — the message was gone, not late. Two publishers made this
rare; N make it routine.

**One transaction is not sufficient, and this is the part worth remembering.**
Postgres delivers notifications in **commit** order, but `id`/`sequence` come
from a sequence at **insert** time. Two concurrent transactions can still commit
in the opposite order of their ids, and the listener sees the higher id first.
The fix is to make id order *equal* commit order within the scope a watermark
covers: hold `pg_advisory_xact_lock` on that scope from **before** the INSERT
until COMMIT, so the publishers sharing a watermark serialise and the sequence
is handed out and committed in the same order. The lock is released by the
COMMIT or ROLLBACK itself, so a crashed publisher cannot wedge a scope.

**Corollary.** A durable publish is one transaction on **one** pooled client:
`BEGIN`, `pg_advisory_xact_lock(hashtextextended(<scope>, 0))`, the INSERT, the
`pg_notify` carrying the returned id, `COMMIT` — `ROLLBACK` on any error, the
client always released
(`packages/runtime/src/realtime-publish.ts`). The scope is the span of the
watermark it protects, not a global lock: `realtime:thread:<threadId>` for the
SSE lane (`ThreadSseConnection.lastSequence`) and
`realtime:org:<organizationId>` for the WS lane
(`UserSseConnection.lastEventId`, which replays one organization's events for
one user). The **transport is the only writer** for both lanes — the api hub
does not persist through Prisma, because a Prisma insert cannot join that
transaction or take that lock; `api/src/services/realtime-events.ts` is replay
reads only. An **ephemeral** publish (`publishSseEphemeral`) writes no row and
moves no watermark, so it is a plain `NOTIFY` with no lock.

With the lock in place a notification at or below a connection's watermark can
only be the same event delivered twice — a LISTEN reconnect, or an old
publisher mid rolling deploy — so the listener skips it, leaves the watermark
where it is, and logs the pair of numbers at **warn** level so a publisher
regression is visible instead of silent (`api/src/realtime/hub.ts`). It never
moves a watermark past an id it did not write.

**On LISTEN reconnect, re-read the backlog for every registered connection from
its own watermark.** Re-listening restores future notifications only (2.2) while
keepalives hide the drop from that replica's clients, whose own next reconnect
was the only rescue. The hub answers the transport's post-reconnect hook through
the one hydration path a fresh connection takes
(`api/src/realtime/connection-hydration.ts`); one still hydrating is skipped, a
WebSocket has no watermark, a failure is logged not rethrown.

**A silent replay cap is a gap the client cannot detect** (2.9): `Last-Event-ID`
moves on, later live events carry it past what was withheld, and replay is `id >
watermark`. Ask for `MAX_REPLAY_EVENTS + 1` — "returned exactly `MAX`" cannot
tell a page that *ended* on the cap from one it *cut* — and write one id-less
`realtime.gap` frame the admin turns into a REST bootstrap
(`admin/src/facades/realtime/realtime-gap.ts`, mounted once in the shell). One
sweep retains both logs on one window, cadence row and leader; 2.3 left
`thread_stream_events` unpruned, and it needs an index the other does not.

**Resuming a stream is not the same as replaying every row, and the difference
has to be stated or it gets mistaken for data loss.** A reconnect with a
`Last-Event-ID` replays `thread_stream_events` from that watermark — except for
five event types the hub deliberately skips: `stream.start`,
`stream.reasoning`, `stream.thinking.tool`, `stream.delta` and
`stream.document.delta` (`connection-hydration.ts`). Those are a live preview of
state that is durable somewhere else, and re-sending them to a client that
reconnected after the run ended paints a pending bubble over a finished answer.
The watermark still advances across them, so the stream carries on from the real
head of the log. **Nothing is lost, it changes lane**, and each lane has a named
reader: thought chunks come back by their own `chunkId` from
`GET /api/threads/:threadId/runs/:runId/thinking`, a composing document from
`GET /api/threads/:threadId/document-streams/:sessionId`, and a skipped
`stream.delta` from the finished message the replayed `stream.done` names —
which is why the terminator itself is durable and replayable, and why it carries
a `messageId` even when a disclosure basis withholds its `content`. Any *new*
event type that is not recoverable this way must be replayable. The chaos
smoke's check (c) asserts both halves; asserting only the first would let a real
loss hide behind the exclusion, and asserting neither — demanding every row come
back — is what made that check look permanently broken.

**A notification must be inert to the build it is replacing.** Deploys are
blue-green, so a replica running the previous image LISTENs on the same channel
for the length of a swap and receives everything a new one publishes. Its
fan-out runs in an *unawaited* promise and reads three fields unchecked —
`kind`; then `eventId`, and if that is a string it dereferences `message`; then
`scopes.filter`, once per WebSocket connection — so a `TypeError` there is an
unhandled rejection, and Node 22 ends the process. A new envelope shape
therefore carries nothing at its top level that an older listener dereferences.
The compact `sse-ref`/`ws-ref` forms keep everything they carry under `ref` and
hold an empty `scopes` beside it, so the old fan-out finds no event id, never
reaches `message`, matches no connection and delivers nothing; the row is
committed either way and the client's next reconnect replays it. Widen a
notification payload the same way, and remove such a shim only once no deployed
replica predates the shape.

**Every door to `pg_notify` measures the cap; no lane raises over it** (2.7).
With a committed row an oversized envelope falls back to its `*-ref` form and
the listener re-reads the row; rowless (`publishSseEphemeral`, a ws publication
naming no organization, the revocation) it is dropped and logged, which those
lanes already survive by re-read. The re-read costs a round trip, so resolution
is serialised on the transport, or an oversized event lands behind a smaller one
published later and a forward-only watermark skips it for good.