-- ============================================================================
--  Follow granularity
-- ----------------------------------------------------------------------------
--  Phase 7 rework. A follow originally targeted exactly ONE of member/topic.
--  We now support three shapes so notifications can be scoped precisely:
--    * rep-only    (member_id set, topic_id null) — any activity from that rep
--    * topic-only  (topic_id set, member_id null) — any rep's activity on topic
--    * rep+topic   (both set)                      — that rep, only on that topic
--  The old CHECK forbade "both set"; we relax it to "at least one set" and
--  replace the two partial unique indexes with three (one per shape) so each
--  shape is independently de-duplicated per user.
--
--  users.handle already exists (001), so @mentions need no schema change here.
-- ============================================================================

-- 1. Relax the target CHECK: was "exactly one", now "at least one".
--    The original constraint was created unnamed, so Postgres auto-named it
--    follows_check. Drop defensively, then add an explicitly-named replacement.
ALTER TABLE follows DROP CONSTRAINT IF EXISTS follows_check;
ALTER TABLE follows DROP CONSTRAINT IF EXISTS follows_target_check;
ALTER TABLE follows
    ADD CONSTRAINT follows_target_check
    CHECK (member_id IS NOT NULL OR topic_id IS NOT NULL);

-- 2. Replace the two single-target unique indexes with three shape-specific ones.
DROP INDEX IF EXISTS uq_follow_member;
DROP INDEX IF EXISTS uq_follow_topic;

CREATE UNIQUE INDEX uq_follow_rep_only
    ON follows (user_id, member_id)
    WHERE member_id IS NOT NULL AND topic_id IS NULL;

CREATE UNIQUE INDEX uq_follow_topic_only
    ON follows (user_id, topic_id)
    WHERE topic_id IS NOT NULL AND member_id IS NULL;

CREATE UNIQUE INDEX uq_follow_rep_topic
    ON follows (user_id, member_id, topic_id)
    WHERE member_id IS NOT NULL AND topic_id IS NOT NULL;
