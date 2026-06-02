-- ============================================================================
--  Congressional transcript platform — database schema (PostgreSQL)
-- ----------------------------------------------------------------------------
--  Run this once against an empty database to create the foundation.
--  Conventions used throughout:
--    * UUID primary keys via gen_random_uuid()
--    * created_at / updated_at timestamps on tables that get edited
--    * CHECK constraints (not ENUM types) for status-like fields, so you can
--      add new allowed values later without an ALTER TYPE migration
--    * Every speaker turn keeps raw_text untouched; cleaned text is separate
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS pg_trgm;     -- fast fuzzy name search


-- ============================================================================
--  1. ROSTER  (members, committees, who-sits-on-what)
-- ============================================================================

CREATE TABLE members (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    bioguide_id   text UNIQUE,                 -- standard congressional ID; null for governors
    full_name     text NOT NULL,
    member_type   text NOT NULL CHECK (member_type IN
                       ('representative','senator','governor','delegate')),
    chamber       text CHECK (chamber IN ('house','senate')),  -- null for governors
    party         text,
    state         char(2),
    district      int,                         -- null for senators/governors
    is_current    boolean NOT NULL DEFAULT true,
    external_ids  jsonb NOT NULL DEFAULT '{}', -- e.g. {"govtrack": 412345}
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE committees (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    parent_id  uuid REFERENCES committees(id) ON DELETE SET NULL,  -- subcommittees
    name       text NOT NULL,
    chamber    text CHECK (chamber IN ('house','senate','joint')),
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE committee_memberships (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    member_id     uuid NOT NULL REFERENCES members(id) ON DELETE CASCADE,
    committee_id  uuid NOT NULL REFERENCES committees(id) ON DELETE CASCADE,
    role          text NOT NULL DEFAULT 'member'
                       CHECK (role IN ('chair','ranking_member','member')),
    congress      int,                         -- e.g. 119
    UNIQUE (member_id, committee_id, congress)
);


-- ============================================================================
--  2. CONTENT  (hearings -> transcripts -> speaker turns)
-- ============================================================================

CREATE TABLE hearings (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    committee_id  uuid REFERENCES committees(id) ON DELETE SET NULL,
    title         text NOT NULL,
    congress      int,
    held_on       date,
    video_url     text,
    video_source  text CHECK (video_source IN ('youtube','dotgov','cspan_link','other')),
    official_url  text,                         -- GPO/congress.gov transcript when published
    status        text NOT NULL DEFAULT 'scheduled'
                       CHECK (status IN ('scheduled','live','processing','published')),
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now()
);

-- A hearing can have more than one transcript (e.g. a fast live one, later
-- superseded by the official GPO text). is_primary marks the one shown by default.
CREATE TABLE transcripts (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    hearing_id  uuid NOT NULL REFERENCES hearings(id) ON DELETE CASCADE,
    source      text NOT NULL CHECK (source IN
                     ('deepgram_live','whisper','gpo_official','manual')),
    language    text NOT NULL DEFAULT 'en',
    is_primary  boolean NOT NULL DEFAULT false,
    status      text NOT NULL DEFAULT 'processing'
                     CHECK (status IN ('processing','complete','superseded')),
    created_at  timestamptz NOT NULL DEFAULT now()
);

-- The heart of the system. raw_text is never altered; the grammar pass writes
-- clean_text only. word_times holds Deepgram's per-word timestamps so a quoted
-- span can be resolved to an exact video second.
CREATE TABLE speaker_turns (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    transcript_id      uuid NOT NULL REFERENCES transcripts(id) ON DELETE CASCADE,
    member_id          uuid REFERENCES members(id) ON DELETE SET NULL,  -- null = witness/unknown
    seq                int NOT NULL,            -- ordering within the transcript
    speaker_label_raw  text,                    -- Deepgram's "Speaker 2"
    speaker_name       text,                    -- display name for witnesses / non-members
    speaker_role       text CHECK (speaker_role IN
                            ('chair','member','witness','staff','unknown')),
    start_ms           int,
    end_ms             int,
    confidence         numeric(4,3),            -- attribution confidence, 0.000–1.000
    attribution_status text NOT NULL DEFAULT 'auto'
                            CHECK (attribution_status IN
                            ('auto','verified','unverified','edited')),
    raw_text           text NOT NULL,           -- original ASR output, preserved
    clean_text         text,                    -- grammar-checked; words never added/changed
    word_times         jsonb,                   -- [{"w":"the","s":1230,"e":1310}, ...]
    is_edited          boolean NOT NULL DEFAULT false,
    edited_by          uuid,                    -- FK added after users table below
    search_tsv         tsvector GENERATED ALWAYS AS
                            (to_tsvector('english', coalesce(clean_text, raw_text, ''))) STORED,
    created_at         timestamptz NOT NULL DEFAULT now(),
    updated_at         timestamptz NOT NULL DEFAULT now(),
    UNIQUE (transcript_id, seq)
);


-- ============================================================================
--  3. TOPICS  (controlled vocabulary, hierarchical, tagged onto turns)
-- ============================================================================

CREATE TABLE topics (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    parent_id  uuid REFERENCES topics(id) ON DELETE SET NULL,  -- issue nests under area
    name       text NOT NULL,
    slug       text UNIQUE NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE turn_topics (
    turn_id     uuid NOT NULL REFERENCES speaker_turns(id) ON DELETE CASCADE,
    topic_id    uuid NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
    source      text NOT NULL DEFAULT 'llm'
                     CHECK (source IN ('deepgram','llm','manual')),
    confidence  numeric(4,3),
    PRIMARY KEY (turn_id, topic_id)
);


-- ============================================================================
--  4. USERS
-- ============================================================================

CREATE TABLE users (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    handle         text UNIQUE NOT NULL,        -- pseudonymous public name
    email          text UNIQUE NOT NULL,
    password_hash  text NOT NULL,               -- store a hash only, never plaintext
    phone          text,                        -- for SMS alerts; nullable
    email_verified boolean NOT NULL DEFAULT false,
    phone_verified boolean NOT NULL DEFAULT false,
    is_admin       boolean NOT NULL DEFAULT false,
    settings       jsonb NOT NULL DEFAULT '{}',
    created_at     timestamptz NOT NULL DEFAULT now(),
    updated_at     timestamptz NOT NULL DEFAULT now()
);

-- Now that users exists, wire up the editor reference on speaker_turns.
ALTER TABLE speaker_turns
    ADD CONSTRAINT speaker_turns_edited_by_fkey
    FOREIGN KEY (edited_by) REFERENCES users(id) ON DELETE SET NULL;


-- ============================================================================
--  5. SOCIAL LAYER  (comments, quote anchoring, votes, approval ratings)
-- ============================================================================

-- A comment attaches to a specific speaker turn (turn_id) OR to a hearing as a
-- whole (hearing_id) for general discussion not tied to one quote. The CHECK
-- requires at least one. user_id is nullable + ON DELETE SET NULL so deleting an
-- account anonymizes the author but preserves the thread; is_deleted soft-hides
-- without breaking replies that hang off it.
CREATE TABLE comments (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id    uuid REFERENCES users(id) ON DELETE SET NULL,
    turn_id    uuid REFERENCES speaker_turns(id) ON DELETE CASCADE,  -- null = hearing-level
    hearing_id uuid REFERENCES hearings(id) ON DELETE CASCADE,
    parent_id  uuid REFERENCES comments(id) ON DELETE CASCADE,       -- threading
    body       text NOT NULL,
    score      int NOT NULL DEFAULT 0,          -- cached sum of comment_votes
    is_deleted boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CHECK (turn_id IS NOT NULL OR hearing_id IS NOT NULL)
);

-- The pull-quote link. A highlighted span of a turn (char_start..char_end) is
-- stored with the comment; quoted_text is a snapshot so the quote survives later
-- edits to the turn. Resolve char range -> word_times -> exact video timestamp.
CREATE TABLE comment_quotes (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    comment_id  uuid NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
    turn_id     uuid NOT NULL REFERENCES speaker_turns(id) ON DELETE CASCADE,
    char_start  int NOT NULL,
    char_end    int NOT NULL,
    quoted_text text NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    CHECK (char_end > char_start)
);

-- Reddit-style up/down on a comment. One vote per user per comment.
CREATE TABLE comment_votes (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    comment_id uuid NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
    value      smallint NOT NULL CHECK (value IN (-1, 1)),
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (user_id, comment_id)
);

-- Approval of a member, optionally scoped to a topic. Thumbs up/down only.
-- topic_id NULL = an overall rating of the member. Two partial unique indexes
-- (below) enforce one rating per user per member, and one per user/member/topic.
CREATE TABLE approval_ratings (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    member_id  uuid NOT NULL REFERENCES members(id) ON DELETE CASCADE,
    topic_id   uuid REFERENCES topics(id) ON DELETE CASCADE,
    value      smallint NOT NULL CHECK (value IN (-1, 1)),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX uq_approval_member_topic
    ON approval_ratings (user_id, member_id, topic_id)
    WHERE topic_id IS NOT NULL;
CREATE UNIQUE INDEX uq_approval_member_overall
    ON approval_ratings (user_id, member_id)
    WHERE topic_id IS NULL;


-- ============================================================================
--  6. FOLLOWS + NOTIFICATIONS  (the SMS/email + "flagged live" features)
-- ============================================================================

-- A follow targets exactly one of: a member OR a topic (enforced by CHECK).
CREATE TABLE follows (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    member_id  uuid REFERENCES members(id) ON DELETE CASCADE,
    topic_id   uuid REFERENCES topics(id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    CHECK ( (member_id IS NOT NULL)::int + (topic_id IS NOT NULL)::int = 1 )
);
CREATE UNIQUE INDEX uq_follow_member ON follows (user_id, member_id) WHERE member_id IS NOT NULL;
CREATE UNIQUE INDEX uq_follow_topic  ON follows (user_id, topic_id)  WHERE topic_id  IS NOT NULL;

-- What a user wants to be alerted about, and how.
CREATE TABLE notification_subscriptions (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    scope_type  text NOT NULL CHECK (scope_type IN ('member','topic','live_flag')),
    member_id   uuid REFERENCES members(id) ON DELETE CASCADE,
    topic_id    uuid REFERENCES topics(id) ON DELETE CASCADE,
    channel     text NOT NULL CHECK (channel IN ('sms','email')),
    is_active   boolean NOT NULL DEFAULT true,
    created_at  timestamptz NOT NULL DEFAULT now()
);

-- Log of messages actually sent (or attempted).
CREATE TABLE notifications (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    subscription_id uuid REFERENCES notification_subscriptions(id) ON DELETE SET NULL,
    channel         text NOT NULL CHECK (channel IN ('sms','email')),
    payload         jsonb NOT NULL DEFAULT '{}',
    status          text NOT NULL DEFAULT 'queued'
                         CHECK (status IN ('queued','sent','failed')),
    sent_at         timestamptz,
    created_at      timestamptz NOT NULL DEFAULT now()
);


-- ============================================================================
--  7. QUALITY + INTEGRITY  (report a mistake, audit every edit to the record)
-- ============================================================================

CREATE TABLE reports (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    reporter_id  uuid REFERENCES users(id) ON DELETE SET NULL,
    turn_id      uuid NOT NULL REFERENCES speaker_turns(id) ON DELETE CASCADE,
    report_type  text NOT NULL CHECK (report_type IN
                      ('misattribution','transcription_error','other')),
    description  text,
    status       text NOT NULL DEFAULT 'open'
                      CHECK (status IN ('open','reviewing','resolved','dismissed')),
    resolved_by  uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at   timestamptz NOT NULL DEFAULT now(),
    resolved_at  timestamptz
);

-- Tamper-evident history. The app (or a generic trigger) writes one row per
-- change so any edit to a transcript can be traced: who, what, before/after.
CREATE TABLE audit_log (
    id          bigserial PRIMARY KEY,
    table_name  text NOT NULL,
    record_id   uuid NOT NULL,
    action      text NOT NULL CHECK (action IN ('insert','update','delete')),
    changed_by  uuid REFERENCES users(id) ON DELETE SET NULL,
    changes     jsonb NOT NULL DEFAULT '{}',  -- {"field": {"old": ..., "new": ...}}
    created_at  timestamptz NOT NULL DEFAULT now()
);


-- ============================================================================
--  8. INDEXES  (the lookups your features hit constantly)
-- ============================================================================

CREATE INDEX idx_speaker_turns_member      ON speaker_turns (member_id);
CREATE INDEX idx_speaker_turns_transcript  ON speaker_turns (transcript_id);
CREATE INDEX idx_speaker_turns_search      ON speaker_turns USING gin (search_tsv);
CREATE INDEX idx_turn_topics_topic         ON turn_topics (topic_id);
CREATE INDEX idx_comments_turn             ON comments (turn_id);
CREATE INDEX idx_comments_hearing          ON comments (hearing_id);
CREATE INDEX idx_comments_parent           ON comments (parent_id);
CREATE INDEX idx_comment_quotes_turn       ON comment_quotes (turn_id);
CREATE INDEX idx_approval_member           ON approval_ratings (member_id);
CREATE INDEX idx_approval_topic            ON approval_ratings (topic_id);
CREATE INDEX idx_cmt_memberships_member    ON committee_memberships (member_id);
CREATE INDEX idx_cmt_memberships_committee ON committee_memberships (committee_id);
CREATE INDEX idx_hearings_committee        ON hearings (committee_id);
CREATE INDEX idx_hearings_held_on          ON hearings (held_on);
CREATE INDEX idx_follows_user              ON follows (user_id);
CREATE INDEX idx_members_name_trgm         ON members USING gin (full_name gin_trgm_ops);


-- ============================================================================
--  9. updated_at AUTO-TOUCH  (keeps the timestamp current on every UPDATE)
-- ============================================================================

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_members_updated      BEFORE UPDATE ON members          FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_hearings_updated     BEFORE UPDATE ON hearings         FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_turns_updated        BEFORE UPDATE ON speaker_turns    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_comments_updated     BEFORE UPDATE ON comments         FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_approval_updated     BEFORE UPDATE ON approval_ratings FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_users_updated        BEFORE UPDATE ON users            FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============================================================================
--  End of schema.
-- ============================================================================
