# Workflow Templates

Workflow templates are the highest-level capability in the marketplace. While MCP servers, skills, and API connectors give agents individual capabilities, workflow templates wire everything together into end-to-end automated pipelines.

## What a Workflow Template Is

A workflow template is a blueprint that combines:
- **Trigger(s)** — what event starts the workflow
- **Steps** — an ordered sequence of agent tasks, each using skills and/or tools
- **Routing** — which agent handles each step (or "best available")
- **Connectors** — which MCP servers / API connectors the workflow requires
- **Variables** — typed workflow inputs and resource selectors resolved at install time or run time
- **Execution environments** — optional VM/container/workspace templates for coding, triage, test, and deploy steps
- **Output actions** — what happens when the workflow completes

## Workflow Template Schema

```
workflow_templates
  id               UUID PK
  organization_id  UUID FK → organizations

  name             TEXT
  description      TEXT
  version          INT
  status           ENUM (draft, testing, active, paused, deprecated, archived)

  -- The blueprint
  triggers         JSONB — array of trigger definitions (event type + conditions)
  steps            JSONB — ordered execution steps (see below)

  -- Dependencies
  required_skills  TEXT[] — skills this workflow uses
  required_tools   TEXT[] — tools needed (from MCP servers or connectors)
  required_connectors TEXT[] — connectors by slug
  required_environment_templates TEXT[] — environment templates by slug

  -- Typed variables / bindings
  variable_schema  JSONB — typed workflow variables and selectors
  binding_schema   JSONB — constrained bindings to installed capabilities/resources

  -- Configuration
  default_config   JSONB — default parameters for the workflow
  config_schema    JSONB — JSON Schema for configurable parameters

  -- Security
  security_scan_id UUID FK → skill_security_scans (same scan pipeline as skills)
  risk_level       TEXT — "low" | "medium" | "high"

  -- Metadata
  category         TEXT
  tags             TEXT[]
  author_id        UUID FK → users
  source           TEXT — "platform" | "community" | "org"

  -- Stats
  run_count        INT DEFAULT 0
  success_rate     FLOAT
  avg_duration_s   FLOAT
  last_run_at      TIMESTAMPTZ

  created_at       TIMESTAMPTZ
  updated_at       TIMESTAMPTZ

  @@unique([organization_id, name])
```

## Step Definition

Each step in a workflow defines what happens:

```typescript
type WorkflowStep = {
  id: string
  name: string
  order: number
  type: "skill" | "agent_task" | "action" | "condition" | "wait"
  skill_name?: string
  skill_input?: Record<string, unknown>
  agent_id?: string
  agent_role?: string
  task_description?: string
  action_type?: string
  action_config?: Record<string, unknown>
  condition?: {
    field: string
    operator: "eq" | "gt" | "lt" | "contains" | "exists"
    value: unknown
    then_step: string
    else_step?: string
  }
  wait_config?: {
    duration_minutes?: number
    until_event?: string
    timeout_minutes?: number
  }
  on_failure: "stop" | "skip" | "retry" | "fallback"
  retry_count?: number
  fallback_step?: string
  output_key?: string
}
```

## Typed Variables and Secure Resource Selection

Workflow configuration must not rely on arbitrary free-text identifiers for sensitive resources. A workflow needs typed variables that resolve only to resources already visible to the installing user and already allowed by scope/policy.

Use two layers:

- `variable_schema`: typed values used by the workflow at runtime
- `binding_schema`: constrained selectors that bind a workflow to installed connectors, repos, boards, mailboxes, environment templates, channels, and secret refs

Example variable kinds:

- `string`, `number`, `boolean`
- `enum`
- `json`
- `secret_ref`
- `connector_ref`
- `connector_resource_ref`
- `environment_template_ref`
- `agent_ref`
- `channel_ref`
- `repo_ref`

Example binding rule:

- A `repo_ref` for GitHub is not entered as free text
- The install UI queries the assigned GitHub connector under the current actor context
- The user can only pick repositories the connector can already see and the current policy allows
- The saved binding stores provider metadata such as `{ connector_slug, external_id, display_name }`, not arbitrary text

This is how workflows stay universal while still secure:

- the template declares what kind of thing it needs
- the install flow resolves candidates from assigned capabilities
- the user selects from an allowlisted set
- runtime uses the saved binding, not fresh free-text input

