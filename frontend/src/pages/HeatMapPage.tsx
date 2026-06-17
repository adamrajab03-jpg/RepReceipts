import { Link } from 'react-router-dom'
import { useApprovalHeatmap } from '../hooks/useApproval'
import { approvalColor } from '../utils/approvalColor'

export default function HeatMapPage() {
  const { data, isLoading, isError } = useApprovalHeatmap()

  if (isLoading) return <p className="text-sm text-gray-500">Loading…</p>
  if (isError || !data) return <p className="text-sm text-red-500">Couldn’t load the heat map.</p>

  const { members, topics, cells } = data

  // Pivot the flat cell list into a lookup keyed by member + topic.
  const byKey = new Map(cells.map(c => [`${c.member_id}:${c.topic_id}`, c]))

  if (!members.length || !topics.length) {
    return (
      <div>
        <h1 className="text-2xl font-bold text-gray-900 mb-6">Heat Map</h1>
        <p className="text-sm text-gray-500">No approval ratings yet.</p>
      </div>
    )
  }

  return (
    <div>
      <h1 className="text-2xl font-bold text-gray-900 mb-1">Heat Map</h1>
      <p className="text-sm text-gray-500 mb-6">
        Approval rating per member per topic — the share of ratings that were a thumbs-up.
      </p>

      <div className="overflow-x-auto bg-white rounded-lg border border-gray-200">
        <table className="border-separate border-spacing-0 text-sm">
          <thead>
            <tr>
              <th className="sticky left-0 z-10 bg-white text-left font-semibold text-gray-700 px-4 py-3 border-b border-gray-200">
                Member
              </th>
              {topics.map(t => (
                <th
                  key={t.id}
                  className="px-3 py-3 border-b border-gray-200 text-xs font-medium text-gray-600 whitespace-nowrap align-bottom"
                >
                  {t.name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {members.map(m => (
              <tr key={m.id}>
                <th className="sticky left-0 z-10 bg-white text-left font-medium px-4 py-2 border-b border-gray-100 whitespace-nowrap">
                  <Link to={`/members/${m.id}`} className="text-slate-800 hover:text-teal-700">
                    {m.full_name}
                  </Link>
                  {m.party && <span className="ml-1.5 text-xs text-gray-400">({m.party})</span>}
                </th>
                {topics.map(t => {
                  const cell = byKey.get(`${m.id}:${t.id}`)
                  const colors = cell ? approvalColor(cell.percent) : undefined
                  return (
                    <td key={t.id} className="border-b border-gray-100 px-1.5 py-1.5 text-center">
                      {cell ? (
                        <div
                          className="rounded-md border px-2 py-2 min-w-[3.5rem]"
                          style={colors}
                          title={`${cell.up} up · ${cell.down} down · ${cell.total} total`}
                        >
                          <span className="text-sm font-bold tabular-nums text-gray-900">
                            {cell.percent}%
                          </span>
                        </div>
                      ) : (
                        <span className="text-gray-300">—</span>
                      )}
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
