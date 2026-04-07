# Checkbox-Based Tooling Controls

## 4) API shape for UI (Checkboxes)

Planned model only (no endpoints implemented yet).

The UI should show:
- all registered tools,
- role default state (read-only inherited),
- agent override controls.

Endpoints:
- `GET /tools`  
  returns all tool registry entries + schema metadata.
- `GET /roles/{roleId}/tools`  
  returns inherited role tool grants.
- `GET /agents/{agentId}/tools`  
  returns effective tool grants for that agent.
- `PATCH /agents/{agentId}/tools/{toolId}`  
  body:
  ```json
  {
    "mode": "custom",
    "grants": {
      "allowed": true,
      "config": {"timeoutMs": 60000}
    }
  }
  ```
  - `mode: "inherit"` re-applies role defaults by clearing agent overrides.
  - `mode: "custom"` stores agent overrides.
- `POST /tools`  
  register custom tool metadata and schema descriptor.
- `DELETE /tools/{toolId}`  
  unregister (if permitted by policy).

### 4.1 One-file install artifact

Required behavior: onboarding a new tool requires one artifact file and no code edits.

- Supported file forms:
  - `toolset.json`
  - `toolset.yaml` / `toolset.yml`
  - `toolset.md` with YAML frontmatter
- One file carries all of:
  - tool metadata,
  - transport + input schema,
  - tool grant defaults,
  - sandbox constraints,
  - optional prompt templates,
  - signature/verification metadata.

Example (`toolset.json`):
```json
{
  "apiVersion": "toolset.nessie.io/v1",
  "kind": "NessieToolBundle",
  "metadata": {
    "id": "com.acme.ollama-tools",
    "name": "Ollama Tools",
    "version": "1.0.0",
    "vendor": "Acme",
    "source": "https://marketplace.example.com/toolsets/ollama.json",
    "license": "MIT",
    "signature": {
      "type": "sha256",
      "value": "a2f3..."
    }
  },
  "policy": {
    "defaultToolMode": "inherit",
    "defaultSandbox": {
      "allowOutsideReadOnly": true,
      "allowedRoots": ["/System/Volumes/Data/.internal/projects/Projects"],
      "deniedPaths": ["/etc", "/System/Volumes/Data/.internal/secrets"],
      "env": {
        "allowVars": ["PATH", "HOME", "OLLAMA_HOST"],
        "denyVars": ["OPENAI_API_KEY"]
      }
    }
  },
  "tools": [
    {
      "id": "ollama-invoke",
      "toolName": "OllamaInvoke",
      "label": "Ollama Invoke",
      "overview": "Run local model prompts through Ollama for inference tasks.",
      "instructions": "Use this tool only for offline/edge inference, and keep prompts deterministic.",
      "source": "custom",
      "transport": "http",
      "transportConfig": {
        "url": "http://127.0.0.1:11434/api/generate",
        "method": "POST",
        "headers": { "Content-Type": "application/json" }
      },
      "inputSchema": {
        "type": "object",
        "properties": {
          "prompt": { "type": "string" }
        },
        "required": ["prompt"]
      },
      "grants": {
        "allowed": true,
        "config": {
          "timeoutMs": 120000,
          "maxOutputBytes": 262144
        }
      },
      "basePrompt": {
        "content": "Use Ollama locally for this tool call. Keep prompts short and explicit.",
        "mergeMode": "append"
      },
      "tags": ["llm", "local", "inference"],
      "baseSearchTerms": ["llm", "local", "inference", "ollama"],
      "allowSearchTerms": ["local", "model", "generate", "completion"],
      "commonPrompt": {
        "enabledPrompt": "Use local Ollama for this model call.",
        "overrideMode": "append"
      },
      "createdBy": "agent",
      "owner": "com.acme"
    }
  ]
}
```

Copy/paste example available at:
- [nessie-toolset.example.json](../nessie-toolset.example.json)

Import mechanism:
- Local:
  - copy one file into a configured import path,
  - backend validates schema + signature + policy constraints,
  - writes to local catalog store.
- Marketplace:
  - fetch artifact from signed package manifest,
  - verify checksum/signature before import.
- UI:
  - prompt a review diff (tools, permissions, sandbox deltas),
  - default action is "disabled until approved".

Marketplace index entry example (what an online catalog can serve):
```json
{
  "schema": "toolset-index.nessie.io/v1",
  "items": [
    {
      "name": "Ollama Tools",
      "manifestUrl": "https://marketplace.example.com/toolsets/ollama.json",
      "checksum": "sha256:8d9e...",
      "signature": {
        "type": "ed25519",
        "value": "base64..."
      },
      "license": "MIT"
    }
  ]
}
```

Minimal MD form (frontmatter):
```md
---
apiVersion: "toolset.nessie.io/v1"
kind: "NessieToolBundle"
metadata:
  id: "com.acme.local-shell"
  name: "Local Shell Helpers"
  version: "0.1.0"
  vendor: "Acme"
  signature:
    type: "sha256"
    value: "a2f3..."
tools:
  - id: "shell-apply-patch"
    toolName: "ApplyPatch"
    label: "Apply Patch"
    overview: "Apply patch-style edits to local text files with minimal diff."
    instructions: "Use this built-in tool for file edits. Prefer narrow diffs and include only touched lines."
    source: "builtin"
    transport: "direct"
    enabled: true
    transportConfig:
      command: "apply_patch"
      args: []
    inputSchema:
      type: "object"
      properties:
        patch: { type: "string" }
      required: ["patch"]
    grants:
      allowed: true
      config:
        cwdMode: "inherit"
        requireApproval: true
    basePrompt:
      content: "Use apply_patch for repository file changes. Keep edits minimal."
      mergeMode: "append"
    tags:
      - filesystem
      - editing
    baseSearchTerms:
      - patch
      - diff
      - file-edit
    allowSearchTerms:
      - apply
      - patch
      - editing
    commonPrompt:
      enabledPrompt: "Prefer minimal diffs and respect existing coding style."
      overrideMode: "append"
    createdBy: "system"
    owner: "com.nessie"
---
Use this bundle only on trusted hosts.
```

## 5) Execution enforcement points

Before calling any tool:
1. Resolve effective grant for the agent/task context.
2. Deny if `allowed !== true`.
3. Apply effective config over tool defaults.
4. Execute with merged config.

## 6) UI behavior mapping

Each row = one tool:
- checkbox = effective `allowed`,
- inherited badge shown when value comes from role,
- override toggle switches row into editable mode,
- expanded “options” panel for config (e.g., timeout, retries, cwd),
- “reset to role default” clears overrides.

## 7) Minimal rollout plan (pragmatic)

Phase 1 (safe, no runtime behavior break):
- Add registry types and in-memory catalog.
- Add `listTools` endpoint and documents.
- Add role policy getter to include grant shape.

Phase 2 (agent UX):
- Add `agent.toolPolicy` storage and merge resolver.
- Add `agent/{id}/tools` + `PATCH` endpoint.

Phase 3 (execution enforcement):
- Enforce allow/config on:
  - `spawnSubAgent` tool selection,
  - MCP `invoke_tool`/`callTool` path,
  - any direct tool-call flows.

Phase 4:
- Add persistence + audit events for grant changes and tool registrations.
- Wire to `UI/web` components for live checkbox matrix.

## 8) JSON flexibility (required)

- Tool configs at registry level and override level must accept arbitrary JSON objects (`Record<string, unknown>`).
- UI should provide raw JSON editing for advanced users (in addition to typed fields), with schema hints as optional UX.
- Unknown keys must be preserved and passed through to execution.