Example schema:

```json
{
  "variable_schema": {
    "type": "object",
    "properties": {
      "target_repo": {
        "type": "repo_ref",
        "provider": "github",
        "source": "connector_binding",
        "description": "Repository the workflow may act on"
      },
      "issue_label_to_start_fix": {
        "type": "string",
        "default": "do-pr"
      },
      "customer_contact": {
        "type": "connector_resource_ref",
        "provider": "crm",
        "resource_type": "contact"
      },
      "coding_environment": {
        "type": "environment_template_ref",
        "capabilities": ["shell", "git", "node", "codex"]
      }
    },
    "required": ["target_repo", "coding_environment"]
  }
}
```

## Execution Environment Bindings

Workflow steps may request interactive or non-interactive execution environments:

- `localhost` folder/process
- `docker` container
- cloud VM or job provider such as GCE, EC2, or Droplet

The workflow never hardcodes provider credentials or raw machine IDs. It binds to an allowed environment template and launches an instance through the platform.

Environment bindings should support:

- template selection from visible environment templates
- provider-neutral capability requirements
- secret ref attachments as explicit bindings
- terminal/SSH observability where enabled
- ephemeral lease + teardown policy

Secret injection must use secret refs, not plaintext:

- workflow stores `secret_ref` bindings
- launch resolves them at attach time
- secrets may be mounted as env vars, files, SSH keys, or cloud credentials
- audit logs record the binding and mount target, never the secret value

## Execution Environment Templates, Instances, and Usage

Execution environments are directly billable infrastructure. The platform must track what was launched, by whom, for what run/workflow/plugin, and how long it ran.

Use three layers:

- `execution_environment_templates` — reusable definitions users may bind to workflows/plugins
- `execution_environment_instances` — actual launched environments
- `execution_usage_ledger` — normalized cost and usage records

Example schema:

```
execution_environment_templates
  id               UUID PK
  organization_id  UUID FK → organizations
  name             TEXT
  slug             TEXT
  provider         TEXT — "docker" | "gcloud"
  mode             TEXT — "container" | "vm" | "function"
  home_scope_type  TEXT
  home_scope_id    TEXT
  image_ref        TEXT
  capability_tags  TEXT[]
  pricing_model    JSONB
  created_by       UUID FK → users
  created_at       TIMESTAMPTZ
  updated_at       TIMESTAMPTZ

execution_environment_instances
  id               UUID PK
  template_id      UUID FK → execution_environment_templates
  status           TEXT — launching/ready/running/stopping/terminated/failed
  provider_instance_ref TEXT
  launched_by_actor_type TEXT — "user" | "agent" | "system"
  launched_by_actor_id TEXT
  user_id          UUID FK → users
  agent_id         UUID FK → agents
  workflow_id      UUID FK → workflow_templates
  run_id           UUID FK → runs
  plugin_version_id UUID FK → generated_plugin_versions
  started_at       TIMESTAMPTZ
  ready_at         TIMESTAMPTZ
  stopped_at       TIMESTAMPTZ
  terminated_at    TIMESTAMPTZ
  last_heartbeat_at TIMESTAMPTZ
  teardown_reason  TEXT
  created_at       TIMESTAMPTZ

execution_usage_ledger
  id               UUID PK
  instance_id      UUID FK → execution_environment_instances
  template_id      UUID FK → execution_environment_templates
  provider         TEXT
  meter_type       TEXT — "uptime_min" | "cpu_sec" | "memory_gb_hr" | "storage_gb_hr" | "network_egress_gb" | "invocation"
  quantity         DOUBLE PRECISION
  unit_price       DOUBLE PRECISION
  cost_amount      DOUBLE PRECISION
  currency         TEXT
  actor_type       TEXT
  actor_id         TEXT
  organization_id  UUID FK → organizations
  project_id       UUID
  team_id          UUID
  channel_id       UUID
  user_id          UUID FK → users
  agent_id         UUID FK → agents
  workflow_id      UUID FK → workflow_templates
  run_id           UUID FK → runs
  recorded_at      TIMESTAMPTZ
```

Rules:

- every environment launch creates an instance row
- every termination writes final billable duration and teardown reason
- usage ledger stores both raw meter quantity and normalized cost
- provider-specific billing details belong in `pricing_model`, not scattered across workflow/plugin records
- broad usage rollups should be sliceable by organization, project, team, channel, user, agent, workflow, and plugin version

