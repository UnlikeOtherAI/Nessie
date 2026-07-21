# Individual Communications Connector — verbatim product spec (2026-07-21)

Individual Communications Connector

Slack, Microsoft Teams and Email Integration for Nessie or DeepSignal

1. Objective

Build a connector system that allows an individual user to connect their own:

* Slack account
* Microsoft Teams account
* Gmail account
* Microsoft 365/Outlook mailbox

Once connected, the user’s Chief of Staff can access only the information that the user has authorised and that the relevant platform permits.

The connector should:

1. Import an initial history.
2. Receive new messages and changes continuously.
3. Normalize data from every platform into a shared internal format.
4. maintain a private memory and operational model for that user.
5. Detect recurring questions, blockers, missing knowledge and inefficient working patterns.
6. Allow the user to disconnect the account and delete imported data.

The connector layer should remain separate from the Chief of Staff reasoning system.

⸻

2. Recommended Architecture

Slack OAuth ───────────┐
                      │
Teams OAuth ───────────┼──► Connector Gateway
                      │
Gmail OAuth ───────────┤
                      │
Outlook OAuth ─────────┘
                              │
                              ▼
                       Event Normalizer
                              │
                              ▼
                         Event Store
                              │
                ┌─────────────┴─────────────┐
                ▼                           ▼
          Search Index                Memory Extractor
                │                           │
                └─────────────┬─────────────┘
                              ▼
                     Chief of Staff Engine

The platform-specific connectors should not contain business intelligence. Their responsibility is authentication, retrieval, synchronization and normalization.

The Chief of Staff should consume one common event model regardless of whether a message originated in Slack, Teams or email.

⸻

3. Connection Model

Each connection should belong to:

Platform tenant
    └── Nessie user
          └── External identity
                └── OAuth connection

Example:

{
  "connection_id": "conn_123",
  "owner_user_id": "nessie_user_456",
  "provider": "slack",
  "external_tenant_id": "T012345",
  "external_user_id": "U012345",
  "status": "active",
  "granted_scopes": [],
  "initial_sync_completed_at": null,
  "cursor": null,
  "last_successful_sync_at": null
}

Never treat a Slack workspace or Microsoft tenant as a single connection. Many users from the same organisation may connect individually, with different visibility and permissions.

⸻

4. OAuth Flow

All providers should use a similar user experience:

1. User selects Connect Slack, Connect Microsoft or Connect Google.
2. Nessie creates a short-lived OAuth state record.
3. The user is redirected to the provider.
4. The provider displays the requested permissions.
5. The user approves access.
6. The provider returns an authorization code.
7. Your backend exchanges the code for tokens.
8. Tokens are encrypted and stored.
9. An initial synchronization job is created.
10. The user sees exactly what will be imported.

Use OAuth authorization-code flow with PKCE where supported.

The OAuth state value must be:

* Single-use
* Short-lived
* Cryptographically random
* Bound to the Nessie user
* Bound to the selected provider
* Validated before exchanging the code

Never send access or refresh tokens to the browser after the OAuth callback.

⸻

5. Shared Connector Interface

Every provider adapter should implement approximately the same interface:

interface CommunicationsConnector {
  connect(input: OAuthCallbackInput): Promise<Connection>;
  refreshCredentials(
    connection: Connection
  ): Promise<ConnectionCredentials>;
  discoverResources(
    connection: Connection
  ): Promise<Resource[]>;
  runInitialSync(
    connection: Connection,
    checkpoint?: SyncCheckpoint
  ): Promise<SyncResult>;
  runIncrementalSync(
    connection: Connection,
    checkpoint: SyncCheckpoint
  ): Promise<SyncResult>;
  processWebhook(
    request: WebhookRequest
  ): Promise<NormalizedEvent[]>;
  renewSubscriptions(
    connection: Connection
  ): Promise<void>;
  disconnect(
    connection: Connection
  ): Promise<void>;
}

A resource could be:

{
  "provider": "slack",
  "resource_type": "channel",
  "external_id": "C012345",
  "name": "engineering",
  "visibility": "private",
  "user_has_access": true,
  "sync_enabled": true
}

⸻

6. Normalized Communication Model

Normalize Slack messages, Teams messages and emails into a shared structure.

