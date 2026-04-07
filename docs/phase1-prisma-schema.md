# Phase 1 Prisma Schema

> Status: active implementation reference.

## 1) Location

The Prisma schema lives at `api/prisma/schema.prisma`. The API service owns the database schema and migrations. Other services (`/worker`) connect to the same database but do not own migrations.

## 2) Conventions

- table names: snake_case plural (`users`, `organizations`, `agent_bindings`)
- column names: snake_case (`created_at`, `organization_id`)
- Prisma model names: PascalCase singular (`User`, `Organization`, `AgentBinding`)
- IDs: UUID v4, stored as `String @id @default(uuid()) @db.Uuid`
- timestamps: `DateTime @default(now())` for `created_at`, `DateTime @updatedAt` for `updated_at`
- enums: Prisma native enums, not string columns
- foreign keys: cascade delete only where the child is meaningless without the parent (e.g. messages without a thread); otherwise restrict
- soft deletes: not used in Phase 1; hard delete with foreign key protection
- indexes: explicit for query patterns described in the API surface

## 3) Schema

```prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

// ──────────────────────────────────────────
// Enums
// ──────────────────────────────────────────

enum AgentStatus {
  idle
  thinking
  executing
  waiting_approval
  error
  offline
}

enum RunStatus {
  pending
  running
  completed
  failed
  cancelled
}

enum TaskStatus {
  inbox
  assigned
  in_progress
  review
  done
  failed
  cancelled
  awaiting_approval
}

enum ChannelVisibility {
  public
  protected
  private
}

enum MessageRole {
  user
  assistant
  system
}

enum QueueJobStatus {
  pending
  processing
  done
  failed
  dead
}

// ──────────────────────────────────────────
// Identity and tenancy
// ──────────────────────────────────────────

model User {
  id            String   @id @default(uuid()) @db.Uuid
  email         String   @unique
  displayName   String   @map("display_name")
  passwordHash  String?  @map("password_hash")
  avatarUrl     String?  @map("avatar_url")
  pronouns      String?
  createdAt     DateTime @default(now()) @map("created_at")
  updatedAt     DateTime @updatedAt @map("updated_at")

  organizationMembers OrganizationMember[]
  projectMembers      ProjectMember[]
  teamMembers         TeamMember[]
  channelMembers      ChannelMember[]
  messages            Message[]

  @@map("users")
}

model Organization {
  id        String   @id @default(uuid()) @db.Uuid
  name      String
  createdAt DateTime @default(now()) @map("created_at")
  updatedAt DateTime @updatedAt @map("updated_at")

  members  OrganizationMember[]
  projects Project[]
  channels Channel[]

  @@map("organizations")
}

model OrganizationMember {
  id             String   @id @default(uuid()) @db.Uuid
  organizationId String   @map("organization_id") @db.Uuid
  userId         String   @map("user_id") @db.Uuid
  role           String   @default("member")
  createdAt      DateTime @default(now()) @map("created_at")

  organization Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  user         User         @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@unique([organizationId, userId])
  @@map("organization_members")
}

model Project {
  id             String   @id @default(uuid()) @db.Uuid
  name           String
  organizationId String   @map("organization_id") @db.Uuid
  createdAt      DateTime @default(now()) @map("created_at")
  updatedAt      DateTime @updatedAt @map("updated_at")

  organization Organization    @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  members      ProjectMember[]
  teams        Team[]

  @@map("projects")
}

model ProjectMember {
  id        String   @id @default(uuid()) @db.Uuid
  projectId String   @map("project_id") @db.Uuid
  userId    String   @map("user_id") @db.Uuid
  role      String   @default("member")
  createdAt DateTime @default(now()) @map("created_at")

  project Project @relation(fields: [projectId], references: [id], onDelete: Cascade)
  user    User    @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@unique([projectId, userId])
  @@map("project_members")
}

model Team {
  id        String   @id @default(uuid()) @db.Uuid
  name      String
  projectId String   @map("project_id") @db.Uuid
  createdAt DateTime @default(now()) @map("created_at")
  updatedAt DateTime @updatedAt @map("updated_at")

  project  Project      @relation(fields: [projectId], references: [id], onDelete: Cascade)
  members  TeamMember[]
  channels Channel[]

  @@map("teams")
}

model TeamMember {
  id        String   @id @default(uuid()) @db.Uuid
  teamId    String   @map("team_id") @db.Uuid
  userId    String   @map("user_id") @db.Uuid
  role      String   @default("member")
  createdAt DateTime @default(now()) @map("created_at")

  team Team @relation(fields: [teamId], references: [id], onDelete: Cascade)
  user User @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@unique([teamId, userId])
  @@map("team_members")
}

// ──────────────────────────────────────────
// Channels and messaging
// ──────────────────────────────────────────

model Channel {
  id             String            @id @default(uuid()) @db.Uuid
  label          String
  organizationId String            @map("organization_id") @db.Uuid
  teamId         String            @map("team_id") @db.Uuid
  visibility     ChannelVisibility @default(public)
  createdAt      DateTime          @default(now()) @map("created_at")
  updatedAt      DateTime          @updatedAt @map("updated_at")

  organization  Organization    @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  team          Team            @relation(fields: [teamId], references: [id], onDelete: Cascade)
  members       ChannelMember[]
  agentBindings AgentBinding[]
  threads       Thread[]

  @@map("channels")
}

model ChannelMember {
  id        String   @id @default(uuid()) @db.Uuid
  channelId String   @map("channel_id") @db.Uuid
  userId    String   @map("user_id") @db.Uuid
  createdAt DateTime @default(now()) @map("created_at")

  channel Channel @relation(fields: [channelId], references: [id], onDelete: Cascade)
  user    User    @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@unique([channelId, userId])
  @@map("channel_members")
}

model Thread {
  id        String   @id @default(uuid()) @db.Uuid
  channelId String   @map("channel_id") @db.Uuid
  title     String?
  createdAt DateTime @default(now()) @map("created_at")
  updatedAt DateTime @updatedAt @map("updated_at")

  channel  Channel   @relation(fields: [channelId], references: [id], onDelete: Cascade)
  messages Message[]
  runs     Run[]

  @@map("threads")
}

model Message {
  id        String      @id @default(uuid()) @db.Uuid
  threadId  String      @map("thread_id") @db.Uuid
  agentId   String?     @map("agent_id") @db.Uuid
  userId    String?     @map("user_id") @db.Uuid
  role      MessageRole
  content   String
  createdAt DateTime    @default(now()) @map("created_at")

  thread Thread @relation(fields: [threadId], references: [id], onDelete: Cascade)
  agent  Agent? @relation(fields: [agentId], references: [id], onDelete: SetNull)
  user   User?  @relation(fields: [userId], references: [id], onDelete: SetNull)

  @@index([threadId, createdAt])
  @@index([agentId, createdAt])
  @@map("messages")
}

// ──────────────────────────────────────────
// Agents
// ──────────────────────────────────────────

model Agent {
  id            String      @id @default(uuid()) @db.Uuid
  name          String
  role          String      @default("assistant")
  status        AgentStatus @default(idle)
  systemPrompt  String?     @map("system_prompt")
  toolPolicy    Json?       @map("tool_policy")
  parentAgentId String?     @map("parent_agent_id") @db.Uuid
  createdAt     DateTime    @default(now()) @map("created_at")
  updatedAt     DateTime    @updatedAt @map("updated_at")

  parentAgent Agent?  @relation("AgentHierarchy", fields: [parentAgentId], references: [id], onDelete: SetNull)
  childAgents Agent[] @relation("AgentHierarchy")

  bindings AgentBinding[]
  messages Message[]
  runs     Run[]
  tasks    Task[]

  @@map("agents")
}

model AgentBinding {
  id        String   @id @default(uuid()) @db.Uuid
  agentId   String   @map("agent_id") @db.Uuid
  channelId String   @map("channel_id") @db.Uuid
  createdAt DateTime @default(now()) @map("created_at")

  agent   Agent   @relation(fields: [agentId], references: [id], onDelete: Cascade)
  channel Channel @relation(fields: [channelId], references: [id], onDelete: Cascade)

  @@unique([agentId, channelId])
  @@map("agent_bindings")
}

// ──────────────────────────────────────────
// Runs and tasks
// ──────────────────────────────────────────

model Run {
  id        String    @id @default(uuid()) @db.Uuid
  agentId   String    @map("agent_id") @db.Uuid
  threadId  String    @map("thread_id") @db.Uuid
  status    RunStatus @default(pending)
  startedAt DateTime? @map("started_at")
  finishedAt DateTime? @map("finished_at")
  createdAt DateTime  @default(now()) @map("created_at")

  agent    Agent      @relation(fields: [agentId], references: [id], onDelete: Cascade)
  thread   Thread     @relation(fields: [threadId], references: [id], onDelete: Cascade)
  tasks    Task[]
  toolCalls ToolCall[]

  @@index([agentId, status])
  @@index([threadId, createdAt])
  @@map("runs")
}

model Task {
  id           String     @id @default(uuid()) @db.Uuid
  runId        String?    @map("run_id") @db.Uuid
  agentId      String     @map("agent_id") @db.Uuid
  parentTaskId String?    @map("parent_task_id") @db.Uuid
  status       TaskStatus @default(inbox)
  purpose      String?
  createdAt    DateTime   @default(now()) @map("created_at")
  updatedAt    DateTime   @updatedAt @map("updated_at")

  run        Run?        @relation(fields: [runId], references: [id], onDelete: SetNull)
  agent      Agent       @relation(fields: [agentId], references: [id], onDelete: Cascade)
  parentTask Task?       @relation("TaskHierarchy", fields: [parentTaskId], references: [id], onDelete: SetNull)
  childTasks Task[]      @relation("TaskHierarchy")
  events     TaskEvent[]

  @@index([agentId, status])
  @@index([runId])
  @@map("tasks")
}

model TaskEvent {
  id        String   @id @default(uuid()) @db.Uuid
  taskId    String   @map("task_id") @db.Uuid
  eventType String   @map("event_type")
  payload   Json     @default("{}")
  createdAt DateTime @default(now()) @map("created_at")

  task Task @relation(fields: [taskId], references: [id], onDelete: Cascade)

  @@index([taskId, createdAt])
  @@map("task_events")
}

model ToolCall {
  id           String   @id @default(uuid()) @db.Uuid
  runId        String   @map("run_id") @db.Uuid
  agentId      String   @map("agent_id") @db.Uuid
  toolName     String   @map("tool_name")
  inputSummary String   @map("input_summary")
  outputPreview String? @map("output_preview")
  success      Boolean?
  startedAt    DateTime @map("started_at")
  endedAt      DateTime? @map("ended_at")
  durationMs   Int?     @map("duration_ms")

  run Run @relation(fields: [runId], references: [id], onDelete: Cascade)

  @@index([runId, startedAt])
  @@index([agentId, startedAt])
  @@map("tool_calls")
}

// ──────────────────────────────────────────
// Queue (pgqueue adapter)
// ──────────────────────────────────────────
// This table is managed by raw SQL migrations, not Prisma models,
// because the dequeue query uses FOR UPDATE SKIP LOCKED which
// Prisma does not generate. The schema is here for documentation.
//
// See hosted-app-architecture.md section 4 for the full SQL schema
// and dequeue query.
//
// CREATE TABLE queue_jobs (
//   id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
//   topic TEXT NOT NULL,
//   payload JSONB NOT NULL,
//   status TEXT NOT NULL DEFAULT 'pending',
//   idempotency_key TEXT,
//   attempt INTEGER NOT NULL DEFAULT 0,
//   max_attempts INTEGER NOT NULL DEFAULT 3,
//   locked_until TIMESTAMPTZ,
//   enqueued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
//   started_at TIMESTAMPTZ,
//   completed_at TIMESTAMPTZ,
//   error_message TEXT,
//   UNIQUE(idempotency_key) WHERE idempotency_key IS NOT NULL
// );
```

