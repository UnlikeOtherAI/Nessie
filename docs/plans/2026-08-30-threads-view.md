# Threads view

`/threads` is the home for reply conversations a person follows. Its doorway is
the **Threads** row and unread badge in the Channels sidebar; mention alerts
also deep-link directly to their reply conversation.

The inbox is an entitlement-scoped, fail-closed read model. It includes a
followed root only when the caller can read the root and its individual reply
records under the ordinary disclosure-and-grant predicate. It never exposes a
materialised root count, participant list, author, or preview for a withheld
reply. A direct mention follows that conversation for both human and agent
authors; alert read state remains separate from conversation membership.

Rows order by their latest visible, non-self-authored reply. Their unread state
uses a `(lastReadAt, lastReadMessageId)` cursor, which avoids ambiguity from
Postgres `timestamp(3)` ties. The server accepts only a visible, non-deleted
message in that specific conversation and persists the cursor monotonically,
so a delayed acknowledgement from another browser cannot make newer activity
unread again. Opening the existing reply panel provides the cursor based on the
latest message that panel rendered. The inbox exposes a cursor too, and the UI
offers **Load more threads** rather than silently dropping activity after one
page.

The Threads hook resets to its first page on reply and deletion events from the
existing durable user event stream, so activity that moves across a keyset page
boundary never duplicates or disappears in the flattened list. Read state uses
a durable recipient-private event so a person's other sessions update
immediately without disclosing a read receipt to channel participants. A
follower of a public channel is included in that stream's channel scopes even without a
`ChannelMember` row, so live and replayed reply activity obey the same
entitlement rule as the index.

The **Unread messages** direct-message inbox is a permanent, bold top-level
destination directly beneath **Threads**. Its unread badge appears only when
there is work to read; an empty inbox keeps the destination available and shows
one centered dashed card: **You are all caught up**.