This should align with the existing token ledger mindset: environments are billable execution, not incidental logs.

## Example Workflows

### Sales Call Follow-Up

```json
{
  "name": "Sales Call Follow-Up",
  "description": "After a sales call completes, extract action items, update CRM, send follow-up email, and schedule next meeting",
  "triggers": [
    {
      "event_type": "conversation.completed",
      "source_filter": ["twilio", "zoom"],
      "conditions": {
        "conversation_type": ["call", "meeting"],
        "has_external_participants": true
      }
    }
  ],
  "required_skills": ["generate-minutes", "extract-action-items"],
  "required_connectors": ["crm", "email", "calendar"],
  "category": "sales",
  "tags": ["sales", "follow-up", "crm", "meetings"]
}
```

### Sprint Standup Pipeline

```json
{
  "name": "Sprint Standup Pipeline",
  "description": "After standup meeting, generate notes, create tasks for blockers, and post summary to team channel",
  "required_skills": ["extract-action-items"],
  "required_connectors": ["jira", "slack"],
  "config_schema": {
    "type": "object",
    "properties": {
      "jira_project": { "type": "string", "description": "Jira project key for blocker tickets" },
      "team_channel": { "type": "string", "description": "Slack channel for standup summaries" }
    },
    "required": ["jira_project", "team_channel"]
  }
}
```

### GitHub Issue Triage → Fix → Customer Follow-Up

This is the canonical software-delivery workflow template:

1. GitHub issue webhook arrives
2. Triage agent classifies the issue and attempts repro in a disposable environment
3. Agent comments back with findings and labels the issue
4. User applies `do-pr`
5. Fix agent launches a coding environment, implements the fix, and opens a PR
6. PR merge event fires
7. Customer-facing agent sends a tailored notification through email/CRM/helpdesk

Example shape:

```json
{
  "name": "Issue Triage to PR to Customer Follow-Up",
  "required_connectors": ["github", "email", "crm"],
  "required_environment_templates": ["coding-vm"],
  "variable_schema": {
    "type": "object",
    "properties": {
      "target_repo": {
        "type": "repo_ref",
        "provider": "github",
        "source": "connector_binding"
      },
      "fix_label": { "type": "string", "default": "do-pr" },
      "coding_environment": {
        "type": "environment_template_ref",
        "capabilities": ["shell", "git", "codex", "claude"]
      }
    },
    "required": ["target_repo", "coding_environment"]
  }
}
```

## Installing a Workflow Template

```
User clicks [+ Add to Library] on a workflow template
  │
  ├── 1. Dependency check
  ├── 2. Configuration
  │     ├── Show config_schema form
  │     ├── Show typed selectors from variable_schema / binding_schema
  │     ├── User picks from allowed resources already visible through assigned connectors and scope
  │     └── Select scope
  ├── 3. Trigger registration
  ├── 4. Security scan
  │     └── Variable bindings verified: no unresolved free-text bindings for protected resources
  ├── 5. Review + activate
  └── 6. Monitoring
```

## Workflow vs Skill

| | Skill | Workflow Template |
|---|---|---|
| **Scope** | Single agent performs a task | Multiple agents, triggers, and actions orchestrated |
| **Trigger** | Agent decides to use it | Automatic — event-driven via trigger system |
| **Dependencies** | Requires tools | Requires skills + tools + connectors |
| **Execution** | Agent follows instructions | Platform orchestrates step-by-step |
| **Configuration** | Input parameters | Org-specific config (channels, projects, systems) |
| **Example** | "Extract action items from a transcript" | "When a sales call ends, extract items, update CRM, email participants, schedule follow-up" |

## Workflow Template API

```
POST   /api/workflows                       — create workflow template
GET    /api/workflows                       — list workflows
GET    /api/workflows/{id}                  — get workflow detail
PATCH  /api/workflows/{id}                  — update workflow
DELETE /api/workflows/{id}                  — archive workflow

POST   /api/workflows/{id}/activate         — enable triggers
POST   /api/workflows/{id}/pause            — disable triggers
POST   /api/workflows/{id}/run              — manual trigger (for testing)

GET    /api/workflows/{id}/runs             — execution history
GET    /api/workflows/{id}/runs/{rid}       — specific run detail with step results
```
