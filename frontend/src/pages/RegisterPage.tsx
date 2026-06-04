import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { z } from 'zod'
import { useRegister } from '../hooks/useAuth'

const schema = z.object({
  handle: z.string()
    .min(3,  'At least 3 characters')
    .max(30, 'At most 30 characters')
    .regex(/^[a-zA-Z0-9_]+$/, 'Letters, numbers, and underscores only'),
  email:    z.string().email('Invalid email address'),
  password: z.string().min(8, 'At least 8 characters'),
})

type Fields = z.infer<typeof schema>

export default function RegisterPage() {
  const navigate  = useNavigate()
  const register  = useRegister()
  const [form,    setForm]    = useState<Fields>({ handle: '', email: '', password: '' })
  const [fieldErr, setFieldErr] = useState<Partial<Fields>>({})
  const [serverErr, setServerErr] = useState('')

  const set = (k: keyof Fields) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm(prev => ({ ...prev, [k]: e.target.value }))

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    setFieldErr({})
    setServerErr('')

    const result = schema.safeParse(form)
    if (!result.success) {
      const errs: Partial<Fields> = {}
      result.error.issues.forEach(issue => {
        const key = issue.path[0] as keyof Fields
        if (key && !errs[key]) errs[key] = issue.message
      })
      setFieldErr(errs)
      return
    }

    register.mutate(result.data, {
      onSuccess: () => navigate('/members'),
      onError:   (err) => setServerErr(err.message),
    })
  }

  return (
    <div className="min-h-[60vh] flex items-center justify-center">
      <div className="w-full max-w-sm">
        <h1 className="text-2xl font-bold text-gray-900 mb-6 text-center">Create account</h1>

        <form onSubmit={handleSubmit} className="bg-white rounded-lg border border-gray-200 p-6 space-y-4">
          {serverErr && (
            <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded px-3 py-2">
              {serverErr}
            </p>
          )}

          <Field label="Handle" error={fieldErr.handle}>
            <input
              type="text"
              value={form.handle}
              onChange={set('handle')}
              placeholder="your_handle"
              autoComplete="username"
              className={inputCls(!!fieldErr.handle)}
            />
          </Field>

          <Field label="Email" error={fieldErr.email}>
            <input
              type="email"
              value={form.email}
              onChange={set('email')}
              placeholder="you@example.com"
              autoComplete="email"
              className={inputCls(!!fieldErr.email)}
            />
          </Field>

          <Field label="Password" error={fieldErr.password}>
            <input
              type="password"
              value={form.password}
              onChange={set('password')}
              placeholder="8+ characters"
              autoComplete="new-password"
              className={inputCls(!!fieldErr.password)}
            />
          </Field>

          <button
            type="submit"
            disabled={register.isPending}
            className="w-full bg-slate-800 hover:bg-slate-700 disabled:opacity-50 text-white text-sm font-medium py-2 rounded-lg transition-colors"
          >
            {register.isPending ? 'Creating account…' : 'Create account'}
          </button>
        </form>

        <p className="mt-4 text-center text-sm text-gray-500">
          Already have an account?{' '}
          <Link to="/login" className="text-slate-700 hover:underline font-medium">Sign in</Link>
        </p>
      </div>
    </div>
  )
}

function inputCls(hasError: boolean) {
  return `w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400 ${
    hasError ? 'border-red-400' : 'border-gray-300'
  }`
}

function Field({ label, error, children }: { label: string; error?: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 mb-1">{label}</label>
      {children}
      {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
    </div>
  )
}
