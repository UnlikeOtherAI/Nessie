# Language and Translation Model

> Status: target-state design.

## 1) Objective

Support multilingual collaboration without fragmenting the canonical system record.

The model must allow:
- each organization to define one default language for canonical storage,
- each user to define one preferred interface language,
- each user to define their own pronouns/profile references,
- each user to temporarily override that preference in a thread or session,
- all chat and agent communication to be translated for delivery when needed,
- all canonical stored chat content to be persisted in the organization's default language.

This is a communication-layer feature, not just a UI preference.

## 2) Core rules

- `Organization.defaultLanguage` is the canonical storage language for messages, summaries, and thread history.
- `User.preferredLanguage` is the default delivery language for that user's interface.
- `User.pronouns` should be available to the translation layer as profile context.
- a user may set a temporary `threadLanguageOverride` or `sessionLanguageOverride`.
- inbound messages may arrive in any supported language.
- before routing, reasoning, and persistence, inbound messages are normalized into the organization default language.
- outbound assistant/agent messages are generated or normalized in the organization default language, then translated for each viewer at delivery time when needed.
- the stored system record is the organization-language version, not the translated display copy.
- translation calls should include a bounded recent-message context window so the translator can preserve topic, tone, and terminology.
- translation calls should include relevant participant pronouns when available so translations preserve the correct grammatical form in the target language.
- default context window:
  - include the current message,
  - include up to the 2 immediately previous canonical messages from the same thread,
  - include participant pronoun/profile hints for the speaker and directly referenced users when available,
  - trim aggressively by token/character budget,
  - prefer recency over long history.

## 3) Message handling model

### 3.1 Inbound user message

1. user sends a message in language `L_user`.
2. API detects or receives the source language.
3. if `L_user != Organization.defaultLanguage`, translation service produces canonical text in `Organization.defaultLanguage`.
   - translation input should include a bounded recent-message context window from the same thread.
4. organizer, routing logic, and audit pipeline operate on the canonical text.
5. canonical text is persisted as the stored message body.
6. translated display variants may be cached for delivery, but they are not the authoritative record.

### 3.2 Outbound assistant/agent message

1. responder emits canonical message text in `Organization.defaultLanguage`.
2. for each viewer, delivery layer resolves `effectiveLanguage`:
   - thread/session override if present,
   - otherwise user preferred language,
   - otherwise organization default language.
3. if `effectiveLanguage != Organization.defaultLanguage`, message is translated before display.
   - translation input should include the current canonical message plus a bounded recent-message context window.
4. translated text is delivered as a view-layer representation only.

### 3.3 User replies in another language

If a user says "I want all communication in Turkish":
- their `effectiveLanguage` becomes `tr` for that scope,
- all inbound/outbound display text is translated for them,
- their replies are translated into the organization default language before storage,
- the persisted thread remains canonical in the organization default language.

### 3.4 Translation context window

The translation service should not operate on isolated single messages unless no prior context exists.

Required behavior:
- always include the current message,
- include 1 or 2 previous messages when available,
- use canonical stored messages as context whenever possible,
- include speaker pronouns and, where known, pronouns for directly referenced participants,
- exclude unrelated long-tail history by default,
- strip secrets, protected tool payloads, and unnecessary system metadata before translation,
- allow a stricter zero-context mode only for high-sensitivity content when policy requires minimal exposure.

Recommended default:
- `maxPreviousMessages = 2`
- `maxContextChars = 4000`
- newest-first selection from the same thread

Rationale:
- this is usually enough for pronouns, domain terminology, and conversational intent,
- it reduces mistranslation without polluting the translation prompt with full-thread history.

## 4) Data model

```ts
type LanguagePreferences = {
  organizationDefaultLanguage: string; // BCP-47, e.g. "en", "en-GB", "tr"
  userPreferredLanguage?: string;
  userPronouns?: string[]; // e.g. ["she", "her"] or locale-specific profile forms
  threadLanguageOverride?: string;
  sessionLanguageOverride?: string;
  autoTranslateDelivery: boolean;
  autoTranslateInputToCanonical: boolean;
};

type MessageTranslationMeta = {
  sourceLanguage?: string;
  canonicalLanguage: string;
  deliveredLanguage?: string;
  translationMode: 'none' | 'inbound-to-canonical' | 'outbound-for-delivery' | 'bidirectional';
  contextWindow?: {
    previousMessageCount: number;
    truncated: boolean;
    participantPronounContextIncluded?: boolean;
  };
  translatedBy?: {
    provider: string;
    model: string;
  };
};

type CanonicalMessageRecord = {
  messageId: string;
  threadId: string;
  actorId: string;
  canonicalBody: string; // always in Organization.defaultLanguage
  translationMeta: MessageTranslationMeta;
  // Optional raw/original text may be retained only when policy allows it.
  originalBody?: string;
};
```

## 5) Policy rules

- translation settings are scoped:
  - organization default language,
  - user preferred language,
  - thread/session temporary override.
- organization admins can change `Organization.defaultLanguage`.
- users can change their own preferred language.
- users can change their own pronouns/profile references.
- thread/session overrides do not change canonical storage language.
- if original-language retention is disabled, only the canonical organization-language text is persisted.
- if original-language retention is enabled, original text must be marked non-authoritative in audit and replay.

## 6) API and control-plane contracts

- `GET /orgs/{orgId}/language`
- `PATCH /orgs/{orgId}/language`
  - set canonical organization language
- `GET /users/{userId}/language`
- `PATCH /users/{userId}/language`
  - set preferred delivery language
- `GET /users/{userId}/profile`
- `PATCH /users/{userId}/profile`
  - set preferred delivery language and pronouns/profile references
- `PATCH /threads/{threadId}/language`
  - set or clear thread-level override
- `PATCH /sessions/{sessionId}/language`
  - set or clear session-level override
- `POST /translation/preview`
  - preview translated content without mutating stored messages
  - request may include `maxPreviousMessages` override within policy limits

Suggested MCP/control actions:
- `translation.org.get`
- `translation.org.update`
- `translation.user.get`
- `translation.user.update`
- `translation.user_profile.get`
- `translation.user_profile.update`
- `translation.thread.update`
- `translation.session.update`
- `translation.preview`

## 7) Delivery and audit requirements

- audit records should capture:
  - source language,
  - canonical language,
  - whether translation happened,
  - translation provider/model,
  - whether the stored message is canonical-only or includes original text.
- translated delivery must not change the canonical replay history.
- exports should default to canonical organization-language content, with translated views optional.
- audit should record whether translation used contextual history and whether that history was truncated.

## 8) Cross-links

- [functionality.md](./functionality.md)
- [organization-governance-spec.md](./organization-governance-spec.md)
- [agent-communication-spec.md](./agent-communication-spec.md)
