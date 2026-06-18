import { useState, useEffect, useMemo } from 'react'
import { useMembers } from '../hooks/useMembers'
import MemberCard from '../components/MemberCard'
import { US_STATE_NAMES } from '../utils/us-states'
import type { Member } from '../types/api'

const CHAMBERS = [
  { label: 'All',    value: '' },
  { label: 'Senate', value: 'senate' },
  { label: 'House',  value: 'house' },
]

const PARTIES = [
  { label: 'All',        value: '' },
  { label: 'Democrat',   value: 'D' },
  { label: 'Republican', value: 'R' },
]

function groupByState(members: Member[]): [string, Member[]][] {
  const map = new Map<string, Member[]>()
  for (const m of members) {
    const key = m.state ?? '—'
    if (!map.has(key)) map.set(key, [])
    map.get(key)!.push(m)
  }
  // Backend already sorts by state code + full_name; sort groups by full state name.
  return [...map.entries()].sort(([a], [b]) => {
    if (a === '—') return 1
    if (b === '—') return -1
    return (US_STATE_NAMES[a] ?? a).localeCompare(US_STATE_NAMES[b] ?? b)
  })
}

export default function MembersPage() {
  const [search, setSearch]   = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [chamber, setChamber] = useState('')
  const [party, setParty]     = useState('')

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 300)
    return () => clearTimeout(t)
  }, [search])

  const { data, isLoading, isError } = useMembers({
    search:  debouncedSearch || undefined,
    chamber: chamber || undefined,
    party:   party   || undefined,
  })

  const groups = useMemo(() => groupByState(data?.data ?? []), [data])

  return (
    <div>
      <h1 className="text-2xl font-bold text-gray-900 mb-6">Members</h1>

      <div className="flex flex-wrap gap-3 mb-6">
        <input
          type="search"
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search by name…"
          className="border border-gray-300 rounded-lg px-3 py-2 text-sm w-56 focus:outline-none focus:ring-2 focus:ring-slate-400"
        />

        <div className="flex rounded-lg border border-gray-300 overflow-hidden text-sm">
          {CHAMBERS.map(c => (
            <button
              key={c.value}
              onClick={() => setChamber(c.value)}
              className={`px-3 py-2 transition-colors ${
                chamber === c.value
                  ? 'bg-slate-800 text-white'
                  : 'bg-white text-gray-700 hover:bg-gray-50'
              }`}
            >
              {c.label}
            </button>
          ))}
        </div>

        <div className="flex rounded-lg border border-gray-300 overflow-hidden text-sm">
          {PARTIES.map(p => (
            <button
              key={p.value}
              onClick={() => setParty(p.value)}
              className={`px-3 py-2 transition-colors ${
                party === p.value
                  ? 'bg-slate-800 text-white'
                  : 'bg-white text-gray-700 hover:bg-gray-50'
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      {isLoading && <p className="text-sm text-gray-500">Loading…</p>}
      {isError   && <p className="text-sm text-red-500">Failed to load members.</p>}

      {data && (
        <>
          <p className="text-xs text-gray-400 mb-4">
            {data.count} member{data.count !== 1 ? 's' : ''}
          </p>

          {data.count === 0 ? (
            <p className="text-sm text-gray-500">No members match your filters.</p>
          ) : (
            <div className="space-y-1">
              {groups.map(([state, members]) => (
                <div key={state}>
                  <h2 className="sticky top-0 bg-gray-50/80 backdrop-blur-sm z-10 text-xs font-semibold uppercase tracking-wide text-gray-500 py-2 border-b border-gray-100">
                    {state === '—' ? '—' : (US_STATE_NAMES[state] ?? state)}
                  </h2>
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 pt-3 pb-6">
                    {members.map(m => <MemberCard key={m.id} member={m} />)}
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}
