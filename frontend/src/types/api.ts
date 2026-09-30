import type { IndustrySlug } from '../utils/witnessIndustries'

export interface CommitteeMembership {
  committee_id: string
  committee_name: string
  role: 'chair' | 'ranking_member' | 'member'
  congress: number
}

export interface Member {
  id: string
  bioguide_id: string | null
  full_name: string
  member_type: 'representative' | 'senator' | 'governor' | 'delegate'
  chamber: 'house' | 'senate' | null
  party: string | null
  state: string | null
  district: number | null
  is_current: boolean
  created_at: string
  committees: CommitteeMembership[]
}

export interface MemberDetail extends Member {
  external_ids: Record<string, unknown>
  updated_at: string
}

export interface Hearing {
  id: string
  title: string
  congress: number | null
  held_on: string | null
  status: 'scheduled' | 'live' | 'processing' | 'published' | 'transcribing' | 'draft' | 'attributed' | 'verified'
  video_url: string | null
  video_source: string | null
  official_url: string | null
  created_at: string
  committee_id: string | null
  committee_name: string | null
  committee_chamber: string | null
}

/** Where a turn's words came from (migration 015): speech recognition over the
 *  audio, a reviewer's own transcription, or a merge of the two. */
export type TextOrigin = 'asr' | 'human' | 'mixed'

export interface WordTime {
  w: string
  s: number
  e: number
  c?: number   // per-word ASR confidence (0–1); present for deepgram_batch turns
}

export interface Topic {
  id: string
  slug: string
  name: string
}

export interface TopicTree extends Topic {
  children: Topic[]
}

export interface MemberTopic extends Topic {
  parent_id: string | null
  parent_slug: string | null
  parent_name: string | null
  turn_count: number
}

// ── Approval ratings ────────────────────────────────────────────────────────
export interface ApprovalCell {
  topic_id: string | null      // null = overall rating of the member
  slug: string | null
  name: string | null
  parent_id: string | null
  parent_name: string | null
  up: number
  down: number
  total: number
  percent: number | null       // thumbs-up share; null when nobody has rated
  user_vote: -1 | 1 | null
}

export interface MemberApproval {
  overall: ApprovalCell
  topics: ApprovalCell[]
}

export interface HeatmapCell {
  member_id: string
  topic_id: string
  up: number
  down: number
  total: number
  percent: number
}

export interface ApprovalHeatmap {
  members: { id: string; full_name: string; party: string | null }[]
  topics: { id: string; slug: string; name: string }[]
  cells: HeatmapCell[]
}

export interface SpeakerTurn {
  id: string
  seq: number
  member_id: string | null
  speaker_label_raw: string | null
  /** Derived "Speaker N" ordinal (appearance order of editable speaker buckets). */
  speaker_ordinal: number
  speaker_name: string | null
  speaker_role: 'chair' | 'member' | 'witness' | 'staff' | 'unknown' | null
  start_ms: number | null
  end_ms: number | null
  attribution_status: 'auto' | 'verified' | 'unverified' | 'edited' | 'attributed'
  raw_text: string
  clean_text: string | null
  word_times: WordTime[] | null
  is_edited: boolean
  /** Who transcribed the turn's words: the audio ('asr'), a reviewer ('human'), or both. */
  text_origin: TextOrigin
  member_full_name: string | null
  bioguide_id: string | null
  party: string | null
  state: string | null
  chamber: string | null
  topics: Topic[]
}

/** A section as the PUBLIC transcript needs it: a labelled range, nothing more. */
export interface PublicSection {
  id: string
  type: SectionType
  label: string | null
  member_id: string | null
  member_full_name: string | null
  start_seq: number
  end_seq: number
}

export interface Transcript {
  id: string
  hearing_id: string
  source: string
  is_primary: boolean
  status: string
  created_at: string
  turns: SpeakerTurn[]
  /** Empty when the hearing has never been sectioned — the view degrades to a plain transcript. */
  sections?: PublicSection[]
}

// ── Reader context (the public hearing header) ───────────────────────────────
// All three lists are derived server-side from the attributed turns — see
// getHearingTranscript. Nothing here is a stored hearing-level record.

