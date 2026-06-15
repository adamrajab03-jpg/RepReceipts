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
  status: 'scheduled' | 'live' | 'processing' | 'published'
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
}

export interface SpeakerTurn {
  id: string
  seq: number
  member_id: string | null
  speaker_name: string | null
  speaker_role: 'chair' | 'member' | 'witness' | 'staff' | 'unknown' | null
  start_ms: number | null
  end_ms: number | null
  attribution_status: 'auto' | 'verified' | 'unverified' | 'edited'
  raw_text: string
  clean_text: string | null
  word_times: WordTime[] | null
  is_edited: boolean
  member_full_name: string | null
  bioguide_id: string | null
  party: string | null
  state: string | null
  chamber: string | null
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

export interface ListResponse<T> {
  data: T[]
  count: number
}

export interface DetailResponse<T> {
  data: T
}
