# Video Calling — Implementation Document

> Jitsi Meet integration for Nessie channels. Voice/video calls available in any channel with real human participants.

## Overview

Every channel containing at least one real user (not agent-only) gets a call button in the header toolbar. Clicking it creates or joins a Jitsi room scoped to that channel. The call state is tracked server-side and broadcast via the existing realtime infrastructure so all channel members see who's in a call.

---

## 1. Architecture

```
┌─────────────────────────────────────────────────┐
│ Admin UI (ChannelsPage)                          │
│                                                  │
│  [header toolbar]  ──► Call button (phone icon)  │
│                        │                         │
│                        ▼                         │
│  [CallOverlay]   ──► Jitsi iframe (External API) │
│                        │                         │
│                        ▼                         │
│  [CallBanner]    ──► "Call in progress" bar       │
└──────────┬──────────────────────────────────────┘
           │  HTTP + SSE/WS
           ▼
┌──────────────────────────────────────────────────┐
│ API Server (port 5554)                           │
│                                                  │
│  POST /api/channels/:id/call      → create call  │
│  DELETE /api/channels/:id/call    → end call      │
│  POST /api/calls/:id/join        → join call      │
│  POST /api/calls/:id/leave       → leave call     │
│  GET  /api/calls/:id             → call state     │
│                                                  │
│  Realtime events:                                │
│    call.started, call.joined,                    │
│    call.left, call.ended                         │
└──────────┬──────────────────────────────────────┘
           │
           ▼
┌──────────────────────────────────────────────────┐
│ Jitsi Meet                                       │
│  Phase 1: meet.jit.si (public)                   │
│  Phase 2: self-hosted meet.yourdomain.com (JWT)  │
└──────────────────────────────────────────────────┘
```

---

## 2. Database Schema

New model in `api/prisma/schema.prisma`:

```prisma
model Call {
  id            String   @id @default(uuid()) @db.Uuid
  channelId     String   @db.Uuid
  roomId        String   @unique                        // Jitsi room identifier
  status        String   @default("active")             // active | ended
  startedById   String   @db.Uuid                       // user who initiated
  startedAt     DateTime @default(now())
  endedAt       DateTime?

  channel       Channel        @relation(fields: [channelId], references: [id])
  startedBy     User           @relation("CallStarter", fields: [startedById], references: [id])
  participants  CallParticipant[]

  @@index([channelId])
  @@index([status])
}

model CallParticipant {
  id       String    @id @default(uuid()) @db.Uuid
  callId   String    @db.Uuid
  userId   String    @db.Uuid
  joinedAt DateTime  @default(now())
  leftAt   DateTime?

  call     Call      @relation(fields: [callId], references: [id])
  user     User      @relation(fields: [userId], references: [id])

  @@unique([callId, userId])
}
```

Add relations to existing models:

```prisma
// In Channel model, add:
calls  Call[]

// In User model, add:
callsStarted      Call[]            @relation("CallStarter")
callParticipants   CallParticipant[]
```

---

## 3. API Contracts

Add to `api/src/contracts.ts`:

```typescript
export const CallRecordSchema = z.object({
  id: z.string().uuid(),
  channelId: ChannelIdSchema,
  roomId: z.string(),
  status: z.enum(['active', 'ended']),
  startedById: UserIdSchema,
  startedAt: TimestampSchema,
  endedAt: TimestampSchema.nullable(),
  participants: z.array(z.object({
    userId: UserIdSchema,
    displayName: z.string(),
    joinedAt: TimestampSchema,
    leftAt: TimestampSchema.nullable(),
  })),
})
export type CallRecord = z.infer<typeof CallRecordSchema>
```

---

## 4. API Endpoints

### `POST /api/channels/:channelId/call`

Create a new call for the channel. Fails if an active call already exists.

**Response:** `CallRecord`

**Logic:**
1. Verify channel exists and user is a member
2. Verify channel has at least one other real user (not agent-only)
3. Check no active call exists for this channel
4. Generate `roomId` = `nessie-<channelId>-<shortUuid>`
5. Create `Call` row with status `active`
6. Create `CallParticipant` for the initiator
7. Emit `call.started` event via realtime hub
8. Return call record

### `POST /api/calls/:callId/join`

Join an existing active call.

