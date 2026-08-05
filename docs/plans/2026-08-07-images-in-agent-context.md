# Images in agent context

Status: implemented (2026-08-07).

Post a photo in a channel, ask the agent what is in it, and it answered *"I
can't see an image on my end — your message came through as text only, with no
attachment."* That was literally true. This is what changed.

## The problem

Attachments were a *storage* feature end to end. `FileService` stored the bytes,
the API served them, the admin painted a thumbnail — and the agentic loop never
learned any of it existed.

`loadConversation` (`worker/src/run/execute/prompt.ts`) selected
`content`, `role`, and the author agent from the last 20 messages, and nothing
else. `ProviderMessage` modelled a user turn as `{ role: 'user'; content:
string }`, so there was no shape a picture could have travelled in even if the
loader had fetched one. An image-only post arrived at the model as an empty
string.

The `attachment_read` builtin was no escape hatch either: its result is a string,
and for anything not text-like it returns metadata only. There was no path from
stored bytes to the model's eyes.

## What was built

### 1. A user turn can carry images

`ProviderMessage`'s user variant gained an optional sibling field:

```ts
| { role: 'user'; content: string; images?: ProviderImage[] }
```

`ProviderImage` is `{ mime, dataBase64 }`. Bytes are inlined rather than
referenced by URL because attachment bytes are private to the workspace — a
provider cannot fetch them.

A *sibling field*, not a content-parts union, was deliberate. Every existing
reader of `.content` (token estimation, compaction's transcript rendering, the
MiniMax normalizer, the Kimi Anthropic mapper) keeps working untouched, and a
connector that cannot carry images simply ignores the field.

### 2. Connectors decide, per provider

`mapMessagesToOpenAi` takes `{ vision }`. When set, a user turn with images
becomes the multi-part content form (`text` part + `image_url` parts holding
`data:<mime>;base64,…`); when not, it stays a plain string. The flag is the
connector's own, because the connector is the only thing that knows what its
endpoint accepts:

| Connector | Vision | Why |
| --- | --- | --- |
| `openai`, `openai-compatible` | yes | The chat endpoint (and Ledger's `/v1/openai` adapter in front of it) takes inline image parts. |
| `deepseek` | no | Its chat API is text-only and rejects the multi-part form. |
| `kimi` | no | The coding endpoint this connector targets is text-only. |
| `minimax` | no | The text models this connector targets take no image parts. |

`ModelCapabilitySnapshot.supportsVision` existed but was hardcoded `false` for
every provider and read by nobody. It is now a required input to
`createBaseSnapshot` and reports the same truth the wire does, so the field and
the behaviour cannot drift.

### 3. The window's attachments reach the prompt

`worker/src/run/message-attachments.ts` is the one place that turns a message's
attachments into something a model can use. It produces two separate things:

- **An inventory line** — `[attached: gallus.png (image/png, 812 KB,
  id=att-1)]` — appended to that turn's text when the prompt is rendered. This
  is what makes an image-only post a message at all rather than an empty turn,
  and it names the ids an agent can reach with `attachment_read` for the files
  it cannot look at.
- **Inlined image bytes**, carried on the provider message.

The note is stored *beside* `content`, never folded into it. `buildModelPrompt`
compares the run's prompt against the raw stored content to decide whether the
trigger message is already the last turn of the window; annotating `content`
would have failed that check and appended the user's question a second time,
stripped of its images.

Which bytes represent an image:

- a PNG/JPEG/WebP/GIF original at or under 4 MiB → **the original**;
- anything else that is still an image (HEIC, TIFF, SVG, an oversized photo) →
  **its stored `.thumb.webp` preview**, which the thumbnail feature already
  derived at 640 px;
- a non-image, or an image with neither → **no picture**, only the inventory
  line.

At most 6 images ride in one prompt, newest message first — images are re-sent
on every iteration of the agentic loop, so this is a standing cost for the whole
run, not a one-off. Bytes come through the single `FileService` chokepoint like
every other blob read (`worker/src/run/file-service.ts` now holds the shared
handle the `attachment_*` tools and the prompt builder both use). Nothing here
throws: a vanished object or an undecodable preview costs the run its picture,
never the run.

`estimateMessageTokens` counts a flat 1500 tokens per inlined image, so a thread
full of photos triggers compaction instead of overflowing the model's window.

### 4. The run reads the channel, not just its own trigger

Inlining the images was not enough on its own, and the end-to-end run is what
exposed why. `run-setup` passed the run's **reply anchor** to `loadConversation`
as its history scope. For a top-level trigger with the default `thread`
placement, that anchor is the trigger message's own id — so the window filtered
to `{ id: trigger } OR { rootMessageId: trigger }`, which for a message with no
replies yet is exactly one message. Every such run read a one-message window: no
history at all, and no sight of a photo posted a moment earlier. The captured
provider request showed it plainly — a single `user` turn and nothing else.

Where a run *replies* and what it *reads* are separate questions, and they now
have separate resolvers. `resolveConversationRootMessageId` narrows the window
to a reply thread only when the trigger message is itself a reply; a run
answering a top-level message is starting a reply thread rather than sitting in
one, so it reads the channel thread. The reply anchor
(`resolveReplyRootMessageId`) and every message-creation site that uses it are
untouched.

### 5. An image-only post can start a run

The engagement orchestrator judged a message by its text, so a post that was
nothing but a photo looked like an empty message and nobody answered it. The
trigger message and the recent-history window it reasons over now carry the same
inventory line. The judgement itself remains entirely the model's — the line is
structural fact about what is attached, never an interpretation of it.

## What this does not do

- **PDFs are not read.** A PDF's stored preview is its first page only; handing
  that to a model as "the document" would be misleading. PDFs still surface as
  an inventory line.
- **Existing attachments without a preview are not backfilled**, matching the
  thumbnail feature. An old HEIC upload with no `.thumb.webp` gets a name, not a
  picture.
- **Assistant turns carry no images.** Only `user` turns do.

## Tests

- `packages/runtime/test/openai-vision-messages.test.ts` — the mapper: image
  parts, an image-only turn with no empty text part, a text-only model keeping
  plain strings and never leaking the `images` field.
- `packages/runtime/test/connector-vision-wire.test.ts` — the per-provider gate
  checked on the request body, plus the capability snapshots.
- `worker/src/run/message-attachments.test.ts` — the inventory line, original vs
  preview vs nothing, the newest-first budget, and storage failure staying
  non-fatal.
- `worker/src/run/execute/prompt.test.ts` — an image reaching the model on its
  own turn, the note annotating without altering stored content, and no
  duplicated or empty trailing user turn.
- `worker/src/run/execute/reply-placement.test.ts` — the reading scope split
  from the reply anchor.

Verified end to end against a throwaway Postgres, a filesystem storage backend,
and a capture server standing in for the provider: upload a PNG → post it with
no text → ask "what is on this image?" → the agent run's request body carries
`[attached: gallus.png (image/png, 1 KB, id=…)]` and
`data:image/png;base64,iVBORw0KGgo…` on the image turn, followed by the question
as its own turn, and the run completes with a reply.
