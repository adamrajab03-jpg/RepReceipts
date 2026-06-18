import { Link, useSearchParams } from 'react-router-dom'
import { useReps } from '../hooks/useReps'
import type { ResolvedRep } from '../types/api'
import { cn } from '../utils/cn'
import { districtTag, repRoleLabel } from '../utils/districtLabel'

function partyClasses(party: string | null) {
  if (party === 'D') return 'bg-blue-100 text-blue-700'
  if (party === 'R') return 'bg-red-100 text-red-700'
  return 'bg-gray-100 text-gray-600'
}

function RepRow({ rep }: { rep: ResolvedRep }) {
  const inner = (
    <div className="flex items-center justify-between gap-3 bg-white rounded-lg border border-gray-200 p-4">
      <div className="min-w-0">
        <h3 className="font-semibold text-gray-900 text-sm leading-snug truncate">{rep.full_name}</h3>
        <p className="text-xs text-gray-500 mt-0.5">{repRoleLabel(rep)}</p>
      </div>
      <div className="flex items-center gap-3 shrink-0">
        {rep.party && (
          <span className={cn('text-xs font-bold px-2 py-0.5 rounded-full', partyClasses(rep.party))}>
            {rep.party}
          </span>
        )}
        {rep.in_system
          ? <span className="text-xs font-medium text-slate-600">View profile →</span>
          : <span className="text-xs text-gray-400 italic whitespace-nowrap">Not yet in our system</span>}
      </div>
    </div>
  )
  return rep.in_system && rep.member_id
    ? <Link to={`/members/${rep.member_id}`} className="block hover:opacity-80 transition-opacity">{inner}</Link>
    : <div>{inner}</div>
}

export default function RepsLookupPage() {
  const [params] = useSearchParams()
  const zip = params.get('zip') ?? ''
  const validFormat = /^\d{5}$/.test(zip)
  const { data, isLoading, isError, error } = useReps(validFormat ? zip : null)

  return (
    <div className="max-w-2xl mx-auto">
      <h1 className="text-2xl font-bold text-gray-900 mb-1">Your representatives</h1>

      {!zip && (
        <p className="text-sm text-gray-500">
          Enter a ZIP code in the search box above to find your representatives.
        </p>
      )}
      {zip && !validFormat && (
        <p className="text-sm text-red-600">That ZIP code isn't valid — it needs to be 5 digits.</p>
      )}

      {validFormat && (
        <>
          <p className="text-sm text-gray-500 mb-6">ZIP {zip}</p>

          {isLoading && <p className="text-sm text-gray-500">Looking up…</p>}
          {isError && <p className="text-sm text-red-600">{(error as Error)?.message ?? 'Lookup failed.'}</p>}

          {data && (
            <div className="space-y-6">
              {data.districts.length > 1 && (
                <p className="text-xs text-gray-400">
                  This ZIP spans {data.districts.length} districts:{' '}
                  {data.districts.map(d => {
                    const tag = districtTag(d.state, d.district)
                    return tag ? `${d.state}-${tag}` : d.state
                  }).join(', ')}.
                </p>
              )}

              <section>
                <h2 className="text-xs uppercase tracking-wide text-gray-400 mb-2">Senate</h2>
                {data.senate.length > 0 ? (
                  <div className="space-y-2">
                    {data.senate.map(r => <RepRow key={r.bioguide_id} rep={r} />)}
                  </div>
                ) : (
                  <p className="text-sm text-gray-500">
                    {[...new Set(data.districts.map(d => d.state))].join(', ')} has no U.S. Senators
                    (federal district or territory).
                  </p>
                )}
              </section>

              <section>
                <h2 className="text-xs uppercase tracking-wide text-gray-400 mb-2">House</h2>
                {data.house.length > 0 ? (
                  <div className="space-y-2">
                    {data.house.map(r => <RepRow key={r.bioguide_id} rep={r} />)}
                  </div>
                ) : (
                  <p className="text-sm text-gray-500">No House representative found for this ZIP.</p>
                )}
              </section>
            </div>
          )}
        </>
      )}
    </div>
  )
}
