-- Adds 'organization' as a valid principal type for MCP credential overrides
-- (spec: docs/external-tool-integration.md §4 — six principal types
-- user | agent | channel | team | project | organization).
-- Completes level 6 of the 7-level credential resolution chain.

-- AlterEnum
ALTER TYPE "McpCredentialPrincipalType" ADD VALUE 'organization';
