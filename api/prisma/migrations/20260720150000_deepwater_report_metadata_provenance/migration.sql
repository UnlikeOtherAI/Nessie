-- Historical DeepWater run updates could copy an agent-authored source count
-- into connector usage. Keep units only when the durable Product run carries
-- the server-only marker written from Ledger's authenticated report response.
UPDATE "connector_usage_events" AS usage
SET
  "units" = CASE
    WHEN run."result_json" ->> 'sourceCountSource' = 'ledger_research_report'
      THEN run."source_count"
    ELSE NULL
  END,
  "unit_type" = CASE
    WHEN run."result_json" ->> 'sourceCountSource' = 'ledger_research_report'
      AND run."source_count" IS NOT NULL
      THEN 'sources'
    ELSE NULL
  END
FROM "product_integration_runs" AS run
WHERE usage."organization_id" = run."organization_id"
  AND usage."correlation_id" = 'deep-water:' || run."id"::text
  AND usage."connector_type" = 'mcp'::"ConnectorType"
  AND usage."target" = 'deep-water';
