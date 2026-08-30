# Secret management

## Security invariant

A language model may know that a secret exists and may be authorised to use it,
but secret material must never enter model context, prompts, tool definitions or
arguments, tool results, memory, embeddings, search, logs, traces, error
reports, notifications, summaries, or inter-agent messages.

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
- `delegate` — issue further grants.

The current MVP exposes metadata-only create, list, rotate, revoke, and grant
endpoints. It rejects any attempt to grant `reveal` to an agent. No endpoint
returns a secret value.

## Scope

A secret has exactly one home scope: `personal`, `team`, `project`, or
`workspace`. A personal secret is bound to its owner. Workspace, team, and
project mutation is owner-gated and confirms the requested target belongs to
the caller's organisation. Reads are entitlement-scoped: an owner sees all
metadata; other users see their own personal secrets and explicit user grants.

Phase 1 exposes Personal and Project selection in the UI. Team and Workspace
are preserved in the metadata model and API for an owner-managed surface.

## Capture and ingestion

The same deterministic scanner runs in the browser and API. It matches only
structural credential syntax (known provider formats, PEM blocks, JWTs,
credential-bearing connection URLs, and explicit token assignments); it does
not use an LLM or infer intent from prose.

The composer scan happens before a chat request. It opens a protected capture
sheet whose password field is posted only to `POST /api/secrets`. The server
scan repeats before message persistence, realtime previews, model dispatch,
memory capture, embeddings, indexing, or application logging. An intercepted
message receives `SECRET_INTERCEPTED` and is never saved.

Attachment and tool-result scanning, structured secret mentions, and a
temporary-vault interception flow are Phase 1 follow-ups; they must be
completed before file/tool outputs can be treated as secret-safe inputs.

## Deployment

`infrastructure/compose/docker-compose.prod.yml` runs Infisical and its Redis
sidecar alongside Nessie, with a separate `infisical` database and database
role on the existing `nessie-postgres` cluster. PostgreSQL and Redis have no
host ports. Caddy is the only ingress to `vault.nessie.works`.

The Infisical write service token is mounted as a Docker secret into the API
container at `/run/secrets/infisical_service_token`. The worker, executor, and
agent sandboxes do not receive it. The host-only Compose variable names and
provisioning commands are documented in [deployment.md](./deployment.md).

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

The scanner blocks structural credential formats, common provider prefixes,
and high-entropy token candidates on user message creation, message edits, and
chat uploads before any durable write. It is deliberately a conservative first
boundary, not a replacement for the pending-secret temporary-vault flow,
content extraction from every binary document format, and interception of
integration/webhook or knowledge-base ingestion. Those are required before
enabling agents to consume those other material types.