/** A roster member who actually SPOKE in this hearing. */
export interface HearingParticipant {
  id: string
  full_name: string
  party: string | null
  state: string | null
  chamber: 'house' | 'senate' | null
  turn_count: number
  first_seq: number
  /** Role on the hearing's committee; null when they aren't on its roster. */
  committee_role: 'chair' | 'ranking_member' | 'member' | null
  /** At least one of their turns was marked speaker_role 'chair'. */
  chaired: boolean
}

/**
 * A named non-member speaker, as the PUBLIC page needs them. Merged server-side
 * from two sources (see getHearingTranscript): the speakers the transcript
 * yields, and the admin-entered hearing_witnesses records.
 *
 * `has_record` is the one field to branch on. False = detected in the transcript
 * but nobody has filled in a record, so only `name` and the turn counts are real.
 */
export interface HearingWitness {
  /** display_name when a record exists, else the raw transcript speaker_name. */
  name: string
  title: string | null
  organization: string | null
  industry: IndustrySlug | null
  /** Free-text category; only ever set alongside industry 'other'. */
  industry_custom: string | null
  /** The heading this witness groups under — resolved server-side. */
  industry_label: string | null
  /** 0 for a witness who submitted testimony but never spoke. */
  turn_count: number
  /** Seq of their first turn, for the #turn-N jump link. Null when they never spoke. */
  first_seq: number | null
  has_record: boolean
}

// ── Admin witness editor ────────────────────────────────────────────────────

export interface WitnessIndustry {
  slug: IndustrySlug
  label: string
}

/**
 * One row in the admin editor. `id: null` means a DRAFT — an identity the
 * transcript yielded that has never been saved, pre-filled so the admin does not
 * retype the name.
 */
export interface WitnessRow {
  id: string | null
  /** THE LINK to this witness's turns: their exact speaker_turns.speaker_name. */
  speaker_name: string | null
  display_name: string
  title: string | null
  organization: string | null
  /** Null only on a draft row — a deliberate pick is required to save. */
  industry: IndustrySlug | null
  industry_custom: string | null
  display_order: number
  // ── derived, read-only ──
  turn_count: number
  first_seq: number | null
  /** Diarization buckets carrying this speaker_name; a rename touches each. */
  speaker_keys: string[]
  /**
   * linked   — the transcript currently has turns under this speaker_name
   * unlinked — no speaker_name at all (written testimony, or never captured)
   * orphaned — has a speaker_name that matches nothing, i.e. attribution was
   *            renamed after this witness was saved
   */
  link_state: 'linked' | 'unlinked' | 'orphaned'
}

export interface WitnessEditorData {
  hearing: { id: string; title: string; status: Hearing['status'] }
  industries: WitnessIndustry[]
  rows: WitnessRow[]
  saved_count: number
  detected_count: number
}

export interface HearingContext {
  participants: HearingParticipant[]
  witnesses: HearingWitness[]
  /** Distinct turn tags across the hearing, most-discussed first. */
  topics: (Topic & { turn_count: number })[]
}

export interface HearingTranscript {
  hearing: Hearing & { updated_at: string }
  transcript: Transcript | null
  context: HearingContext
}

// ── Comments ──────────────────────────────────────────────────────────────────
export interface Comment {
  id: string
  user_id: string
  parent_id: string | null
  turn_id: string | null
  hearing_id: string | null
  body: string
  score: number
  is_deleted: boolean
  created_at: string
  author_handle: string | null
  // quote fields (null when no quote)
  char_start: number | null
  char_end: number | null
  quoted_text: string | null
  user_vote: -1 | 1 | null
}

export type CommentNode = Comment & { children: CommentNode[] }

export interface VoteResult {
  comment_id: string
  score: number
  user_vote: -1 | 1 | null
}

// ── Follows + notifications ─────────────────────────────────────────────────
export interface MemberFollow {
  id: string; full_name: string; party: string | null; state: string | null; chamber: string | null
}
export interface TopicFollow {
  id: string; slug: string; name: string
}
// A follow of a specific rep scoped to a specific topic.
export interface RepTopicFollow {
  member_id: string; member_full_name: string; party: string | null; state: string | null
  topic_id: string; topic_slug: string; topic_name: string
}

export interface FollowsState {
  members: MemberFollow[]
  topics: TopicFollow[]
  repTopics: RepTopicFollow[]
}

export type NotificationKind =
  | 'rep_activity' | 'topic_activity' | 'rep_topic_activity'
  | 'reply' | 'mention'

