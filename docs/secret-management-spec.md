# Secret management

## The vault is required to save a secret

**Nessie cannot store a secret without a configured Infisical vault.** Nessie
holds metadata; the vault holds every value. With no vault there is nowhere
safe to put one, so the write is refused rather than downgraded — there is
deliberately no PostgreSQL fallback and no plaintext path.

Two independent vault projects gate two surfaces. Configure the one you need:

| Surface | Requires | Without it |
| --- | --- | --- |
| **Save a secret** (`/settings/secrets`, `POST /api/secrets`) | `INFISICAL_API_URL`, `INFISICAL_PROJECT_ID`, `INFISICAL_SERVICE_TOKEN[_FILE]` | `503 SECRETS_NOT_CONFIGURED` on save, rotate and revoke |
| **Personal model subscriptions** (`/settings/connections`) | `NESSIE_SUBSCRIPTION_VAULT_API_URL`, `_PROJECT_ID`, `_TOKEN` | Card reads "Not available on this deployment"; linking refused |

These are **two separate Infisical projects on purpose**, never one shared
identity: the Secrets project's personal partition holds a person's ordinary
captured secrets, so an identity scoped there could read all of them. A
subscriptions token must be refused (403) against the Secrets project.
Provisioning, the isolation check, and rotation are in
[deployment/why-these-choices.md](./deployment/why-these-choices.md) → "Personal model subscriptions vault" and
"Infisical vault". In Compose, Infisical only runs with
`COMPOSE_PROFILES=secrets`.

Listing secrets keeps working without a vault — `GET /api/secrets` reads
Nessie's own metadata rows and never touches Infisical. Only writes need it.

### What does *not* go through the vault

So an operator is not misled into thinking a missing vault breaks everything:
connector and OAuth credentials are a **separate legacy store** and are
unaffected. MCP connector secrets and OAuth access/refresh tokens, Slack/Gmail
comms tokens, Browserbase keys, and APNs/FCM push secrets are AES-256-GCM
encrypted at rest in PostgreSQL under the deployment's `NESSIE_AUTH_SECRET`,
addressed by opaque `secret_*` / `credentialRef` pointers. That is the
migration concern named under "Authority split" below, not a second vault. Org
inference-provider keys and the deployment model key are environment variables
and are likewise unaffected.

## Security invariant

Except for live microphone audio intentionally sent device-to-Gemini as
described under Capture and ingestion, a language model may know that a secret
exists and may be authorised to use it, but secret material handled by Nessie
must never enter model context, prompts, tool definitions or arguments, tool
results, memory, embeddings, search, logs, traces, error reports,
notifications, summaries, or inter-agent messages.

Humans can receive `reveal` only through a future step-up-authenticated flow.
Agents can receive `use` only. An agent can never receive `reveal`.

## Authority split

Infisical is the vault and owns secret values, encryption, versions, rotation,
and vault audit. Nessie owns the user-visible metadata, scope, grants, product
policy, and its own audit trail. The first-class `Secret` and `SecretGrant`
records contain no secret value, ciphertext, encryption key, or vault token.
Existing connector/OAuth secret storage is a separate legacy migration concern;
new secret-capture flows must never add values to Nessie's PostgreSQL database.

`Secret.vaultReference` is an opaque Infisical location. It is the only
connection from a Nessie secret record to vault material. `SecretGrant` contains
the four separate capabilities:

- `use` — perform an authorised operation without disclosing a value;
- `reveal` — human-only raw-value disclosure, not implemented in the MVP;
- `manage` — change metadata, replace, rotate, revoke;
- `delegate` — issue further grants, but only for capabilities the delegating
  person also holds.

Every vault location is hard-partitioned as
`/nessie/<organizationId>/<scopeType>/<scopeId>`, using only stable structural
IDs. Personal paths use the owner user ID, team paths the team ID, project paths
the project ID, and team paths the organisation ID. Nessie uses the same
path for create, rotate, and revoke; `vaultReference` records that exact path
with the server-minted opaque secret name. Display names never enter a vault
path, and secret values are neither returned nor logged. The folder hierarchy
is created on demand before a first write, one path segment at a time; a
concurrent already-existing-folder conflict is successful.

The current MVP exposes metadata-only create, list, rotate, revoke, and grant
endpoints. It rejects any attempt to grant `reveal` to an agent. No endpoint
returns a secret value.

