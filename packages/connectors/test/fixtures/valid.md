---
apiVersion: toolset.nessie.io/v1
kind: NessieToolBundle
metadata:
  id: com.example.fixture
  name: Fixture Tools
  version: 1.0.0
  vendor: Example
  license: MIT
policy:
  defaultToolMode: inherit
tools:
  - id: echo
    toolName: echo
    label: Echo
    overview: Echo the given text back to the caller.
    instructions: Use for smoke-testing the bundle pipeline.
    source: custom
    transport: direct
    transportConfig:
      command: echo
    inputSchema:
      type: object
      properties:
        text:
          type: string
      required:
        - text
    enabled: true
    grants:
      allowed: true
      config:
        timeoutMs: 5000
    basePrompt:
      content: Echo precisely what the user typed.
      mergeMode: append
    tags:
      - debug
      - test
    baseSearchTerms:
      - echo
      - debug
    allowSearchTerms:
      - echo
    createdBy: system
    owner: com.example
---

# Fixture Tools

Human-readable documentation goes here. The parser must ignore everything
after the closing frontmatter delimiter.
