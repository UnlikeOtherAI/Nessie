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
Postgres `timestamp(3)` ties. Opening the existing reply panel provides the
cursor based on the latest message that panel rendered.

The Threads hook invalidates from the existing durable user event stream. A
follower of a public channel is included in that stream's channel scopes even
without a `ChannelMember` row, so live and replayed reply activity obey the
same entitlement rule as the index.
