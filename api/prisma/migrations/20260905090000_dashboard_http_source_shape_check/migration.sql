-- `20260904090000_static_dashboard_materials` dropped NOT NULL from origin,
-- path and transform so that a static source could hold no endpoint at all.
-- That widened the columns for every kind, including http, where all three are
-- required: `createSource` always writes them and both readers refuse a row
-- without them — `updateSourceEndpoint` answers 404 and the worker's refresh
-- returns 'skipped'.
--
-- Failing closed is right, but it makes a malformed row quiet: an http source
-- with a NULL origin would sit in the list looking healthy and simply never
-- refresh, reporting no error to explain itself. The invariant was carried
-- entirely by the write path; nothing stopped a future caller, a repair script
-- or a hand-run UPDATE from creating that row. State it where it cannot be
-- bypassed.
--
-- Only the http direction is constrained. Static rows keep all three NULL
-- today, but that is how the importer happens to write them rather than an
-- invariant worth pinning, and fixing it here would block a later static kind
-- that carries a canonical path.
ALTER TABLE "dashboard_data_sources"
  ADD CONSTRAINT "dashboard_data_sources_http_shape_check" CHECK (
    kind <> 'http'
    OR (origin IS NOT NULL AND path IS NOT NULL AND transform IS NOT NULL)
  );