**Response:** `CallRecord`

**Logic:**
1. Verify call is active
2. Verify user is a member of the call's channel
3. Upsert `CallParticipant` (clear `leftAt` if rejoining)
4. Emit `call.joined` event
5. Return updated call record

### `POST /api/calls/:callId/leave`

Leave a call. If last participant leaves, end the call.

**Response:** `CallRecord`

**Logic:**
1. Set `leftAt` on participant row
2. Emit `call.left` event
3. If no active participants remain, set call `status = 'ended'`, set `endedAt`, emit `call.ended`
4. Return updated call record

### `DELETE /api/channels/:channelId/call`

Force-end the active call (only call starter or channel admin).

**Response:** `CallRecord`

**Logic:**
1. Set `leftAt` on all active participants
2. Set call `status = 'ended'`, `endedAt = now()`
3. Emit `call.ended` event

### `GET /api/calls/:callId`

Get current call state including participants.

**Response:** `CallRecord`

---

## 5. Realtime Events

Extend the existing SSE/WebSocket event types. Events are scoped to the channel.

| Event | Payload | When |
|---|---|---|
| `call.started` | `{ callId, channelId, roomId, startedBy }` | New call created |
| `call.joined` | `{ callId, channelId, userId, displayName }` | User joins |
| `call.left` | `{ callId, channelId, userId }` | User leaves |
| `call.ended` | `{ callId, channelId, endedAt }` | Call terminated |

These flow through the existing `RealtimeHub` with channel scope, so only channel members receive them.

---

## 6. Frontend — Admin UI

### 6.1 Call Button (ChannelsPage header)

Location: `admin/src/pages/ChannelsPage.tsx`, header toolbar (after the member avatars, before the search icon — line ~474).

**Visibility rule:** Show only when `channelUsers.length >= 2` (at least 2 real users in channel, including current user) OR when `activeChannel.type === 'dm'` and the other member is a real user.

```
[member avatars] [call button] | [search] [menu]
```

Button states:
- **Idle** — Phone icon, muted color. Click starts a call.
- **Active call (not joined)** — Phone icon with green pulse dot. "Join call" tooltip. Click joins.
- **Active call (joined)** — Phone icon filled/highlighted. Click opens call overlay if minimized.
- **Disabled** — Greyed out when channel has < 2 real users.

### 6.2 Call Overlay

A resizable overlay panel that appears in the top-right of the chat area when the user is in a call. Contains the Jitsi iframe.

```
┌──────────────────────────────────────────┐
│ Channel Chat                             │
│                        ┌────────────────┐│
│                        │ Jitsi iframe   ││
│  messages...           │                ││
│                        │  video tiles   ││
│                        │                ││
│                        │ [minimize][x]  ││
│                        └────────────────┘│
│                                          │
│ [compose bar]                            │
└──────────────────────────────────────────┘
```

- Default size: 400x300px, resizable and draggable
- Minimize collapses to a small floating pill showing call duration
- Close (x) triggers leave call confirmation
- Uses `JitsiMeetExternalAPI` for iframe embedding

### 6.3 Call Banner

When a call is active in the channel but the current user hasn't joined, show a banner below the header:

```
┌──────────────────────────────────────────┐
│ Call in progress — Alice, Bob  [Join]    │
└──────────────────────────────────────────┘
```

- Green background, shows participant names
- "Join" button opens the call overlay
- Dismissable but reappears on new participant joins

### 6.4 System Message

When a call starts or ends, insert a system message into the thread:

- **Start:** "Alice started a call" (with join button inline)
- **End:** "Call ended — 12 min, 3 participants"

---

## 7. Frontend — Hooks & State

### `admin/src/facades/calls/hooks.ts`

```typescript
// Query active call for a channel
useActiveCall(channelId: string): { call: CallRecord | null, isLoading: boolean }

// Mutations
useStartCall(): { mutate(channelId: string) }
useJoinCall(): { mutate(callId: string) }
useLeaveCall(): { mutate(callId: string) }
useEndCall(): { mutate(channelId: string) }
```

### `admin/src/facades/calls/CallContext.tsx`

React context tracking the current user's active call state across channel navigation:

```typescript
interface CallState {
  activeCallId: string | null
  channelId: string | null
  roomId: string | null
  jitsiDomain: string        // 'meet.jit.si' or self-hosted
  isMinimized: boolean
  participants: CallParticipant[]
}
```

