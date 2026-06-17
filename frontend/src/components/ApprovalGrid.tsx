import { useMemberApproval, useSetApproval } from '../hooks/useApproval'
import { useAuthStore } from '../store/authStore'
import { approvalColor } from '../utils/approvalColor'
import type { ApprovalCell } from '../types/api'

interface CellProps {
  cell: ApprovalCell
  label: string
  memberId: string
  canRate: boolean
  isPending: boolean
  onRate: (topicId: string | null, value: 1 | -1) => void
}

function Cell({ cell, label, canRate, isPending, onRate }: CellProps) {
  const { percent, total, user_vote } = cell
  const colors = approvalColor(percent)

  return (
    <div
      className="rounded-lg border p-3 flex flex-col gap-1"
      style={colors}
    >
      <span className="text-xs font-medium text-gray-700 leading-tight">{label}</span>

      <div className="flex items-baseline gap-1">
        <span className="text-2xl font-bold tabular-nums text-gray-900">
          {percent == null ? '—' : `${percent}%`}
        </span>
        <span className="text-xs text-gray-500">approve</span>
      </div>

      <div className="flex items-center justify-between mt-0.5">
        <span className="text-[11px] text-gray-500 tabular-nums">
          {total === 0 ? 'No ratings' : `${total} rating${total === 1 ? '' : 's'}`}
        </span>
        <div className="flex items-center gap-1">
          <button
            onClick={() => onRate(cell.topic_id, 1)}
            disabled={!canRate || isPending}
            title={canRate ? 'Approve' : 'Log in to rate'}
            className={`text-xs px-1 rounded transition-colors disabled:opacity-40 ${
              user_vote === 1 ? 'text-emerald-600 font-bold' : 'text-gray-400 hover:text-emerald-600'
            }`}
          >
            ▲
          </button>
          <button
            onClick={() => onRate(cell.topic_id, -1)}
            disabled={!canRate || isPending}
            title={canRate ? 'Disapprove' : 'Log in to rate'}
            className={`text-xs px-1 rounded transition-colors disabled:opacity-40 ${
              user_vote === -1 ? 'text-red-500 font-bold' : 'text-gray-400 hover:text-red-500'
            }`}
          >
            ▼
          </button>
        </div>
      </div>
    </div>
  )
}

export default function ApprovalGrid({ memberId }: { memberId: string }) {
  const user    = useAuthStore(s => s.user)
  const { data, isLoading, isError } = useMemberApproval(memberId)
  const setApproval = useSetApproval()

  const onRate = (topicId: string | null, value: 1 | -1) =>
    setApproval.mutate({ memberId, topicId, value })

  if (isLoading) return <p className="text-sm text-gray-500">Loading…</p>
  if (isError || !data) return <p className="text-sm text-red-500">Couldn’t load approval ratings.</p>

  return (
    <div>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        <Cell
          cell={data.overall}
          label="Overall"
          memberId={memberId}
          canRate={!!user}
          isPending={setApproval.isPending}
          onRate={onRate}
        />
        {data.topics.map(t => (
          <Cell
            key={t.topic_id}
            cell={t}
            label={t.name ?? ''}
            memberId={memberId}
            canRate={!!user}
            isPending={setApproval.isPending}
            onRate={onRate}
          />
        ))}
      </div>
      {!user && (
        <p className="text-xs text-gray-400 mt-2">Log in to add your own rating.</p>
      )}
    </div>
  )
}
