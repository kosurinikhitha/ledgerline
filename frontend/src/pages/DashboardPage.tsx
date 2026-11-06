import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { accountsApi, Account } from '../api/accounts';
import { useAuth } from '../context/AuthContext';
import { TrendingUp, TrendingDown, Plus, ArrowRight, AlertTriangle } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';

function formatCurrency(amount: string | number, currency = 'INR') {
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency }).format(parseFloat(amount as string));
}

export default function DashboardPage() {
  const { user } = useAuth();
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [newAccountName, setNewAccountName] = useState('');
  const [creating, setCreating] = useState(false);

  const loadAccounts = async () => {
    try {
      const data = await accountsApi.list();
      setAccounts(data);
    } catch {
      setError('Failed to load accounts');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadAccounts(); }, []);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setCreating(true);
    try {
      await accountsApi.create({ name: newAccountName });
      setShowCreate(false);
      setNewAccountName('');
      loadAccounts();
    } catch {
      setError('Failed to create account');
    } finally {
      setCreating(false);
    }
  };

  const totalBalance = accounts.reduce((sum, a) => sum + parseFloat(a.balance), 0);

  if (loading) return (
    <div className="p-8 flex items-center justify-center">
      <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
    </div>
  );

  return (
    <div className="p-8">
      <div className="mb-8 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Welcome back, {user?.name?.split(' ')[0]}</h1>
          <p className="text-gray-500 mt-1">Here's your financial overview</p>
        </div>
        {user?.role !== 'auditor' && (
          <button onClick={() => setShowCreate(true)} className="btn-primary flex items-center gap-2">
            <Plus className="w-4 h-4" />
            New Account
          </button>
        )}
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
        <div className="card">
          <p className="text-sm text-gray-500">Total Balance</p>
          <p className="text-3xl font-bold text-gray-900 mt-1">{formatCurrency(totalBalance)}</p>
          <p className="text-xs text-gray-400 mt-1">Across {accounts.length} account{accounts.length !== 1 ? 's' : ''}</p>
        </div>
        <div className="card">
          <p className="text-sm text-gray-500">Active Accounts</p>
          <p className="text-3xl font-bold text-gray-900 mt-1">{accounts.filter(a => a.is_active).length}</p>
          <p className="text-xs text-gray-400 mt-1">of {accounts.length} total</p>
        </div>
        <div className="card">
          <p className="text-sm text-gray-500">Your Role</p>
          <p className="text-2xl font-bold text-blue-700 mt-1 capitalize">{user?.role?.replace('_', ' ')}</p>
          <p className="text-xs text-gray-400 mt-1">{user?.email}</p>
        </div>
      </div>

      {error && (
        <div className="flex items-center gap-2 text-red-600 bg-red-50 p-3 rounded-lg mb-6" role="alert">
          <AlertTriangle className="w-4 h-4" />
          {error}
        </div>
      )}

      {/* Create Account Modal */}
      {showCreate && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" role="dialog" aria-modal="true">
          <div className="bg-white rounded-xl p-6 w-full max-w-sm mx-4">
            <h2 className="text-lg font-semibold mb-4">Create New Account</h2>
            <form onSubmit={handleCreate} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Account Name</label>
                <input
                  className="input-field"
                  value={newAccountName}
                  onChange={(e) => setNewAccountName(e.target.value)}
                  placeholder="e.g. Main Savings"
                  required
                  minLength={2}
                  autoFocus
                />
              </div>
              <div className="flex gap-3">
                <button type="submit" disabled={creating} className="btn-primary flex-1">
                  {creating ? 'Creating...' : 'Create'}
                </button>
                <button type="button" onClick={() => setShowCreate(false)} className="btn-secondary flex-1">
                  Cancel
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Accounts List */}
      <div>
        <h2 className="text-lg font-semibold text-gray-900 mb-4">Accounts</h2>
        {accounts.length === 0 ? (
          <div className="card text-center py-12">
            <p className="text-gray-500">No accounts yet.</p>
            {user?.role !== 'auditor' && (
              <button onClick={() => setShowCreate(true)} className="mt-4 btn-primary">
                Create your first account
              </button>
            )}
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {accounts.map((account) => (
              <Link
                key={account.id}
                to={`/accounts/${account.id}`}
                className="card hover:shadow-md transition-shadow group"
              >
                <div className="flex items-start justify-between">
                  <div>
                    <div className="flex items-center gap-2">
                      <h3 className="font-semibold text-gray-900">{account.name}</h3>
                      {!account.is_active && (
                        <span className="text-xs bg-red-100 text-red-700 px-2 py-0.5 rounded-full">Inactive</span>
                      )}
                    </div>
                    {user?.role !== 'account_holder' && (
                      <p className="text-xs text-gray-400 mt-0.5">{account.owner_name}</p>
                    )}
                  </div>
                  <ArrowRight className="w-4 h-4 text-gray-400 group-hover:text-blue-600 transition-colors mt-1" />
                </div>

                <div className="mt-4">
                  <p className="text-2xl font-bold text-gray-900">
                    {formatCurrency(account.balance, account.currency)}
                  </p>
                  {parseFloat(account.overdraft_limit) > 0 && (
                    <p className="text-xs text-gray-400 mt-1">
                      Overdraft limit: {formatCurrency(account.overdraft_limit)}
                    </p>
                  )}
                </div>

                <div className="mt-3 flex items-center gap-2">
                  {parseFloat(account.balance) >= 0 ? (
                    <span className="flex items-center gap-1 text-xs text-green-600">
                      <TrendingUp className="w-3 h-3" /> Positive
                    </span>
                  ) : (
                    <span className="flex items-center gap-1 text-xs text-red-600">
                      <TrendingDown className="w-3 h-3" /> Overdrawn
                    </span>
                  )}
                  <span className="text-xs text-gray-400">
                    · Created {formatDistanceToNow(new Date(account.created_at), { addSuffix: true })}
                  </span>
                </div>
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