## 4) Bootstrap seed data

On first bootstrap (see [deployment-modes-and-auth-spec.md](./deployment-modes-and-auth-spec.md) section 4.3a), the API creates these deterministic records:

| Entity | Deterministic ID | Name |
| --- | --- | --- |
| Organization | `00000000-0000-4000-8000-000000000001` | "Default Organization" |
| Project | `00000000-0000-4000-8000-000000000002` | "Default Project" |
| Team | `00000000-0000-4000-8000-000000000003` | "Default Team" |
| Channel | `00000000-0000-4000-8000-000000000004` | "General" |

The bootstrap user is created with a real UUID (not deterministic) and bound into all four records via membership tables.

## 5) Migration strategy

- Phase 1 uses Prisma Migrate for schema changes
- `npx prisma migrate dev` during development
- `npx prisma migrate deploy` in production/Docker
- the `queue_jobs` table is created in a raw SQL migration alongside the Prisma-managed tables
- migrations live at `api/prisma/migrations/`

## 6) Cross-links

- [shared-type-contracts-spec.md](./shared-type-contracts-spec.md) — enum values must match `AgentStatus`, `RunStatus`, `TaskStatus`
- [hosted-app-architecture.md](./hosted-app-architecture.md) — queue_jobs SQL schema
- [deployment-modes-and-auth-spec.md](./deployment-modes-and-auth-spec.md) — bootstrap flow
- [implementation-phases.md](./implementation-phases.md) — Phase 1 entity list