This context persists when navigating between channels so the call overlay stays visible.

---

## 8. Jitsi Integration

### 8.1 Phase 1 — Public Server (MVP)

Domain: `meet.jit.si`

```typescript
const api = new JitsiMeetExternalAPI('meet.jit.si', {
  roomName: call.roomId,
  parentNode: overlayRef.current,
  width: '100%',
  height: '100%',
  configOverwrite: {
    startWithAudioMuted: true,
    startWithVideoMuted: true,
    disableDeepLinking: true,
    prejoinPageEnabled: false,
  },
  interfaceConfigOverwrite: {
    SHOW_JITSI_WATERMARK: false,
    SHOW_BRAND_WATERMARK: false,
    TOOLBAR_BUTTONS: [
      'microphone', 'camera', 'desktop',
      'chat', 'raisehand', 'tileview',
      'hangup',
    ],
  },
  userInfo: {
    displayName: currentUser.displayName,
    email: currentUser.email,
  },
})
```

Load the external API script dynamically:

```typescript
// Load once, cache the promise
function loadJitsiScript(domain: string): Promise<void> {
  if (document.querySelector('script[data-jitsi]')) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const s = document.createElement('script')
    s.src = `https://${domain}/external_api.js`
    s.dataset.jitsi = '1'
    s.onload = () => resolve()
    s.onerror = reject
    document.head.appendChild(s)
  })
}
```

### 8.2 Jitsi Event Hooks

Sync Jitsi iframe events back to our API:

```typescript
api.addEventListener('videoConferenceJoined', () => {
  joinCallMutation.mutate(callId)
})

api.addEventListener('videoConferenceLeft', () => {
  leaveCallMutation.mutate(callId)
})

api.addEventListener('participantJoined', (e) => {
  // Update local participant list for banner display
})

api.addEventListener('readyToClose', () => {
  // User clicked hangup in Jitsi UI
  leaveCallMutation.mutate(callId)
  setCallState(prev => ({ ...prev, activeCallId: null }))
})
```

### 8.3 Phase 2 — Self-Hosted with JWT

When self-hosting:

1. Deploy Jitsi via Docker (`docker-jitsi-meet`) on a dedicated subdomain
2. Enable JWT auth in Prosody config
3. API generates signed JWT per call join:

```typescript
// api/src/services/calls.ts
function generateJitsiToken(user: User, roomId: string): string {
  return jwt.sign({
    aud: 'jitsi',
    iss: 'nessie',
    sub: JITSI_DOMAIN,
    room: roomId,
    exp: Math.floor(Date.now() / 1000) + 3600,
    context: {
      user: {
        name: user.displayName,
        email: user.email,
        moderator: false, // true for call starter
      },
    },
  }, JITSI_JWT_SECRET)
}
```

4. Frontend passes JWT in options:

```typescript
const options = {
  roomName: call.roomId,
  jwt: tokenFromApi,
  // ... rest same as phase 1
}
```

---

## 9. Room ID Strategy

Format: `nessie-<channelId-short>-<timestamp-hex>`

- Prefix `nessie-` prevents collisions on public Jitsi
- `channelId-short` = first 8 chars of channel UUID
- `timestamp-hex` = hex-encoded unix timestamp for uniqueness per call
- Example: `nessie-a1b2c3d4-18f3a2b0`

Each new call gets a fresh room ID. Re-joining an active call reuses the existing room ID.

---

## 10. Eligibility Rules

A channel is **call-eligible** when:

| Channel Type | Condition |
|---|---|
| `dm` | The other member is a real user (not an agent-only DM) |
| `standard` | `channelUsers.length >= 2` (at least 2 real human members) |

Agent-only channels never show the call button. Agents do not participate in video calls.

The API enforces this server-side — `POST /api/channels/:id/call` returns `400` if the channel doesn't meet eligibility.

---

## 11. Edge Cases

| Scenario | Behavior |
|---|---|
| User navigates away from channel during call | Call overlay persists (floating, via CallContext) |
| User refreshes page during call | Re-fetch active call for channel, show "Rejoin" banner |
| Last participant hangs up | Call auto-ends, `call.ended` event emitted |
| Call starter leaves | Call continues, any participant can end it |
| Two users click "Start call" simultaneously | First wins (DB unique constraint on active call per channel), second gets "Join" |
| Network disconnect during call | Jitsi handles reconnection internally; if permanent, participant times out |
| Channel deleted during call | Call force-ended via cascade |

---

## 12. Configuration

Environment variables (`.env`):

```env
# Phase 1 (public)
JITSI_DOMAIN=meet.jit.si