## Scope

A secret has exactly one home scope: `personal`, `team`, `project`, or
`organization`. A personal secret is bound to its owner. Team, organization, and
project mutation is owner-gated and confirms the requested target belongs to
the caller's organisation. Reads are entitlement-scoped: an owner sees all
metadata; other users see their own personal secrets and explicit user grants.

Phase 1 exposes Personal and Project selection in the UI. Team and Organization
are preserved in the metadata model and API for an owner-managed surface.

## Capture and ingestion

The same deterministic scanner runs in the browser and API. It matches only
structural credential syntax (known provider formats, PEM blocks, JWTs,
credential-bearing connection URLs, explicit token assignments, and bounded
high-entropy tokens including base64-style `/`, `+`, and padding); it does not
use an LLM or infer intent from prose. Inline redaction uses the stable
`[REDACTED_SECRET]` marker so an ordinary sentence after a detected value
survives every defence-in-depth pass. Provider-prefix-plus-bullet masks render
only as a terminal list in the protected capture message. A user-supplied
bullet mask followed by other bytes is treated as camouflage and removed
through a fixed-point redaction before reaching a sink.

The composer scan happens before a chat request, optimistic message, oversize
paste state, or durable draft can survive. It covers channel posts, thread and
drawer replies, new conversations, and message edits. Every doorway opens the
same protected capture form with a suggested key name and scope. Its value
control contains only the provider's structural prefix (for example
`sk_live_`) plus twelve bullet circles; opaque high-entropy values expose no
real prefix bytes. The raw value remains transient component state and is
posted only to `POST /api/secrets` through a direct request that is never
retained in the application-wide mutation cache. An explicit assignment such
as `API_KEY=…` stores only the right-hand credential bytes, not the assignment
syntax.

When one turn contains several credentials, the form advances through all of
them and saves each value separately. After the vault accepts every secret,
the composer sends a new replacement turn:
the person's original text with every detected value replaced by the stable
redaction marker, plus a terminal list pairing each approved secret name with
its safe provider prefix and bullet mask. That replacement is the only
typed-message version which reaches PostgreSQL, realtime, memory, indexing, or
a model.
Discard sends no turn. If earlier values in a multi-secret turn were already
saved, the form says that discarding keeps those vault entries while sending no
message. This implements the requested replace semantics without ever
persisting a raw message that would later need deletion. The server scan
still repeats before message persistence and returns `SECRET_INTERCEPTED` to a
client which bypasses the composer. The same pre-persistence refusal covers
direct executor launches, ordinary agent-card response fields, and product-
integration handoffs, because each can create a user-authored message without
passing through the ordinary chat route. Direct memory capture, owner mailbox
messages and Agent Designer requests and handoffs are refused at their own
pre-storage boundaries as well. Agent configuration fields are refused through
the shared create/update service before persistence, while legacy values are
redacted before avatar generation, typed prompts, or voice context. Voice-call
transcript fragments are redacted in the client before display or local storage,
and the server refuses an unsanitized direct transcript payload before creating
its chat record or attachment. Legacy mailbox rows are
redacted again at delivery before chat, realtime, task, queue, or model sinks.

Live voice audio is a distinct boundary: the architecture intentionally sends
microphone frames device-to-Gemini, so Nessie cannot inspect or replace spoken
secret material before Gemini receives it. The compact instruction tells the
assistant not to request or repeat secrets, and downstream transcript/state is
sanitized, but this is not the typed-chat pre-model interception guarantee.

Every primary, inline delegate, and spawned subtask receives the same compact
system-prompt rule: do not ask for, repeat, or place secrets in chat or
model-visible tool arguments; the secure form owns capture, and masked text is
only a protection notice. The live-voice Personal Assistant uses the same
constant, redacts legacy seed turns, and refuses a credential-bearing call
transcript before creating its chat record or transcript attachment. Keeping
this as one shared short constant makes its prompt-context cost fixed and
prevents agent-specific copies from drifting. A
final provider-bound scan covers conversation history, memory, checkpoints,
upstream stage text, and externally mirrored agent turns/cards. Streaming text and reasoning hold an incomplete line
until it can be scanned, and streamed tool arguments are withheld until the
complete JSON can be sanitized. The agent loop masks initial context, compacted
context, and model output. Any tool call whose completed arguments contain a
possible credential is sanitized and refused before authorization, approval,
demonstration capture, delegation, or dispatch. Shared tool-result and durable
preview sinks redact before truncating so a boundary cut cannot reveal a
partial token. These are defence in depth; they do not make a raw secret
available to an agent.

