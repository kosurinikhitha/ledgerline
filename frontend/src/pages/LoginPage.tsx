import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { BookMarked, AlertCircle } from 'lucide-react';

const SHOW_DEMO_ACCOUNTS = import.meta.env.VITE_SHOW_DEMO_ACCOUNTS !== 'false';

export default function LoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const { login } = useAuth();
  const navigate = useNavigate();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await login(email, password);
      navigate('/dashboard');
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { message?: string } } })?.response?.data?.message ?? 'Login failed';
      setError(msg);
    } finally {
      setLoading(false);
    }
  };

  const demoAccounts = [
    { role: 'Admin', email: 'admin@ledgerline.dev', label: 'Alice Admin' },
    { role: 'Account Holder', email: 'bob@ledgerline.dev', label: 'Bob Holder' },
    { role: 'Account Holder', email: 'carol@ledgerline.dev', label: 'Carol Holder' },
    { role: 'Auditor', email: 'auditor@ledgerline.dev', label: 'Dave Auditor' },
  ];

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-14 h-14 bg-blue-600 rounded-2xl mb-4">
            <BookMarked className="w-7 h-7 text-white" />
          </div>
          <h1 className="text-3xl font-bold text-gray-900">LedgerLine</h1>
          <p className="text-gray-600 mt-1">Money movement you can prove</p>
        </div>

        <div className="card">
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label htmlFor="email" className="block text-sm font-medium text-gray-700 mb-1">
                Email address
              </label>
              <input
                id="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="input-field"
                placeholder="you@example.com"
                required
                autoComplete="email"
              />
            </div>

            <div>
              <label htmlFor="password" className="block text-sm font-medium text-gray-700 mb-1">
                Password
              </label>
              <input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="input-field"
                placeholder="••••••••"
                required
                autoComplete="current-password"
              />
            </div>

            {error && (
              <div className="flex items-center gap-2 text-red-600 bg-red-50 p-3 rounded-lg text-sm" role="alert">
                <AlertCircle className="w-4 h-4 flex-shrink-0" />
                {error}
              </div>
            )}

            <button type="submit" disabled={loading} className="btn-primary w-full">
              {loading ? 'Signing in...' : 'Sign in'}
            </button>
          </form>
        </div>

        {/* Demo credentials: shown for evaluation. Set VITE_SHOW_DEMO_ACCOUNTS=false and redeploy to hide. */}
        {SHOW_DEMO_ACCOUNTS && (
          <div className="mt-6 card">
            <p className="text-sm font-medium text-gray-700 mb-3">Demo accounts (password: Password123!)</p>
            <div className="space-y-2">
              {demoAccounts.map((acc) => (
                <button
                  key={acc.email}
                  type="button"
                  onClick={() => { setEmail(acc.email); setPassword('Password123!'); }}
                  className="w-full text-left px-3 py-2 text-sm hover:bg-gray-50 rounded-lg transition-colors"
                >
                  <span className="font-medium text-gray-900">{acc.label}</span>
                  <span className="text-gray-500 ml-2">({acc.role})</span>
                  <span className="block text-xs text-gray-400">{acc.email}</span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