{
  "event_id": "evt_123",
  "provider": "slack",
  "connection_id": "conn_123",
  "tenant_id": "external-tenant-id",
  "conversation_id": "external-conversation-id",
  "thread_id": "external-thread-id",
  "message_id": "external-message-id",
  "event_type": "message.created",
  "timestamp": "2026-07-21T10:30:00Z",
  "sender": {
    "external_id": "U123",
    "display_name": "Sarah",
    "email": null
  },
  "participants": [],
  "subject": null,
  "content_text": "Where is the latest deployment document?",
  "content_html": null,
  "attachments": [],
  "mentions": [],
  "reactions": [],
  "visibility": "private-channel",
  "source_url": null,
  "raw_payload_reference": "blob://encrypted/provider/raw/123"
}

Keep the normalized representation separate from the original provider payload. The original may be needed for debugging, message edits, compliance investigations or reprocessing.

⸻

7. Slack Connector

7.1 Use a Slack App

Create one multi-tenant Slack app. Each person connects that app to their Slack identity through Slack OAuth.

A single Slack app can support many users and workspaces. Each installation produces a separate authorization record.

Slack OAuth supports separate:

* Bot scopes
* User scopes

For the individual Chief of Staff use case, a user authorization is more relevant than relying only on a bot. A bot generally sees conversations in which the bot participates. A user-authorized connection can operate in the context of the authenticated user, subject to Slack’s scopes, API restrictions and app-distribution rules. (Slack API)

7.2 Slack Access Modes

Support two distinct modes.

Personal mode

The Chief of Staff works for one user.

It may process:

* Conversations exposed to the authenticated user token
* Public channels available to that user
* Private channels in which the user participates, where permitted
* Direct and group messages where permitted
* Threads and replies
* Messages found through permitted user-context search

Slack’s Real-time Search API can search on behalf of the authenticated user and return content the user is allowed to access. However, Slack currently restricts this API to qualifying directory-published or internal apps, so it should not be treated as universally available to every new distributed app. (Slack API)

Workspace mode

A company administrator installs and approves broader access.

This is a separate enterprise feature and should not silently replace personal authorization. Store the resulting workspace-level connection separately from personal connections.

7.3 Initial Slack Import

The initial synchronization should:

1. Resolve the authenticated user and workspace.
2. Discover conversations the connection can enumerate.
3. Let the user choose whether to include:
    * Public channels
    * Private channels
    * Direct messages
    * Group direct messages
4. Fetch channel history page by page.
5. Fetch thread replies.
6. Store users and channel metadata.
7. Record cursors and per-conversation checkpoints.
8. Continue asynchronously until the selected history window is complete.

Slack’s Conversations API provides a unified model for public channels, private channels, DMs and group DMs. Message history is retrieved through conversation-history endpoints, subject to token type, membership, scopes and rate limits. (Slack API)

Do not assume that an individual OAuth grant allows you to dump every message in the workspace.

7.4 Ongoing Slack Updates

Use Slack’s Events API for near-real-time updates where the granted authorization supports the required events.

Your webhook should:

1. Verify the Slack request signature.
2. Reject stale requests.
3. Acknowledge quickly.
4. Put the event onto a queue.
5. Deduplicate using Slack event identifiers.
6. Process the event asynchronously.

Slack supports HTTP event delivery or Socket Mode. For a production multi-tenant cloud service, signed HTTPS event delivery is usually the cleaner option. (Slack API)

Also run periodic reconciliation because webhooks are not a perfect database replication mechanism.

7.5 Slack Limitations

Account for:

* Channel membership restrictions
* Private-channel restrictions
* Different bot and user-token behaviour
* App-review and distribution requirements
* API rate limits
* Enterprise Grid variations
* Edited and deleted messages
* Slack Connect channels
* Retention policies
* Users disconnecting or leaving a workspace

Do not implement Slack synchronization as unrestricted “scraping.”

⸻

8. Microsoft Teams Connector

8.1 Use Microsoft Entra ID and Microsoft Graph

Register a multi-tenant application in Microsoft Entra ID.

Use Microsoft identity OAuth and Microsoft Graph for:

* Teams
* Chats
* Channels
* Email, when the user uses Microsoft 365

This allows one Microsoft connection to authorize both Teams and Outlook, although the UI should still let the user enable or disable each data source separately.

8.2 Delegated vs Application Permissions

For individual connections, use delegated permissions wherever possible.

Delegated permission means:

The application acts on behalf of the signed-in user and is limited by both the granted scope and that user’s actual permissions.

