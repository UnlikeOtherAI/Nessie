# OpenClaw Agent System Architecture

> Documenting for use in the Nessie project. Source: `/System/Volumes/Data/.internal/projects/Projects/openclaw/`

This collection splits the overnight OpenClaw deep-dive into smaller reference chapters.

## Overview

OpenClaw is a multi-channel AI gateway with an extensible, multi-agent runtime. It is a TypeScript/Node.js monorepo. Agents are primarily powered by `@mariozechner/pi-agent-core` with OpenClaw providing routing, sandboxing, memory, tool policies, and channel integrations.

Agents can run in two modes:
- **Embedded** — runs in-process, the primary runtime
- **ACP** — runs as a separate child process via the Agent Communication Protocol

## Table of Contents

- [Config and Resolution](./01-config-and-resolution.md)
- [Runtime, Platform, and Reference](./02-runtime-platform-and-reference.md)
