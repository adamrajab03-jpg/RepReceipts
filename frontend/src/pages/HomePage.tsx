import { Link } from 'react-router-dom'
import ZipSearch from '../components/ZipSearch'

export default function HomePage() {
  return (
    <div className="max-w-2xl mx-auto text-center py-12">
      <h1 className="text-4xl font-bold tracking-tight text-gray-900">
        Your Congress, on the record.
      </h1>
      <p className="mt-3 text-lg text-gray-500">
        Find your representatives and see what they actually said in committee hearings.
      </p>

      <div className="mt-8 flex justify-center">
        <ZipSearch variant="hero" />
      </div>

      <p className="mt-4 text-sm text-gray-400">
        Or browse{' '}
        <Link to="/members" className="text-slate-600 underline hover:text-slate-800">all members</Link>
        {' '}and{' '}
        <Link to="/hearings" className="text-slate-600 underline hover:text-slate-800">hearings</Link>.
      </p>
    </div>
  )
}
