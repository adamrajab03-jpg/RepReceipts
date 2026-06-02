import { useState, useEffect } from 'react'
import { useMembers } from '../hooks/useMembers'
import MemberCard from '../components/MemberCard'

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
          <p className="text-xs text-gray-400 mb-3">
            {data.count} member{data.count !== 1 ? 's' : ''}
          </p>
          {data.count === 0 ? (
            <p className="text-sm text-gray-500">No members match your filters.</p>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {data.data.map(m => <MemberCard key={m.id} member={m} />)}
            </div>
          )}
        </>
      )}
    </div>
  )
}
