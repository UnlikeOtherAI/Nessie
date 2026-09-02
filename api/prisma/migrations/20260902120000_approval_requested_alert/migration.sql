-- An agent waiting on a person to approve an action gets a durable alert, not
-- just an in-thread card. The card is only seen by somebody already looking at
-- the thread; a mailbox approval raised by a schedule at 06:00 needs the bell.
ALTER TYPE "UserAlertKind" ADD VALUE IF NOT EXISTS 'approval_requested';
