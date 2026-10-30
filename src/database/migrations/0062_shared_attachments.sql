-- 0062_shared_attachments.sql
--
-- Sharing files: a community "Resource" post (a link, or a PDF/image file) and
-- an attachment on a direct message. Both reuse the one shared-file store
-- (UPLOAD_STORAGE_PATH/shared/), served only through an authenticated route.
--
-- Additive, all nullable. A resource post is type='resource' with EITHER
-- resource_url (a link) OR the file_* columns set (a stored file). A message
-- attachment is the file_* columns on direct_messages; a message's body stays
-- NOT NULL (an attachment-only message carries an empty body).

ALTER TABLE community_posts ADD COLUMN IF NOT EXISTS resource_url text;
ALTER TABLE community_posts ADD COLUMN IF NOT EXISTS file_path  text;
ALTER TABLE community_posts ADD COLUMN IF NOT EXISTS file_name  text;
ALTER TABLE community_posts ADD COLUMN IF NOT EXISTS file_mime  text;
ALTER TABLE community_posts ADD COLUMN IF NOT EXISTS file_size  integer;

ALTER TABLE direct_messages ADD COLUMN IF NOT EXISTS file_path text;
ALTER TABLE direct_messages ADD COLUMN IF NOT EXISTS file_name text;
ALTER TABLE direct_messages ADD COLUMN IF NOT EXISTS file_mime text;
ALTER TABLE direct_messages ADD COLUMN IF NOT EXISTS file_size integer;
