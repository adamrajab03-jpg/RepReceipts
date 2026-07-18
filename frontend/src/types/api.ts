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
  speaker_name: string | null
  speaker_role: 'chair' | 'member' | 'witness' | 'staff' | 'unknown' | null
  start_ms: number | null
  end_ms: number | null
  attribution_status: 'auto' | 'verified' | 'unverified' | 'edited' | 'attributed'
  raw_text: string
  clean_text: string | null
  word_times: WordTime[] | null
  is_edited: boolean
  member_full_name: string | null
  bioguide_id: string | null
  party: string | null
  state: string | null
  chamber: string | null
  topics: Topic[]
}

export interface Transcript {
  id: string
  hearing_id: string
  source: string
  is_primary: boolean
  status: string
  created_at: string
  turns: SpeakerTurn[]
}

export interface HearingTranscript {
  hearing: Hearing & { updated_at: string }
  transcript: Transcript | null
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

export interface ReviewTurn {
  id: string
  seq: number
  start_ms: number | null
  speaker_label_raw: string
  member_id: string | null
  speaker_name: string | null
  speaker_role: string | null
  attribution_status: 'auto' | 'verified' | 'unverified' | 'edited' | 'attributed'
  raw_text: string
  member_full_name: string | null
  suggestion: AttributionSuggestion | null
  pinned: boolean
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