Application permissions mean:

The application acts independently of a user and may access organisation-wide data.

Application permissions normally require administrator consent and should be reserved for an organisation-wide deployment.

Microsoft Graph permissions are granular, and some Teams operations or tenant-wide message subscriptions are available only through application permissions. (Microsoft Learn)

8.3 Initial Teams Import

The personal Teams connector should:

1. Resolve the signed-in Microsoft identity.
2. List chats available to that user.
3. List joined teams.
4. List available channels.
5. Fetch messages for the resources the user selects.
6. Fetch replies and message metadata.
7. Capture membership and participant identities.
8. Store per-chat and per-channel synchronization checkpoints.

Treat these as separate resource categories:

One-to-one chats
Group chats
Meeting chats
Team channels
Shared channels
Private channels

Permissions and API behaviour can differ between them.

Do not promise that a delegated personal connection can access every message visible anywhere in the Microsoft Teams UI. Validate each resource type against Microsoft Graph and expose unsupported resources clearly in the connection screen.

8.4 Ongoing Teams Updates

Use Microsoft Graph change notifications.

Subscriptions can deliver updates for:

* Chat changes
* Chat messages
* Channel messages
* Outlook messages

Some subscriptions work at a particular chat or channel level. Tenant-wide subscriptions such as all channel messages or all chats require application permissions rather than normal delegated personal access. (Microsoft Learn)

Build a subscription manager that:

* Creates subscriptions after connection
* Stores subscription IDs and expiry times
* Renews them before expiration
* Verifies clientState
* Handles validation requests
* Processes lifecycle notifications
* Recreates lost subscriptions
* Runs periodic reconciliation

Microsoft Graph subscriptions expire and must be renewed. Subscription renewal should be a first-class scheduled service, not an afterthought.

8.5 Teams Personal-Connection Strategy

For the first version:

1. Use delegated OAuth.
2. Import chats and channels available through delegated APIs.
3. Create resource-level subscriptions where supported.
4. Poll or reconcile resources that cannot be subscribed to cleanly.
5. Offer an optional administrator-approved organisation mode later.

Do not start with organisation-wide application permissions. They greatly increase the security, compliance and enterprise-sales burden.

⸻

9. Gmail Connector

9.1 Google OAuth

Create a Google Cloud project and configure the OAuth consent screen.

Request the minimum Gmail scope required by the product.

For a Chief of Staff that must read email content, metadata-only scopes will generally not be sufficient. Gmail scopes that expose message content are sensitive or restricted and can trigger Google verification and possibly a security assessment, depending on how the application stores or transmits the data. Use the narrowest viable scope and plan verification early. (Google for Developers)

9.2 Initial Gmail Import

The import flow should:

1. Resolve the Gmail identity.
2. Ask the user which history period to import.
3. Optionally allow label selection.
4. List message IDs incrementally.
5. Fetch message metadata and content.
6. Reconstruct threads.
7. Extract participants, dates, labels and attachments.
8. Record Gmail historyId.
9. Mark initial synchronization complete.

Reasonable history options:

* From today
* Last 30 days
* Last 90 days
* Last year
* All available mail

Avoid defaulting to an entire mailbox import.

9.3 Gmail Incremental Updates

Use Gmail push notifications.

The Gmail API uses Google Cloud Pub/Sub. Gmail notifies your backend that the mailbox changed, and your backend then uses the mailbox history API to determine what changed. (Google for Developers)

The flow is:

Gmail mailbox changes
        ↓
Google Pub/Sub notification
        ↓
Connector receives new historyId
        ↓
Fetch changes since previous historyId
        ↓
Normalize new, edited or deleted messages

Gmail watches must be renewed. Store watch expiration and schedule renewal before it lapses.

If the stored historyId becomes too old or invalid, perform a bounded resynchronization rather than silently losing messages.

⸻

10. Microsoft Outlook Email Connector

Use the same Microsoft Entra application and Graph authorization used by Teams.

For an individual connection, request delegated email access such as the minimum viable read scope.

The initial import should:

1. Resolve mailbox folders.
2. Import the selected history range.
3. Normalize conversation and message identifiers.
4. Preserve folder and category metadata.
5. Record a delta synchronization checkpoint.
6. Create a Microsoft Graph subscription for new message activity.

