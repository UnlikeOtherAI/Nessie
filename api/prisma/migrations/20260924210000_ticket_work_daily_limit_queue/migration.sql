-- Ticket work queued for a spent day (docs/standards/ticket-work-machine-access.md).
-- Additive: the CHECK only widens.

-- A policy that spent its `dailyUsd` today queues new and returning work until
-- the UTC day turns, rather than failing tickets that have not run.
ALTER TABLE "agent_ticket_work" DROP CONSTRAINT "agent_ticket_work_state_reason_known";
ALTER TABLE "agent_ticket_work" ADD CONSTRAINT "agent_ticket_work_state_reason_known"
  CHECK (
    "state_reason" IS NULL
    OR "state_reason" IN (
      'queued_no_free_machine', 'queued_machines_offline', 'queued_daily_limit',
      'machine_access_not_set_up', 'machine_access_suspended',
      'machine_access_ended', 'machine_offline',
      'limit_wakes', 'limit_hours', 'limit_cost', 'limit_daily',
      'left_flow', 'merged', 'mover_lost_access', 'trigger_disabled',
      'identity_unverifiable'
    )
  );

-- The ended reasons are the same vocabulary as the state reasons.
ALTER TABLE "agent_ticket_work" DROP CONSTRAINT "agent_ticket_work_ended_known";
ALTER TABLE "agent_ticket_work" ADD CONSTRAINT "agent_ticket_work_ended_known"
  CHECK (
    (
      "status" IN ('queued', 'active', 'parked', 'waiting_machine')
      AND "ended_at" IS NULL
      AND "ended_reason" IS NULL
    )
    OR (
      "status" IN ('done', 'cancelled', 'failed')
      AND "ended_at" IS NOT NULL
      AND "ended_reason" IS NOT NULL
      AND "ended_reason" IN (
        'queued_no_free_machine', 'queued_machines_offline', 'queued_daily_limit',
        'machine_access_not_set_up', 'machine_access_suspended',
        'machine_access_ended', 'machine_offline',
        'limit_wakes', 'limit_hours', 'limit_cost', 'limit_daily',
        'left_flow', 'merged', 'mover_lost_access', 'trigger_disabled',
        'identity_unverifiable'
      )
    )
  );
