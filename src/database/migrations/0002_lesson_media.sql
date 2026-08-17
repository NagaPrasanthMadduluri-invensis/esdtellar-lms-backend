-- Video + caption objects for a lesson, stored in Cloudflare R2.
--
-- Only the object KEY is stored, never a URL. Playback URLs are presigned on
-- demand and expire (see media/r2-storage.service.ts), so a URL persisted in a
-- row would be dead within the hour and would also hand out access to anyone
-- who read the column.
--
-- Additive and idempotent, per BACKEND_STRUCTURE.md §6.2 — safe to re-run.

ALTER TABLE lessons ADD COLUMN IF NOT EXISTS video_key   TEXT;
ALTER TABLE lessons ADD COLUMN IF NOT EXISTS caption_key TEXT;
