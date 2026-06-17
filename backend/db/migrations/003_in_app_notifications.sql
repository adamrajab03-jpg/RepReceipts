-- ============================================================================
--  In-app notifications
-- ----------------------------------------------------------------------------
--  The notifications table was originally email/SMS-shaped. This reshapes it so
--  the same table can carry in-app notifications:
--    * allow an 'in_app' channel alongside the existing 'sms'/'email'
--    * add read_at for unread state (NULL = unread)
--  The display text + destination link live in the existing payload jsonb as
--  { kind, text, link, comment_id, hearing_id }. Email/SMS delivery is still
--  future work; in-app rows are written with status = 'sent'.
-- ============================================================================

ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_channel_check;
ALTER TABLE notifications
    ADD CONSTRAINT notifications_channel_check
    CHECK (channel IN ('sms', 'email', 'in_app'));

ALTER TABLE notifications ADD COLUMN IF NOT EXISTS read_at timestamptz;

-- Feed lookups (newest first) and the unread-count badge.
CREATE INDEX IF NOT EXISTS idx_notifications_user
    ON notifications (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_user_unread
    ON notifications (user_id)
    WHERE read_at IS NULL;