# Phase 2 (self-hosted)
JITSI_DOMAIN=meet.yourdomain.com
JITSI_JWT_SECRET=<shared-secret>
JITSI_JWT_ISSUER=nessie
```

---

## 13. Implementation Phases

### Phase 1 — MVP (public Jitsi, embedded iframe)

1. **Database** — Add `Call` and `CallParticipant` models, run migration
2. **API service** — `api/src/services/calls.ts` with create/join/leave/end logic
3. **API routes** — Wire up the 5 endpoints in `api/src/index.ts`
4. **Realtime events** — Add `call.*` event types to the hub
5. **Frontend hooks** — `admin/src/facades/calls/hooks.ts`
6. **Frontend context** — `admin/src/facades/calls/CallContext.tsx`
7. **Call button** — Add phone icon to `ChannelsPage.tsx` header toolbar
8. **Call banner** — "Call in progress" strip below header
9. **Call overlay** — Jitsi iframe container with minimize/close
10. **System messages** — "Started a call" / "Call ended" in thread
11. **Jitsi script loader** — Dynamic `external_api.js` loading
12. **Jitsi event sync** — Wire iframe events to API mutations

### Phase 2 — Self-Hosted + Auth

13. **Jitsi deployment** — Docker stack on dedicated server/subdomain
14. **JWT generation** — Server-side token signing for room auth
15. **Moderator controls** — Call starter gets moderator role in Jitsi
16. **Prosody config** — JWT validation, room creation restrictions

### Phase 3 — Polish

17. **Call history** — Past calls listed in channel, with duration and participant count
18. **Notifications** — Push/sound notification when someone starts a call in your channel
19. **Picture-in-picture** — Minimize call to a small floating window
20. **TURN server** — Deploy coturn for NAT traversal reliability
21. **Screen sharing** — Already supported by Jitsi, just ensure toolbar button is included
22. **Recording** — Jibri integration for call recording (self-hosted only)

---

## 14. Files to Create/Modify

### New files

| File | Purpose |
|---|---|
| `api/prisma/migrations/YYYYMMDD_add_calls/migration.sql` | Database migration |
| `api/src/services/calls.ts` | Call business logic |
| `admin/src/facades/calls/hooks.ts` | React Query hooks for call API |
| `admin/src/facades/calls/CallContext.tsx` | Global call state context |
| `admin/src/components/shared/CallOverlay.tsx` | Jitsi iframe wrapper |
| `admin/src/components/shared/CallBanner.tsx` | "Call in progress" banner |
| `admin/src/lib/jitsi.ts` | Script loader + Jitsi API helpers |

### Modified files

| File | Change |
|---|---|
| `api/prisma/schema.prisma` | Add `Call`, `CallParticipant` models + relations |
| `api/src/contracts.ts` | Add `CallRecordSchema` |
| `api/src/index.ts` | Add call endpoints |
| `api/src/realtime/hub.ts` | Add `call.*` event types |
| `admin/src/pages/ChannelsPage.tsx` | Add call button to header, call banner below header |
| `admin/src/router.tsx` | Wrap with `CallProvider` |
| `admin/src/lib/api-client.ts` | Add call API methods |
| `packages/schemas/src/index.ts` | Add `CallIdSchema` |

---

## 15. Dependencies

### Frontend

```
# No new packages — Jitsi External API loaded via script tag
# TypeScript types:
pnpm --filter @nessie/admin add -D @types/jitsi-meet
```

> Note: `@types/jitsi-meet` may not exist on npm. If not, create a local type declaration in `admin/src/types/jitsi.d.ts`.

### Backend

```
# JWT signing (Phase 2 only):
pnpm --filter @nessie/api add jsonwebtoken
pnpm --filter @nessie/api add -D @types/jsonwebtoken
```

Phase 1 requires zero new backend dependencies.
