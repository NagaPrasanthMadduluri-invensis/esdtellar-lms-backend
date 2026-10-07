-- ─────────────────────────────────────────────────────────────────────────
-- 0039 — Who signs a tenant's certificates
--
-- The certificate design (one per kind: course, learning path, session)
-- carries a single named signature: a person's name, and their title under
-- it. Until now the signature block named the ISSUING ORGANISATION and no
-- person, deliberately, because printing a name the database cannot vouch
-- for onto a formal document is inventing an identity.
--
-- These two columns are what makes a name vouchable: the tenant's own admin
-- types it, under manage_organization, beside the logo and prefix 0038
-- added. Edstellar enters its CEO, every other tenant enters its own.
--
-- NULLABLE, and NULL is the normal case. With no name set the document
-- falls back to the organisation name as the signature and "Issuing
-- organisation" as the title, which is exactly what every certificate
-- printed before this migration said. No backfill, so no tenant is shown a
-- signatory nobody at that tenant chose.
--
-- Read at RENDER time, not frozen at issue. That differs from the prefix
-- on purpose: a code is what the verify route looks up and must never
-- change, while the signature is presentation, and a learner re-downloading
-- next year should get the signatory the organisation names then.
-- ─────────────────────────────────────────────────────────────────────────

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS certificate_signatory_name text;

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS certificate_signatory_title text;
