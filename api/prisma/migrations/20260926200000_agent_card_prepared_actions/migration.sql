-- A card button may stand for a tool call its agent prepared when it posted
-- the card (`card_post` `prepared`). Pressing the button — or, in a one-on-one
-- chat, answering with that choice — runs exactly that call through the
-- ordinary authorization path without asking the model first
-- (docs/standards/agent-cards.md → "A prepared button runs its call").
--
-- Both columns are server-only and nullable; existing cards have neither.
ALTER TABLE "agent_cards"
  ADD COLUMN "prepared_actions" JSONB,
  ADD COLUMN "prepared_execution" JSONB;