export interface NotificationPayload {
  kind: NotificationKind
  text: string
  link: string
  comment_id?: string
  hearing_id?: string
  member_id?: string
  topic_id?: string
}

export interface AppNotification {
  id: string
  payload: NotificationPayload
  read_at: string | null
  created_at: string
}

// ── Civic lookup (ZIP → representatives) ────────────────────────────────────
export interface ResolvedRep {
  bioguide_id: string
  full_name: string
  party: string | null
  state: string
  district: number | null      // null for senators; 0 = at-large / delegate
  chamber: 'house' | 'senate'
  member_id: string | null     // profile id when in our system, else null
  in_system: boolean
  is_delegate: boolean
}

export interface RepsLookup {
  zip: string
  districts: { state: string; district: number }[]
  senate: ResolvedRep[]
  house: ResolvedRep[]
}

// ── Admin: attribution review ───────────────────────────────────────────────
export interface AttributionSuggestion {
  suggested_identity: {
    type: 'member' | 'witness' | 'unknown'
    member_id: string | null
    bioguide_id: string | null
    display_name: string | null
  }
  confidence: number
  reasoning: string
  provider: string
  model: string
  speaker_label_raw: string
  generated_at: string
  flags?: string[]
}

export interface RosterMember {
  id: string
  full_name: string
  party: string | null
  state: string | null
  bioguide_id: string | null
  role: 'chair' | 'ranking_member' | 'member' | null
}

/** Last structural op recorded on a turn (suggestions.structural). */
export interface StructuralMarker {
  op: 'split' | 'merge' | 'insert'
  at: string
  /** split: the other half's turn id + the exact joiner between the halves. */
  sibling?: string
  joiner?: string
  /** merge: char index in raw_text where the absorbed text begins/ends. */
  seam_offset?: number
  absorbed_side?: 'before' | 'after'
  absorbed_key?: string
  absorbed_name?: string | null
  /** merge: true when the absorbed turn belonged to a different speaker. */
  absorbed_distinct?: boolean
}

/** One LLM grammar-cleanup proposal (suggestions.cleanup.edits[]). `class` is
 *  the validator's independent verdict; `rejected` edits are shown, not dropped. */
export interface CleanupEdit {
  id: string
  original: string
  replacement: string
  llm_type: string
  class: 'mechanical' | 'filler' | 'false_start' | 'transcription_error' | 'rejected'
  reject_reason: string | null
  raw_start: number
  raw_end: number
  /** 'rejected' = dismissed by a human (recoverable — the edit object is kept). */
  status: 'proposed' | 'accepted' | 'rejected' | 'superseded'
  /** Stamped when dismissed; kept even after a restore, so the trip is auditable. */
  dismissed?: { at: string; by: string | null } | null
  /** Stamped when a dismissal was undone. */
  restored?: { at: string; by: string | null } | null
}

export interface CleanupProposal {
  provider: string
  model: string
  generated_at: string
  raw_text_sha256: string
  edits: CleanupEdit[]
}

/** One applied edit that derives clean_text (suggestions.text_edits[]). */
export interface AppliedEdit {
  source: 'llm' | 'human'
  raw_start: number
  raw_end: number
  original: string
  replacement: string
  class?: CleanupEdit['class']
  /**
   * The proposal this edit was accepted from (source:'llm' only). Accept
   * normalises the span's whitespace, so the applied edit is not necessarily
   * geometrically identical to its proposal — this is the link an undo follows.
   * Absent on edits accepted before the stamp existed.
   */
  cleanup_edit_id?: string
  at: string
  by?: string | null
  /**
   * Accepted LLM cleanup edits this human edit overwrote. A manual edit that
   * lands on top of accepted cleanup becomes human-authored, but the machine
   * origin it replaced is kept here so the record stays complete.
   */
  supersedes?: {
    source: 'llm'
    class: CleanupEdit['class'] | null
    original: string
    replacement: string
    at: string | null
  }[]
  /**
   * Set when an admin applied a validator-BLOCKED suggestion's text as their
   * own edit. Always accompanies source:'human' — a blocked change is never
   * recorded as an AI cleanup, so overriding the block transfers ownership.
   */
  override?: {
    at: string
    by: string | null
    blocked_reason: string | null
    cleanup_edit_id: string
  } | null
}

