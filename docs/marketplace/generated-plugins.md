# Generated Plugins

Some integrations will never fit cleanly into declarative OAuth + endpoint config. For those, Nessie supports generated plugins: real code produced from a platform template, built in an isolated coding environment, and executed in a sandboxed runner.

## Product Model

1. User describes the integration
2. Agent scaffolds a plugin from a controlled template
3. Plugin code is written in an isolated coding environment
4. Plugin package is built, scanned, and versioned
5. Plugin runs only in a sandbox until promoted
6. Reviewers can request changes or approve publication to broader scopes

## How Agents Build Plugins Reliably

Agents should not invent plugin architecture from scratch on a blank VM. The platform must give them a constrained build system.

Required building blocks:

- `template catalog`
- `manifest schemas`
- `plugin SDK`
- `validation pipeline`
- `reference implementations`

The build flow must be deterministic:

1. Select plugin template
2. Gather structured inputs
3. Scaffold files from template
4. Fill manifest/config/permissions through schema-aware generation
5. Generate implementation code only within template boundaries
6. Run tests and validators
7. Package artifact
8. Submit review bundle

Platform builder tools:

- `create_from_template(template_id, spec)`
- `validate_manifest(workspace)`
- `run_template_tests(template_id, workspace)`
- `package_plugin(workspace)`
- `submit_for_review(plugin_version_id)`

## Plugin Lifecycle

Every generated plugin version moves through an explicit trust lifecycle:

- `draft`
- `testing`
- `private_sandbox`
- `shared_unreviewed`
- `pending_review`
- `changes_requested`
- `approved`
- `published`
- `revoked`

Approval is per version, not per plugin name.

## Review and Promotion

Review is split into two decisions:

- `distribution approval`
- `runtime approval`

Possible runtime policies:

- `sandbox_only`
- `reviewed_sandbox`
- `reviewed_hardened`
- `trusted_internal`

Typical flow:

1. Creator submits plugin version for review
2. Nessie freezes source snapshot, manifest, dependency tree, permissions, domains, UI bundle, and test artifacts
3. DevOps/platform reviewer inspects code and requested capabilities
4. Reviewer either approves, approves with restrictions, or requests changes
5. Change requests are sent back to the creator through Nessie channels/DMs
6. Creator updates and resubmits a new version

## Plugin Schema

```
plugin_templates
  id               UUID PK
  name             TEXT
  slug             TEXT
  category         TEXT — "oauth_connector" | "cli_wrapper" | "html_widget" | "webhook_normalizer" | "custom"
  template_bundle_ref TEXT
  manifest_schema_ref TEXT
  sdk_version      TEXT
  test_harness_ref TEXT
  created_at       TIMESTAMPTZ

generated_plugins
  id               UUID PK
  organization_id  UUID FK → organizations
  name             TEXT
  slug             TEXT
  category         TEXT
  source           TEXT — "user_generated" | "platform" | "partner"
  home_scope_type  TEXT
  home_scope_id    TEXT
  created_by       UUID FK → users
  created_at       TIMESTAMPTZ
  updated_at       TIMESTAMPTZ

generated_plugin_versions
  id               UUID PK
  plugin_id        UUID FK → generated_plugins
  version          INT
  status           TEXT — draft/testing/private_sandbox/shared_unreviewed/pending_review/changes_requested/approved/published/revoked
  manifest_json    JSONB
  permissions_json JSONB
  dependency_tree  JSONB
  source_bundle_ref TEXT
  ui_bundle_ref    TEXT
  test_report_ref  TEXT
  runtime_policy   TEXT
  submitted_by     UUID FK → users
  reviewed_by      UUID FK → users
  reviewed_at      TIMESTAMPTZ
  created_at       TIMESTAMPTZ

plugin_reviews
  id               UUID PK
  plugin_version_id UUID FK → generated_plugin_versions
  reviewer_id      UUID FK → users
  decision         TEXT — approve/approve_with_restrictions/changes_requested/revoke
  review_thread_id UUID FK → threads
  notes            TEXT
  created_at       TIMESTAMPTZ
```

## Sandbox Enforcement

Generated plugins are never trusted as in-process code. They must not run inside the main API, worker, or realtime processes.

Hard sandbox requirements:

- separate runner process/container/microVM per execution
- read-only root filesystem
- writable scratch directory only
- plugin-scoped storage mount only
- no host Docker socket
- no access to platform source tree unless explicitly mounted for a coding job
- outbound network deny by default, then explicit allowlist
- CPU/memory/runtime limits
- short-lived execution token
- no direct database credentials
- no direct internal service credentials

All privileged actions go through a brokered runtime API:

- invoke declared action
- fetch allowed state
- read/write plugin-scoped storage
- request OAuth flow
- resolve explicitly bound secret refs

This is how we ensure sandboxing is real:

- policy is enforced by the runner and broker, not by prompt text
- plugin only receives least-privilege capabilities declared in its manifest and approved in review
- plugin cannot call arbitrary internal services or use arbitrary secrets

## Secrets and Credentials

Secrets are attached by reference and resolved at execution time:

- plugin manifest declares required secret bindings
- runtime injects only approved secret refs
- injection targets may be env var, temp file, SSH key, or cloud credential
- audit logs record secret ref usage and mount target, never plaintext secret values

If a plugin runs arbitrary code in a VM/container, broad credentials are forbidden. Use least-privilege credentials or brokered APIs instead.

## Plugin UI

Plugins may optionally publish a small HTML/JS interface:

- built as a static bundle
- stored as a versioned artifact
- rendered in a sandboxed iframe
- communicates with Nessie host only through a strict postMessage bridge

Allowed bridge actions:

- `get_state`
- `invoke_action`
- `save_config`
- `request_oauth`

The iframe does not get direct access to Nessie session cookies, DB state, or internal APIs.
