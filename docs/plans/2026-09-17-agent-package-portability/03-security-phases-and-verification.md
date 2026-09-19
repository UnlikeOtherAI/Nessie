# Security, phases and verification

## Security invariants

1. **Nothing in a package is authority.** The schema has no field for a credential,
   grant, membership, person, organisation or team; the parser is strict; the apply
   step passes every policy through `assertGenericAgentToolPolicyInput` and every
   creation through `createAgentRecord` and its composite FK.
2. **Package text never sits in instruction position for the Designer.** The inspect
   result is structured; the excerpt is in a data block; the apply tool takes ids.
3. **Trust is computed offline and shown as a fact.** Unsigned / Signed / Authorised,
   from digests, an Ed25519 signature and a UOA-signed attestation against the JWKS
   already configured for SSO. An audience mismatch refuses; an expiry degrades.
4. **Disclosure is enforced at export.** A version with a non-empty basis never leaves;
   the count of withheld documents is on the card.
5. **Imports are idempotent and reversible.** The ledger detects the same package and
   the same lineage; an update never touches grants, bindings, mailbox or owner; undo is
   the existing soft delete with its revocations.
6. **No new hierarchy, no UOA duplication.** The only identity fact stored from an
   import is the attesting UOA organisation id on the ledger row.
7. **The scan can only add.** Structural detectors are deterministic and versioned;
   the classifier runs isolated, tool-less, over text as data, and its output can raise
   a finding but never lower one or declare the package clean; a classifier that did
   not run is `partial`, which the gate treats as unknown.
8. **A high finding quarantines the text.** No document excerpt reaches the Designer's
   context while a high finding exists, and every capability is off in the create call
   regardless of trust tier; finding explanations are code-owned templates and excerpts
   are escaped, fetched by card id, and never written into a message.
9. **The gate is in `apply`, bound to the scan.** Import refuses without an
   acknowledgement that is complete for the tier and the findings, made by the person
   the DM stamps, whose `scanDigest` equals the scan being acted on; the ledger row
   records the scan, the statements shown, what was opened and what was affirmed.
   Blocking is reserved for artifacts whose rendered text is not what the model would
   read; meaning is warned about, never used to refuse the person's own decision.
10. **One importer.** `agent_package_inspect` and `agent_package_apply` are
    `identityDelegatedOnly` on the Agent Designer's blueprint; the Personal Assistant
    hands a dropped package off, it never imports one.

## Phases

Each phase ships on its own and is useful on its own. Prisma migrations are flagged;
none touches an existing migration file.

0. **Contract.** `packages/schemas/src/agent-package.ts` (schema v1, limits, upgrader
   scaffold) and `packages/team-admin/src/agent-package/{build,parse}.ts` with
   deterministic-output tests (two builds of one fixture are byte-identical; a folder
   and its ZIP parse to the same tree; every limit refuses with its name). No
   migration, no surface — it is a library phase and says so.
1. **Export.** `verify.ts` for the digest-only path, `GET /api/agents/:agentId/export`,
   the detail-page **Export package…** doorway, `agent.exported` audit, the Designer's
   `agent_export`. Restricted versions withheld and counted. Independently valuable:
   a person can back up an agent, read it as a folder, put it in git. No migration.
2. **Import through the Designer.** `resolve.ts`, `apply.ts`,
   `agent_package_inspect` / `agent_package_apply` in
   `worker/src/run/pa-tools/agent-package.ts`, the structural detection block in
   `run-setup.ts`, the proposal-card extension (trust `fields` row, contents fold,
   collision `select`) in `proposalCardSection()`, the read-only package preview on
   the designer form, the Designer page's drop doorway onto the DM, a ZIP *writer*
   beside the reader in `api/src/lib/zip.ts`, the D4 wiring walkthrough, and the
   clone route re-pointed. **The gate ships here, not later:** the review dialog
   (D11/D12) at `/agents/import/:cardId/review`, the tiered acknowledgement, the
   `apply`-side refusal, and the **structural** half of the scanner
   (`packages/team-admin/src/agent-package/scan/structural.ts`, every `integrity.*`,
   `enc.*`, `secret.*`, `reach.*`, `shape.*`, `size.*` detector and the static half of
   `decl.mismatch`), run at export and import. The Scan line says honestly *"23
   structural detectors; no semantic classification on this instance yet"*, and every
   package takes the unsigned-tier acknowledgement until 2b lands — that is the
   argument for shipping import before the classifier: the gate and the read
   requirement are what protect a person, the classifier is what *informs* them, and a
   dialog that names its own coverage is not a false promise. **Migration:**
   `AgentPackageImport` with the scan and acknowledgement columns from the start (one
   migration, not two). Unsigned and Signed packages both import, labelled.
   **2b — the classifier.** `scan/semantic.ts`: the isolated classify-only call per
   chunk through the utility-model Ledger route, the strict output schema, the
   `intent.*` detectors and the semantic half of `decl.mismatch`, `scanStatus:
   partial` on failure, `classifierModel` on the row. No migration: the report is Json
   and detector coverage grows without a schema change. Detector additions after 2b
   are ordinary changes with a fixture each.
3. **Authorised packages.** Per-organisation Ed25519 keys, the export card's audience
   and expiry, `POST …/export/attest`, attestation verification against the UOA JWKS,
   online revocation check when reachable, the Authorised trust line and pre-selected
   capabilities. **Migration:** `AgentPackageSigningKey`. **Cross-repo:** the UOA
   attestation endpoints. Until UOA ships them, phase 3 lands with the Signed state
   only and the attestation path behind the endpoint's presence.
