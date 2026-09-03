# Architecture Guardrails

This is the living checklist for Nessie architecture decisions. Read it before
creating files, moving code, reusing logic, or widening an existing service.

## Things To Avoid

- Do not create new broad buckets like `helpers`, `extras`, `common`, or
  catch-all runtime modules. Name files after the domain responsibility they own.
- Do not satisfy the 500-line file limit by dumping unrelated functions into a
  sibling helper file. Split by cohesive behavior and keep the public boundary
  explicit.
- Do not add more central contract/schema barrels when a domain-owned contract
  file would work. Large files such as API contracts and shared schemas must be
  split by product area as they change.
- Do not let route handlers own business workflows. Routes should parse input,
  call a service, and translate service errors to HTTP responses.
- Do not grow worker orchestration functions with more claim, budget, tool,
  MCP, persistence, notification, and workflow logic. Move behavior behind
  injectable domain services before adding new branches.
- Do not use import-time side effects for app or worker setup. Prefer explicit
  builders with injected config, clock, ids, fetch, Prisma, queues, and external
  clients.
- Do not duplicate queue, MCP, provider, or outbound URL rules across API and
  worker code. Put the rule in the smallest shared package that already owns the
  concept, then reuse it from both sides.
- Do not use fake sentinel values to satisfy schemas. If a websocket, queue, or
  REST event does not naturally have a field, fix the contract.
- Do not hand-write client DTOs that drift from shared runtime schemas. Parse at
  process boundaries and derive client-facing types from the authoritative
  schema.
- Do not trust forwarded headers by default. Only honor proxy headers through
  explicit trusted-proxy configuration.
- Do not allow user-authored connectors to spawn cloud-side processes or call
  local/private network URLs. MCP transport and OAuth URLs must pass the shared
  SSRF guard before persistence or dispatch.
- Do not log raw tool arguments, OAuth payloads, credentials, or attachment
  metadata. Summaries must redact secret-shaped keys before persistence,
  websocket publication, or audit output.
- Do not attach or expose uploaded files by organization id alone when the file
  belongs to a private channel message. Message visibility and channel
  membership must be checked.
- Do not let builds bypass lint. Production builds, Docker images, and CI paths
  must keep the lint gate attached to the build path.
- Do not leave docs describing a retired topology, port, public contract, or
  workflow. Update or move obsolete docs to `docs/done/` in the same change.

## Preferred Shape

- Keep reusable concepts in `packages/` only when they are genuinely shared by
  more than one app and have a clear owner.
- Keep API services small and domain-named: catalog, instances, OAuth,
  attachments, queueing, policy, and similar product concepts.
- Keep worker execution code as orchestration over injected collaborators. The
  test seam should be obvious without booting Docker, gcloud, Prisma, or real
  network clients.
- Validate external input at every boundary: REST request bodies, stored JSON
  config, queue payloads, MCP transport config, OAuth endpoints, and tool
  arguments.
- Prefer focused tests around new boundaries: service error mapping, private
  resource access, SSRF rejection, redaction, rate-limit identity, and build or
  deploy gates.
- Admin route and team headers own their actions as typed
  `PageHeaderAction` values and render them through
  `ResponsivePageHeader`/`AdminPageHeader`. Give each action an explicit
  priority, preserve one primary action where applicable, and let the shared
  measured overflow menu decide what moves into **More**. Use the typed
  `leading`, `eyebrow`, and `titleInput` options for the small number of headers
  with navigation context or an editable title; do not add page-specific
  breakpoint hiding or arbitrary React-node action slots.
- Keep docs next to architecture changes. If behavior, topology, ports,
  deployment, MCP surface, or workflow changes, update the corresponding
  document before committing.