export interface ReviewTurn {
  id: string
  seq: number
  start_ms: number | null
  /** Immutable Deepgram diarization label; null for admin-inserted turns. */
  speaker_label_raw: string | null
  /** Editable speaker bucket this turn belongs to. */
  speaker_key: string
  /** Derived "Speaker N" ordinal (appearance order of buckets). */
  speaker_ordinal: number
  member_id: string | null
  speaker_name: string | null
  speaker_role: string | null
  attribution_status: 'auto' | 'verified' | 'unverified' | 'edited' | 'attributed'
  raw_text: string
  word_times: WordTime[] | null
  member_full_name: string | null
  suggestion: AttributionSuggestion | null
  pinned: boolean
  structural: StructuralMarker | null
  /** Derived cleaned text (raw_text + accepted text_edits); null = show raw_text. */
  clean_text: string | null
  /** LLM cleanup proposals awaiting review, or null if the stage hasn't run. */
  cleanup: CleanupProposal | null
  /** Applied edits (accepted-LLM + human) that derive clean_text. */
  text_edits: AppliedEdit[] | null
  /** True once a human has reviewed this turn's words (feeds the tier-2 gate). */
  text_reviewed: boolean
}

export type SectionType =
  | 'chair_opening' | 'ranking_opening' | 'witness_statement'
  | 'questioning' | 'closing' | 'unassigned'

/**
 * One navigable section: a RANGE over speaker_turns, stored as a cut point.
 * `end_seq` is derived (the turn before the next section starts), so sections
 * are always contiguous and never overlap.
 */
export interface HearingSection {
  id: string
  order_index: number
  type: SectionType
  label: string | null
  member_id: string | null
  member_full_name: string | null
  start_turn_id: string
  start_seq: number
  end_seq: number
  /** 'human' = an admin edited it; re-detection will not touch it. */
  source: 'auto' | 'human'
  confidence: number | null
  method: string | null
  detection_note: string | null
  edited_at: string | null
}

export interface ReviewData {
  hearing: {
    id: string
    title: string
    status: Hearing['status']
    held_on: string | null
    committee_id: string | null
    committee_name: string | null
  }
  transcript_id: string
  roster: RosterMember[]
  turns: ReviewTurn[]
  /** Empty when the hearing has never been through the detection pass. */
  sections: HearingSection[]
}

export interface AdminHearing {
  id: string
  title: string
  status: Hearing['status']
  held_on: string | null
  created_at: string
  committee_name: string | null
  turn_count: number
  speaker_count: number
  pending_count: number
  reviewed_count: number
}

export interface ListResponse<T> {
  data: T[]
  count: number
}

export interface DetailResponse<T> {
  data: T
}

// ── Citations (shareable quote receipts) ─────────────────────────────────────
// The receipt as it was shared — immutable server-side (migration 014).
export interface Citation {
  code: string
  hearing_id: string
  hearing_title: string
  hearing_held_on: string | null
  anchor_turn_id: string | null
  char_start: number
  char_end: number
  quoted_text: string
  prefix: string
  suffix: string
  text_basis: 'clean' | 'raw'
  anchor_start_ms: number | null
  anchor_end_ms: number | null
  /** Where playback should start (the quote's first word, or just before it). */
  seek_ms: number | null
  timing_basis: 'word' | 'nearby_word' | 'turn' | 'none'
  member_id: string | null
  witness_id: string | null
  speaker_name: string
  speaker_label_raw: string | null
  speaker_role: string | null
  speaker_party: string | null
  speaker_state: string | null
  speaker_chamber: string | null
  attribution_status: string
  hearing_status: string
  /** Snapshotted at share time: did the quoted words come from the audio? */
  text_origin: TextOrigin
  created_at: string
}

export interface CitationSpeaker {
  member_id: string | null
  name: string
  role: string | null
  party: string | null
  state: string | null
  chamber: string | null
}

// Where that passage is in the transcript NOW (backend utils/citationResolve).
export interface CitationResolution {
  status: 'match' | 'diverged' | 'not_found'
  change: 'formatting' | 'wording' | null
  located_by: 'hint' | 'exact' | 'time' | 'turn' | null
  similarity: number | null
  segments: { turn_id: string; char_start: number; char_end: number }[]
  current_text: string | null
  current_speakers: CitationSpeaker[]
  attribution_changed: boolean
  mixed_speakers: boolean
}

export interface CitationView {
  citation: Citation
  resolution: CitationResolution
}