Microsoft Graph supports Outlook message change notifications using delegated permissions for the signed-in user’s mailbox. A delegated subscription does not grant general access to everybody else’s mailbox. (Microsoft Learn)

Use both:

* Change notifications for low latency
* Delta queries or periodic reconciliation for correctness

⸻

11. Generic IMAP Connector

IMAP can be offered later for providers without a native connector.

However, it should not be the preferred implementation because:

* Authentication varies by provider.
* OAuth support is inconsistent.
* Webhooks are generally unavailable.
* Mailbox synchronization is more difficult.
* Thread reconstruction is unreliable.
* Provider-specific labels and categories may be lost.
* Long-lived connections can be fragile.
* Password-based authentication creates security risk.

Prioritize:

1. Gmail API
2. Microsoft Graph
3. Generic IMAP only as a fallback

Never ask users for their normal mailbox password. Use provider OAuth or application-specific credentials where required.

⸻

12. Initial Synchronization Pipeline

Large imports must be resumable.

Connection created
      ↓
Resource discovery
      ↓
User selects data scope
      ↓
Create one sync job per resource
      ↓
Fetch a page
      ↓
Normalize
      ↓
Persist checkpoint
      ↓
Queue extraction/indexing
      ↓
Fetch next page

Each job should record:

{
  "connection_id": "conn_123",
  "resource_id": "channel_456",
  "phase": "history",
  "cursor": "provider-cursor",
  "oldest_imported_at": "2026-01-01T00:00:00Z",
  "newest_imported_at": "2026-07-21T00:00:00Z",
  "status": "running",
  "retry_count": 0
}

A failed import should resume from its last successful checkpoint, not restart from the beginning.

⸻

13. Incremental Synchronization

Use a hybrid model:

Provider webhook
      ↓
Fast ingestion queue
      ↓
Fetch missing resource if necessary
      ↓
Normalize and deduplicate
      ↓
Update index and memory candidates

Plus:

Periodic reconciliation
      ↓
Check provider cursor or delta token
      ↓
Recover missed changes

Never depend solely on webhooks.

Webhooks may be duplicated, delayed, delivered out of order or temporarily unavailable.

⸻

14. Deduplication and Message Identity

Create a deterministic provider key:

provider
tenant ID
conversation ID
message ID

For example:

slack:T123:C456:1721550000.000100

Store event version separately so edits do not create unrelated messages.

{
  "canonical_message_id": "slack:T123:C456:1721550000.000100",
  "version": 3,
  "is_deleted": false,
  "edited_at": "2026-07-21T11:00:00Z"
}

The ingestion path must be idempotent.

⸻

15. Attachments and Linked Files

Do not automatically download every attachment during initial synchronization.

Store:

* Filename
* MIME type
* Size
* Provider identifier
* Source message
* Access status
* Expiry information
* A retrieval reference

Fetch and process the attachment only when:

* It is relevant to an active investigation.
* It is selected by the user.
* It is within configured file types and size limits.
* Malware scanning has completed.
* The user’s authorization remains valid.

Treat externally shared links differently from provider-hosted attachments.

⸻

16. Token and Credential Security

OAuth tokens are effectively keys to the user’s working life.

Requirements:

* Encrypt tokens using envelope encryption.
* Keep encryption keys in a cloud key-management service.
* Separate token storage from message storage.
* Never log access or refresh tokens.
* Rotate application secrets.
* Restrict token decryption to connector workers.
* Record every token use in an audit log.
* Revoke tokens during disconnection.
* Detect repeated refresh failures.
* Mark connections as requiring reauthorization.
* Prevent cross-tenant token access in code and database policies.

A suggested credential record:

{
  "connection_id": "conn_123",
  "access_token_ciphertext": "...",
  "refresh_token_ciphertext": "...",
  "expires_at": "2026-07-21T12:00:00Z",
  "key_version": "kms-key-7",
  "scope_hash": "..."
}

⸻

17. User Controls

The connection settings must show:

* Connected identity
* Connected organisation or workspace
* Granted permissions
* Included channels, chats, folders or labels
* Imported history range
* Last successful synchronization
* Current connection health
* Data categories being analysed
* Disconnect button
* Delete imported data button

Allow users to exclude:

* Particular Slack channels
* Particular Teams chats
* Direct messages
* Specific email labels or folders
* Messages from selected senders
* Attachments
* Historical data before a chosen date

The user should be able to see representative examples of what the Chief of Staff can access.