4. **Later, named and not built.** `packageFromBlueprint`; a `--history` export
   carrying versions whose basis is empty; multi-agent bundles (a folder of packages
   with a `nessie-bundle.json` naming their handoff relationships); derived
   `WorkflowTemplate`s; and a marketplace listing — an `agent_package` library item
   type in `docs/marketplace.md` §1, installed by exactly this import path.

## Verification

- Contract tests under `packages/team-admin/test/agent-package/`: determinism, folder
  ≡ ZIP, limits, strictness (an `ownerEmail` field is a schema error), every upgrader
  against its fixture, signature over canonical bytes surviving an upgrade.
- DB-backed API tests (`DATABASE_URL` exported, through Turbo): export gated by edit
  authority and `canReadSpace`; withheld-by-basis; system agent refused; import creates
  owner = importer with the composite FK satisfied; policy re-keying; protected keys
  stripped; the ledger's copy/update branches; update never touches grants or
  bindings; triggers paused; an audience mismatch refused.
- Worker tests: the structural detection line appears only when a manifest-named
  attachment exists; `agent_package_inspect` output contains no document body outside
  the excerpt, and none at all when a high finding exists; `agent_package_apply`
  refuses model-supplied text fields and refuses without an acknowledgement, with a
  stale `scanDigest`, with a tier-incomplete one, and with an unopened high finding.
- Scanner tests under `packages/team-admin/test/agent-package/scan/`: one fixture
  package per detector id that fires and one that must not (the RTL document with
  balanced isolates, the emoji ZWJ sequence, the inline `data:image/` blob, the
  procedure that names `kb_search` in prose, the "always email the customer" rule);
  the exfiltration fixture pair; a hostile fixture that is encoding-clean and asserts
  the dialog's clean-scan line and the unsigned acknowledgement rather than any
  "safe" wording; export refusing the block class; determinism of `scanDigest`.
  Classifier tests run against the mock-LLM harness with scripted answers and assert
  monotonicity (a "clean" answer over a structural finding changes nothing; malformed
  JSON yields `partial`).
- Browser: the review dialog with each acknowledgement tier, Approve disabled until
  the identity fold has been opened on the unsigned tier and until every high
  finding's fold has been opened, the findings delta on an update, and the two-row
  Source/Scan rendering for the three combinations in D11's table.
- Browser: extend `test:e2e:agent-proposal-card` with the imported-package card —
  the trust row present, the contents fold closed on arrival, the collision select when
  a ledger row exists; a fixture package under `admin/e2e/agent-proposal-card/`.
- Mock-LLM smoke: drop the fixture package into the Designer DM, accept, assert the
  agent, its Documents home page count, the avatar attachment and the paused trigger
  exist and the ledger row is written.

## Open questions for Ondrej

1. **UOA attestation endpoint.** Phase 3 needs three small UOA routes. *Recommend:*
   yes, it is the only way "authorised" can mean an organisation rather than a key;
   ship phases 0–2 first, phase 3 lands with Signed only until UOA is ready.
2. **Default audience for an authorised export.** *Recommend:* a named recipient
   organisation is required and `anyone` is an explicit pick on the export card;
   "another team here" is my own organisation as audience with the team as a hint.
3. **Should unsigned packages import at all?** *Recommend:* yes, labelled, with every
   capability off — refusing the file while allowing the same text pasted by hand
   protects nothing.
4. **Restricted learned documents.** Withhold and count (recommended), or offer the
   original authors an exact-content disclosure grant so a restricted experience can
   travel? *Recommend:* withhold in v1; the grant path is the learning plan's own later
   phase and should ship there, not here.
5. **Published version only, or history?** *Recommend:* published only in v1; history
   as a later flag, basis-filtered per version.
6. **Triggers paused on import, even when authorised?** *Recommend:* always paused;
   unpausing is one word in the DM after placement, and an unplaced agent on a schedule
   a stranger wrote is the wrong default.
7. **Re-point the clone route at the package builder** so a clone carries documents and
   the avatar, or leave the clone shallow? *Recommend:* re-point in phase 2; two copiers
   is the fork Rule zero names.
8. **Attestation lifetime.** *Recommend:* 30 days default, 365 maximum, expiry degrades
   to Signed rather than refusing.
9. **Package size versus the chat door.** The composer caps a file at 25 MiB and a
   message at 10 files, so a package is ≤ 24 MiB and a folder drop ≤ 10 files.
   *Recommend:* live with it in v1 — an agent heavier than that is mostly a knowledge
   space, which has its own transfer path — rather than raising the composer caps for
   one media type.
10. **Ship import before the classifier?** Phase 2 lands the gate, the dialog and the
    structural detectors; 2b lands the semantic ones. *Recommend:* yes — the dialog
    names its own coverage and every package takes the strictest acknowledgement until
    2b, so nothing is promised that is not there.
11. **Which model classifies, at whose cost?** *Recommend:* the utility model the
    learning plan routes through Ledger, attributed to the importing person's run
    budget, with a per-import cap (documents over the cap are marked `partial`, never
    silently skipped).
12. **Block or warn on invisible characters in knowledge documents?** Core documents
    and checklists block; other documents warn high with the characters shown.
    *Recommend:* keep the split — a pasted web page with a stray zero-width space is
    common, an identity document with one is not.
13. **Should export refuse the block class?** *Recommend:* yes — the exporter is the
    person who can fix it, and a package that cannot be imported anywhere should not
    leave.
14. **Blocking on semantic findings.** I drew the line at "warn, never block" because
    the classifier is a guess about meaning and the person may paste the same text by
    hand. *Recommend:* hold that line; if a class ever proves reliable enough to block,
    promote it explicitly with its false-positive story, never by default.
