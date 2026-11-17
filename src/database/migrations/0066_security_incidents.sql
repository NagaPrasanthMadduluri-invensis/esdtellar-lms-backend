-- 0066 - Security incident register (PDPA data breach notification, DPDP
-- Rules, GDPR Art. 33).
--
-- Edstellar's own record of every suspected personal data breach on the
-- platform: when it was discovered, what the assessment concluded, which client
-- organizations are affected, and when the clients, the regulator and the
-- affected people were told. The deadline clocks are DERIVED from these times
-- in common/incidents.ts, never stored, so a changed rule never leaves a stale
-- due date behind (the same reason contract and invoice states are derived).
--
-- PLATFORM data, not tenant data: an incident can span several organizations,
-- so the table carries no organization_id and only @PlatformAdmin routes read
-- it. The affected organizations are a join table.
--
-- The event table is the incident's timeline, append-only, for the post-
-- incident review and as evidence of what was known when.

CREATE TABLE IF NOT EXISTS security_incidents (
  id                      serial PRIMARY KEY,
  ref_no                  text    NOT NULL UNIQUE,
  title                   text    NOT NULL,
  description             text,
  severity                text    NOT NULL DEFAULT 'medium',
  status                  text    NOT NULL DEFAULT 'open',
  discovered_at           timestamptz NOT NULL,
  assessment              text    NOT NULL DEFAULT 'undecided',
  assessed_at             timestamptz,
  data_categories         text,
  individuals_affected    integer,
  cause                   text,
  containment             text,
  clients_notified_at     timestamptz,
  regulator_notified_at   timestamptz,
  regulator_reference     text,
  individuals_notified_at timestamptz,
  closed_at               timestamptz,
  created_by              integer REFERENCES users (id) ON DELETE SET NULL,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_security_incidents_discovered
  ON security_incidents (discovered_at DESC);

CREATE TABLE IF NOT EXISTS security_incident_organizations (
  incident_id     integer NOT NULL REFERENCES security_incidents (id) ON DELETE CASCADE,
  organization_id integer NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  PRIMARY KEY (incident_id, organization_id)
);

CREATE INDEX IF NOT EXISTS idx_security_incident_orgs_org
  ON security_incident_organizations (organization_id);

CREATE TABLE IF NOT EXISTS security_incident_events (
  id            serial PRIMARY KEY,
  incident_id   integer NOT NULL REFERENCES security_incidents (id) ON DELETE CASCADE,
  actor_user_id integer REFERENCES users (id) ON DELETE SET NULL,
  actor_name    text,
  kind          text    NOT NULL,
  note          text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_security_incident_events_incident
  ON security_incident_events (incident_id, created_at);