⸻

18. Private and Shared Conversations

Access does not automatically mean that every use of the information is appropriate.

For personal Chief of Staff deployments:

* Keep private-message insights private to the connected user.
* Do not expose one person’s DMs in reports to another employee.
* Do not quote private conversations into public channels automatically.
* Track the original visibility of every message.
* Propagate visibility restrictions into derived memories.
* Prevent a private source from being used in a wider audience response unless policy explicitly permits it.

Every derived fact should retain provenance:

{
  "fact": "The deployment guide is difficult to locate.",
  "source_visibility": [
    "private-channel",
    "direct-message"
  ],
  "permitted_audiences": [
    "connected-user"
  ]
}

When aggregating patterns for an organisation, use minimum-group-size and anonymisation rules so a manager cannot infer who made a sensitive comment.

⸻

19. Chief of Staff Boundary

The connector sends normalized events to the Chief of Staff, but it should not send every new message directly to a large model.

Use this sequence:

Message received
      ↓
Cheap deterministic processing
      ↓
Conversation/thread update
      ↓
Pattern candidate extraction
      ↓
Relevant memory retrieval
      ↓
LLM analysis only when justified

The connector should produce signals such as:

* Question asked
* Question answered
* Document requested
* Blocker mentioned
* Ownership requested
* Decision made
* Correction issued
* Repeated explanation
* Request left unanswered
* Handover detected
* Manual task described

The Chief of Staff can then examine clusters rather than repeatedly rereading the entire message archive.

⸻

20. Recommended Delivery Phases

Phase 1: Gmail and Slack Personal Connections

Implement:

* OAuth
* Initial history import
* Incremental synchronization
* Normalized conversations
* Token encryption
* User-controlled exclusions
* Disconnect and delete
* Basic repeated-question detection

This proves the connector architecture with two substantially different providers.

Phase 2: Microsoft Graph

Add:

* Teams chats
* Teams channels
* Outlook email
* Graph change notifications
* Subscription renewal
* Delta reconciliation

Use a single Microsoft identity connection with separate Teams and Mail feature toggles.

Phase 3: Enterprise Administration

Add:

* Admin approval
* Workspace or tenant installation
* Organisational policies
* Group-based rollout
* Data-region controls
* Central retention
* Audit exports
* Aggregated organisational insights

Phase 4: Additional Systems

Add connectors such as:

* Jira
* Linear
* GitHub
* GitLab
* Confluence
* Notion

These should reuse the same connection, event, resource, cursor and webhook architecture.

⸻

21. Recommended Technical Components

OAuth Gateway
Provider Adapter Service
Webhook Gateway
Subscription Renewal Service
Initial-Sync Workers
Incremental-Sync Workers
Dead-Letter Queue
Encrypted Credential Store
Raw Event Store
Normalized Event Store
Search Index
Memory Extraction Queue
Audit Service
Connection Health Monitor
Data Deletion Service

Use queues between ingestion and processing so Slack, Microsoft or Google traffic cannot overload the reasoning system.

Partition jobs by:

provider + tenant + connection

This preserves ordering while allowing different customers to process concurrently.

⸻

22. MVP API Surface

POST /connections/slack/start
GET  /connections/slack/callback
POST /connections/google/start
GET  /connections/google/callback
POST /connections/microsoft/start
GET  /connections/microsoft/callback
GET  /connections
GET  /connections/{connectionId}
PATCH /connections/{connectionId}/resources
POST /connections/{connectionId}/resync
DELETE /connections/{connectionId}
DELETE /connections/{connectionId}/data
POST /webhooks/slack
POST /webhooks/google/pubsub
POST /webhooks/microsoft-graph

Internal worker interfaces:

POST /internal/sync/initial
POST /internal/sync/incremental
POST /internal/subscriptions/renew
POST /internal/events/normalize
POST /internal/memory/extract

⸻

23. Core Product Principle

The connector should follow the user rather than impersonating an all-seeing company administrator.

For every item processed, the system must be able to answer:

1. Which user connected the account?
2. Which provider granted the access?
3. Which permission allowed this item to be read?
4. Was the user entitled to see it?
5. Where did the information originate?
6. Who may see any derived insight?
7. How can the information be deleted?

The resulting system gives each employee a private Chief of Staff that understands their working context, while preserving a clean upgrade path to administrator-approved organisational intelligence.