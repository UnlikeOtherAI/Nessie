# Executor management verification

The detail page owns Agents, Sessions, Permissions and Activity. Sharing follows
[executor sharing](../standards/executor-sharing.md). There are no capability
review badges or review dialogs on the admin assignment path.

Run pnpm --filter @nessie/admin test:e2e:executor-detail on the worktree's
fixed ports. The real page is exercised headlessly at 1280 and 390 pixels:
people can receive use/admin access, projects receive use access, the current
team has one switch, and each action applies without a confirmation dialog.
Activity, conversation links, standing ticket access and local-model dialogs
remain covered. Screenshots are in e2e/screenshots/executor-detail/.

The executor-manage database suite proves authorization, project-scoped runtime
use, team administrators' conditional visibility, membership removal and
revocation fences. Browser fixtures establish layout and interaction, not native
installation or signed daemon connectivity.
