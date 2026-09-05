-- An edit must claim the provider draft before writing it, otherwise a send
-- can pass its fingerprint check and an edit can later resurrect its state.
ALTER TYPE "GmailDraftActionState" ADD VALUE 'updating';
