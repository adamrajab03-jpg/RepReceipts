-- ============================================================================
--  WITNESSES — who testified, and whose interest they represent.
-- ----------------------------------------------------------------------------
--  Before this migration a witness existed only as a STRING: speaker_turns
--  .speaker_name on non-member turns. That is enough to print a name and no
--  more. This table is the record behind the name — title, organization, and a
--  curated industry — entered by hand by an admin.
--
--  A LAYER ON TOP, LIKE SECTIONS AND CLEANUP
--  Nothing in this feature ever writes speaker_turns. The single-writer rule
--  holds: only the attribution path (adminController.applySpeaker /
--  applyToSpeaker) writes speaker_name, speaker_role or attribution_status.
--  The admin witness editor offers a "rename in transcript too" action, and
--  that action CALLS THAT EXISTING ENDPOINT rather than issuing its own UPDATE
--  — so a rename still recomputes attribution_status and still demotes a
--  'verified' hearing back to 'attributed' via maybeDemote.
--
--  THE LINK: speaker_name, NOT speaker_key
--  speaker_name is how the rest of the system already identifies a witness:
--  applyToSpeaker writes it uniformly across a speaker_key bucket, and
--  applySpeaker looks up an existing witness bucket BY NAME. One witness name
--  may legitimately span several diarization buckets (diarization splits one
--  person in two; the admin names both), so a name is 1→N over buckets and a
--  speaker_key FK would be the wrong cardinality.
--
--  A NULL speaker_name is meaningful: a witness who submitted written
--  testimony and never spoke, or one the transcript never captured. Such a row
--  simply has no turns.
--
--  WHY hearing_id AND NOT transcript_id
--  Deliberately unlike hearing_sections, which MUST be transcript-scoped
--  because it anchors on start_turn_id (see 012). A witness testified at the
--  HEARING. The link here is a name string rather than a row id, so it
--  re-matches against whichever transcript is primary — a GPO transcript
--  superseding the Deepgram one does not require re-entering witness data.
--
--  INDUSTRY: A CURATED VOCABULARY WITH AN ESCAPE HATCH
--  Grouping the public display by industry only works if the values don't
--  fragment ("Media" vs "media" vs "News"), so industry is a fixed set
--  enforced by a CHECK. 'other' + industry_custom is the escape hatch for the
--  witness who genuinely doesn't fit. This CHECK is the AUTHORITY for the
--  vocabulary; backend/src/utils/witnessIndustries.js mirrors it to return a
--  clean 400 instead of a raw 23514, and frontend/src/utils/witnessIndustries.ts
--  mirrors it for the dropdown and the public group order. Adding an industry
--  means touching all three.
-- ============================================================================

CREATE TABLE hearing_witnesses (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    hearing_id    uuid NOT NULL REFERENCES hearings(id) ON DELETE CASCADE,

    -- THE LINK to this witness's turns: the exact speaker_turns.speaker_name
    -- string they carry. NULL = a witness with no turns (see header).
    speaker_name  text,

    -- What the public sees. Seeded from speaker_name at pre-population, then
    -- free to diverge — diverging is what surfaces the "rename in transcript
    -- too" action in the editor.
    display_name  text NOT NULL CHECK (btrim(display_name) <> ''),
    title         text,          -- "CEO & Cofounder"
    organization  text,          -- "The Federalist"

    industry      text NOT NULL DEFAULT 'other' CHECK (industry IN (
                      'media',
                      'technology',
                      'academia_legal',
                      'government',
                      'advocacy_nonprofit',
                      'finance',
                      'energy',
                      'healthcare',
                      'labor',
                      'other')),
    -- Free text, and ONLY on 'other'. Bucketed case-insensitively by the
    -- public display so "crypto" and "Crypto" are one group.
    industry_custom text,

    display_order int NOT NULL DEFAULT 0,

    created_by    uuid REFERENCES users(id) ON DELETE SET NULL,
    updated_by    uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT hearing_witnesses_custom_chk
        CHECK (industry = 'other' OR industry_custom IS NULL),

    -- Deferrable so one bulk save can renumber the whole set inside a single
    -- transaction without transient collisions (the same pattern as
    -- speaker_turns_transcript_seq_uniq in 010 and hearing_sections_order_uniq
    -- in 012). The save runs
    --   SET CONSTRAINTS hearing_witnesses_order_uniq DEFERRED
    -- inside its txn; the constraint is still enforced at COMMIT.
    CONSTRAINT hearing_witnesses_order_uniq
        UNIQUE (hearing_id, display_order) DEFERRABLE INITIALLY IMMEDIATE
);

-- At most one witness record may claim a given transcript identity. PARTIAL so
-- that any number of witnesses can have no link at all (NULL speaker_name).
CREATE UNIQUE INDEX hearing_witnesses_identity_uniq
    ON hearing_witnesses (hearing_id, speaker_name) WHERE speaker_name IS NOT NULL;

CREATE INDEX hearing_witnesses_hearing_idx ON hearing_witnesses (hearing_id, display_order);
