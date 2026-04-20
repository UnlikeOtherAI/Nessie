# OpenClaw Agent Runtime Parity

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Transform Nessie's single-shot keyword-triggered agent execution into an OpenClaw-grade iterative agentic runtime where the model drives tool use, with budget controls, error recovery, context management, and structured sub-agent delegation.

**Architecture:** Replace the current `executeRunJob` pipeline (keyword-detect tools → one LLM call → done) with an iterative loop where: (1) tool schemas are injected into the model request, (2) the model decides which tools to call, (3) the worker executes tools and feeds results back, (4) the model iterates until it produces a final response or exhausts its budget. This follows OpenClaw's `runEmbeddedAttempt()` pattern but uses Nessie's existing Prisma/pgqueue/SSE/WebSocket infrastructure.

**Tech Stack:** TypeScript, Prisma, OpenAI-compatible API (tool calling), Zod, pgqueue, SSE, WebSocket

**Source document:** `docs/openclaw-architecture/overview.md` (the overnight OpenClaw deep-dive)

**Review notes:** This plan has been through 3 review rounds. Round 1 (12 reviewers): 18 gaps addressed in v2. Round 2 (15 reviewers — 5 Claude explore agents + 10 max, each reading actual source): 16 additional gaps addressed in v3. Round 3 (5 Claude explore agents, line-by-line source verification): 0 new CRITICAL/HIGH findings — plan is clean. All 3 deferred HIGHs verified as non-regressive. Changes marked with `[v2]`/`[v3]` annotations.

## Table of Contents

- [Foundations](./01-foundations.md)
- [Runtime Loop](./02-runtime-loop.md)
- [Delegation and Integration](./03-delegation-and-integration.md)