Nessie's first-class Secrets surface writes to its configured Infisical vault.
It does **not** write GitHub Actions repository or environment secrets: that
would require a separately authorised GitHub destination and GitHub's encrypted
secret-write API, which this flow must not pretend to provide.

Capture writes use a client-stable idempotency key. Requests with the same
identity are serialized under a transaction-scoped advisory lock before the
vault write, with an explicit bounded transaction timeout. The metadata row
stores an organisation-scoped keyed HMAC of the submitted value so a reused key
with different bytes is refused without storing recoverable secret material.
Only an active matching row may be replayed, and revoked secrets cannot be
rotated or granted new access. Rotation, revocation, and grant changes share a
per-secret advisory lock, so an active-state check and its mutation cannot race
another lifecycle change. A temporary delegate cannot grant a capability past
their own grant's expiry. Revocation treats an already-absent vault value as
success, so a retry converges after an ambiguous Infisical delete or a failed
local metadata commit. If a failed metadata write leaves its
deterministic vault name behind, the next locked retry replaces that orphan and
continues instead of wedging the capture identity. A response-loss retry
returns the original metadata row without writing the vault twice, while
protected message retries reuse the same message identity and any completed
oversize upload. Both the capture form and ordinary Secrets settings form use
direct transient requests rather than retaining raw values or rejected upload
objects in TanStack's application-wide mutation cache; editing a failed form
rotates its idempotency key. Credential-bearing agent-card presses use the same
non-cached discipline.

Structured secret mentions and a temporary-vault interception flow remain
Phase 1 follow-ups. Text pasted through the oversize-file escape hatch,
attachment filenames, raw upload bytes, and textual tool results use the
shared scanner today. The raw-byte pass decodes ASCII, UTF-8, and UTF-16
credential syntax but does not semantically extract arbitrary compressed, encrypted,
image, or proprietary binary document formats; those inputs are not yet a
complete secret-safe ingestion path.

## Deployment

`infrastructure/compose/docker-compose.prod.yml` runs Infisical and its Redis
sidecar alongside Nessie, with a separate `infisical` database and database
role on the existing `nessie-postgres` cluster. PostgreSQL and Redis have no
host ports. Caddy is the only ingress to `vault.unlikeotherai.com`.

The dedicated Infisical machine-identity access token is mounted as a Docker
secret into the API container at `/run/secrets/infisical_service_token` (the
filename is retained as a legacy deployment contract). The identity has no
organisation-level access and belongs only to the Nessie Secrets project. The
worker, executor, and agent sandboxes do not receive it. The host-only Compose
variable names and provisioning commands are documented in
[deployment.md](./deployment.md).

## Next phases

The current API is deliberately a control plane, not a credential delivery
path. Before agents use customer secrets, implement a credential broker /
Infisical Agent Proxy boundary with per-tool target-host and operation
allowlists, sanitised responses, and agent egress isolation. Non-HTTP secrets
must be used only by privileged RPC tools, never injected into an agent shell
or environment.

`USE` grants can disclose that a named secret exists, because the model needs
that metadata to select a declaratively bound tool. They never disclose its
value, vault path, token, or permission-management controls. `MANAGE` grants
authorize rotation and revocation; `DELEGATE` grants authorize access changes.

The scanner blocks structural credential formats (including nested JSON strings,
quoted and unquoted assignments, common `Authorization` schemes, cloud/service
keys, database URLs, complete or truncated private-key blocks, and JWTs), provider prefixes, and
high-entropy token candidates on user message creation, message edits, and
chat uploads before any durable write. Previously stored drafts are scanned
again while hydrating and rejected rather than repainted into an editor. Secret
metadata is also refused when it contains detectable credential material or a
copy of the submitted raw value. Its masked output is idempotent: bullet
placeholders do not reopen the capture form or trigger the API boundary. It is
deliberately a conservative first
boundary, not a replacement for the pending-secret temporary-vault flow,
content extraction from every binary document format, and interception of
integration/webhook or knowledge-base ingestion. Those are required before
enabling agents to consume those other material types.
