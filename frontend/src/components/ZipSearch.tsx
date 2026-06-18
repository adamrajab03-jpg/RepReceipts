import { useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { cn } from '../utils/cn'

// Shared ZIP entry. 'hero' = large, on the light homepage; 'nav' = compact, on
// the dark nav bar of every other page. Both route to /reps?zip=NNNNN.
export default function ZipSearch({ variant = 'nav' }: { variant?: 'hero' | 'nav' }) {
  const [zip, setZip] = useState('')
  const navigate = useNavigate()
  const hero = variant === 'hero'

  const submit = (e: FormEvent) => {
    e.preventDefault()
    const z = zip.trim()
    if (z) navigate(`/reps?zip=${encodeURIComponent(z)}`)
  }

  return (
    <form onSubmit={submit} className={cn('flex', hero ? 'gap-2 w-full max-w-md' : 'gap-1.5')}>
      <input
        inputMode="numeric"
        value={zip}
        onChange={e => setZip(e.target.value.replace(/\D/g, '').slice(0, 5))}
        placeholder={hero ? 'Enter your ZIP code' : 'ZIP'}
        aria-label="Find your representatives by ZIP code"
        className={cn(
          'rounded-lg border focus:outline-none focus:ring-2',
          hero
            ? 'flex-1 px-4 py-3 text-base border-gray-300 focus:ring-slate-400'
            : 'w-16 px-2 py-1.5 text-sm border-slate-700 bg-slate-800 text-white placeholder-slate-500 focus:ring-slate-500',
        )}
      />
      <button
        type="submit"
        className={cn(
          'font-medium rounded-lg transition-colors whitespace-nowrap',
          hero
            ? 'px-5 py-3 text-base bg-slate-800 text-white hover:bg-slate-700'
            : 'px-3 py-1.5 text-sm bg-slate-700 text-white hover:bg-slate-600',
        )}
      >
        {hero ? 'Find my reps' : 'Go'}
      </button>
    </form>
  )
}
