#!/usr/bin/env bash
# Executed by the official PostgreSQL entrypoint ONLY on first initialization
# of the dedicated data volume. Never run against an existing developer DB.
# The entrypoint sources non-executable .sh files; isolate strict shell settings
# so bootstrap cannot change the entrypoint's parent shell behavior.
(
set -euo pipefail
: "${NT_PG_APP_PASSWORD:?}"
: "${NT_PG_CONTROLLER_PASSWORD:?}"

psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" -X   -v ON_ERROR_STOP=1 \
  -v app_password="$NT_PG_APP_PASSWORD" \
  -v controller_password="$NT_PG_CONTROLLER_PASSWORD" <<'SQL'
-- Fixed role names; psql quoted string interpolation prevents secret injection.
SELECT format('CREATE ROLE noveltea_app LOGIN PASSWORD %L', :'app_password') \gexec
SELECT format('CREATE ROLE noveltea_controller LOGIN PASSWORD %L', :'controller_password') \gexec

-- The controller is not an owner and has no application/auth schema access.
REVOKE ALL ON DATABASE noveltea FROM PUBLIC;
GRANT CONNECT ON DATABASE noveltea TO noveltea_app, noveltea_controller;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE, CREATE ON SCHEMA public TO noveltea_app;

-- The app owns the narrow controller view so future app migrations can replace
-- its empty bootstrap definition with a query over committed Studio tables.
CREATE SCHEMA controller_catalog AUTHORIZATION noveltea_app;
SET ROLE noveltea_app;
CREATE VIEW controller_catalog.trusted_jobs AS
  SELECT
    NULL::text AS job_id, NULL::text AS owner_id,
    NULL::text AS provider, NULL::text AS provider_id,
    NULL::text AS directory, NULL::text AS pin,
    NULL::text AS config_json
  WHERE false;
RESET ROLE;
GRANT USAGE ON SCHEMA controller_catalog TO noveltea_controller;
GRANT SELECT ON controller_catalog.trusted_jobs TO noveltea_controller;
ALTER ROLE noveltea_controller IN DATABASE noveltea
  SET default_transaction_read_only = on;
SQL
)
