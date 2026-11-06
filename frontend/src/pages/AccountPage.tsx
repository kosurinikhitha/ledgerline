import React, { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { accountsApi, Account, DirectoryAccount, LedgerEntry, RefusedAttempt, StatementResponse, transactionsApi, newIdempotencyKey } from '../api/accounts';
import { useAuth } from '../context/AuthContext';
import { ArrowLeft, ArrowUp, ArrowDown, ArrowLeftRight, XCircle } from 'lucide-react';
import { format } from 'date-fns';

function formatCurrency(amount: string | number, currency = 'INR') {
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency }).format(parseFloat(amount as string));
}

type ModalType = 'deposit' | 'withdraw' | 'transfer' | null;

export default function AccountPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { user } = useAuth();
  const [account, setAccount] = useState<Account | null>(null);
  const [statement, setStatement] = useState<StatementResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState<ModalType>(null);
  const [amount, setAmount] = useState('');
  const [description, setDescription] = useState('');
  const [toAccountId, setToAccountId] = useState('');
  const [allAccounts, setAllAccounts] = useState<DirectoryAccount[]>([]);
  // One key per intent: a double-click or retry re-sends the SAME key; editing a field or finishing starts a new intent.
  const [intentKey, setIntentKey] = useState(newIdempotencyKey());
  const [submitting, setSubmitting] = useState(false);
  const [opError, setOpError] = useState('');
  const [opSuccess, setOpSuccess] = useState('');
  const [activeTab, setActiveTab] = useState<'entries' | 'refused'>('entries');

  const load = async () => {
    if (!id) return;
    try {
      const [acc, stmt] = await Promise.all([
        accountsApi.get(id),
        accountsApi.statement(id, { limit: 50 }),
      ]);
      setAccount(acc);
      setStatement(stmt);
    } catch {
      navigate('/dashboard');
    } finally {
      setLoading(false);
    }
  };

  const loadAllAccounts = async () => {
    try {
      const accs = await accountsApi.directory();
      setAllAccounts(accs.filter((a) => a.id !== id));
    } catch {
      setAllAccounts([]); // auditors cannot transfer and have no directory
    }
  };

  useEffect(() => { load(); loadAllAccounts(); }, [id]);

  const handleOperation = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!id || !account) return;
    setSubmitting(true);
    setOpError('');
    setOpSuccess('');

    const amt = parseFloat(amount);
    if (isNaN(amt) || amt <= 0) {
      setOpError('Enter a valid positive amount');
      setSubmitting(false);
      return;
    }

    try {
      if (modal === 'deposit') {
        await transactionsApi.deposit({ account_id: id, amount: amt, description: description || 'Deposit' }, intentKey);
        setOpSuccess(`Deposited ${formatCurrency(amt)} successfully`);
      } else if (modal === 'withdraw') {
        await transactionsApi.withdrawal({ account_id: id, amount: amt, description: description || 'Withdrawal' }, intentKey);
        setOpSuccess(`Withdrew ${formatCurrency(amt)} successfully`);
      } else if (modal === 'transfer') {
        if (!toAccountId) { setOpError('Select a destination account'); setSubmitting(false); return; }
        await transactionsApi.transfer({ from_account_id: id, to_account_id: toAccountId, amount: amt, description: description || 'Transfer' }, intentKey);
        setOpSuccess(`Transferred ${formatCurrency(amt)} successfully`);
      }
      setModal(null);
      setAmount('');
      setDescription('');
      setToAccountId('');
      setIntentKey(newIdempotencyKey()); // finished: next submission is a new intent
      load();
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { message?: string } } })?.response?.data?.message ?? 'Operation failed';
      setOpError(msg);
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) return (
    <div className="p-8 flex items-center justify-center">
      <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
    </div>
  );

  if (!account) return null;

  const isOwnerOrAdmin = user?.role === 'admin' || account.owner_id === user?.id;
  const canOperate = isOwnerOrAdmin && account.is_active;

  return (
    <div className="p-8">
      <button onClick={() => navigate('/dashboard')} className="flex items-center gap-2 text-gray-500 hover:text-gray-900 mb-6 text-sm">
        <ArrowLeft className="w-4 h-4" />
        Back to Dashboard
      </button>

      {/* Account Header */}
      <div className="card mb-6">
        <div className="flex items-start justify-between flex-wrap gap-4">
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-2xl font-bold text-gray-900">{account.name}</h1>
              {!account.is_active && <span className="text-xs bg-red-100 text-red-700 px-2 py-1 rounded-full">Inactive</span>}
            </div>
            {user?.role !== 'account_holder' && (
              <p className="text-sm text-gray-500 mt-1">Owner: {account.owner_name} ({account.owner_email})</p>
            )}
            <p className="text-xs text-gray-400 mt-1">ID: {account.id}</p>
          </div>
          <div className="text-right">
            <p className="text-sm text-gray-500">Current Balance</p>
            <p className={`text-3xl font-bold ${parseFloat(account.balance) < 0 ? 'text-red-600' : 'text-gray-900'}`}>
              {formatCurrency(account.balance, account.currency)}
            </p>
            {parseFloat(account.overdraft_limit) > 0 && (
              <p className="text-xs text-gray-400 mt-1">Overdraft: {formatCurrency(account.overdraft_limit)}</p>
            )}
          </div>
        </div>

        {/* Action Buttons */}
        {canOperate && (
          <div className="flex gap-3 mt-6 flex-wrap">
            <button onClick={() => { setModal('deposit'); setOpError(''); setOpSuccess(''); }} className="btn-primary flex items-center gap-2">
              <ArrowDown className="w-4 h-4" /> Deposit
            </button>
            <button onClick={() => { setModal('withdraw'); setOpError(''); setOpSuccess(''); }} className="btn-secondary flex items-center gap-2">
              <ArrowUp className="w-4 h-4" /> Withdraw
            </button>
            <button onClick={() => { setModal('transfer'); setOpError(''); setOpSuccess(''); }} className="btn-secondary flex items-center gap-2">
              <ArrowLeftRight className="w-4 h-4" /> Transfer
            </button>
          </div>
        )}

        {opSuccess && (
          <div className="mt-4 text-sm text-green-700 bg-green-50 px-4 py-2 rounded-lg" role="status">{opSuccess}</div>
        )}
      </div>

      {/* Statement Tabs */}
      <div className="card">
        <div className="flex gap-4 mb-6 border-b border-gray-200">
          <button
            onClick={() => setActiveTab('entries')}
            className={`pb-3 text-sm font-medium border-b-2 transition-colors ${activeTab === 'entries' ? 'border-blue-600 text-blue-600' : 'border-transparent text-gray-500 hover:text-gray-700'}`}
          >
            Ledger Entries ({statement?.pagination.total ?? 0})
          </button>
          <button
            onClick={() => setActiveTab('refused')}
            className={`pb-3 text-sm font-medium border-b-2 transition-colors ${activeTab === 'refused' ? 'border-red-500 text-red-500' : 'border-transparent text-gray-500 hover:text-gray-700'}`}
          >
            Refused Attempts ({statement?.refused_attempts.length ?? 0})
          </button>
        </div>

        {activeTab === 'entries' && (
          <>
            {(!statement?.entries || statement.entries.length === 0) ? (
              <p className="text-gray-400 text-sm text-center py-8">No transactions yet</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-gray-500 border-b border-gray-100">
                      <th className="pb-3 pr-4">Date</th>
                      <th className="pb-3 pr-4">Type</th>
                      <th className="pb-3 pr-4">Description</th>
                      <th className="pb-3 pr-4 text-right">Amount</th>
                      <th className="pb-3 text-right">Balance</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-50">
                    {statement.entries.map((entry: LedgerEntry) => (
                      <tr key={entry.id} className="hover:bg-gray-50">
                        <td className="py-3 pr-4 text-gray-500 text-xs whitespace-nowrap">
                          {format(new Date(entry.created_at), 'dd MMM yyyy HH:mm')}
                        </td>
                        <td className="py-3 pr-4">
                          <span className={entry.entry_type === 'CREDIT' ? 'badge-credit' : 'badge-debit'}>
                            {entry.entry_type === 'CREDIT' ? '+ Credit' : '− Debit'}
                          </span>
                        </td>
                        <td className="py-3 pr-4 text-gray-700 max-w-xs truncate">
                          {entry.description}
                          <span className="block text-xs text-gray-400">{entry.initiated_by_name}</span>
                        </td>
                        <td className={`py-3 pr-4 text-right font-medium ${entry.entry_type === 'CREDIT' ? 'text-green-600' : 'text-red-600'}`}>
                          {entry.entry_type === 'CREDIT' ? '+' : '−'}{formatCurrency(entry.amount)}
                        </td>
                        <td className="py-3 text-right font-medium text-gray-900">
                          {formatCurrency(entry.running_balance)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}

        {activeTab === 'refused' && (
          <>
            {(!statement?.refused_attempts || statement.refused_attempts.length === 0) ? (
              <p className="text-gray-400 text-sm text-center py-8">No refused attempts</p>
            ) : (
              <div className="space-y-3">
                {statement.refused_attempts.map((attempt: RefusedAttempt) => (
                  <div key={attempt.id} className="flex items-start gap-3 bg-red-50 p-3 rounded-lg">
                    <XCircle className="w-4 h-4 text-red-500 flex-shrink-0 mt-0.5" />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-medium text-red-700">{attempt.operation}</span>
                        {attempt.amount && (
                          <span className="text-sm text-red-600">for {formatCurrency(attempt.amount)}</span>
                        )}
                        <span className="text-xs text-gray-400">{format(new Date(attempt.created_at), 'dd MMM yyyy HH:mm')}</span>
                      </div>
                      <p className="text-xs text-gray-600 mt-1">{attempt.reason}</p>
                      <p className="text-xs text-gray-400 mt-0.5">By: {attempt.attempted_by_name}</p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>

      {/* Operation Modal */}
      {modal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" role="dialog" aria-modal="true">
          <div className="bg-white rounded-xl p-6 w-full max-w-sm mx-4">
            <h2 className="text-lg font-semibold mb-4 capitalize">{modal} Money</h2>
            <form onSubmit={handleOperation} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Amount (INR)</label>
                <input
                  className="input-field"
                  type="number"
                  step="0.01"
                  min="0.01"
                  value={amount}
                  onChange={(e) => { setAmount(e.target.value); setIntentKey(newIdempotencyKey()); }}
                  placeholder="0.00"
                  required
                  autoFocus
                />
              </div>

              {modal === 'transfer' && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">To Account</label>
                  <select
                    className="input-field"
                    value={toAccountId}
                    onChange={(e) => { setToAccountId(e.target.value); setIntentKey(newIdempotencyKey()); }}
                    required
                  >
                    <option value="">Select account...</option>
                    {allAccounts.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name} ({a.owner_name})
                      </option>
                    ))}
                  </select>
                </div>
              )}

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Description (optional)</label>
                <input
                  className="input-field"
                  value={description}
                  onChange={(e) => { setDescription(e.target.value); setIntentKey(newIdempotencyKey()); }}
                  placeholder="What is this for?"
                  maxLength={500}
                />
              </div>

              {opError && (
                <div className="text-sm text-red-600 bg-red-50 p-3 rounded-lg" role="alert">{opError}</div>
              )}

              <div className="flex gap-3">
                <button type="submit" disabled={submitting} className="btn-primary flex-1">
                  {submitting ? 'Processing...' : `Confirm ${modal}`}
                </button>
                <button type="button" onClick={() => { setModal(null); setOpError(''); }} className="btn-secondary flex-1">
                  Cancel
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
