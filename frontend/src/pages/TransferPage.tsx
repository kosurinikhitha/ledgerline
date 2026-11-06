import React, { useEffect, useState } from 'react';
import { accountsApi, Account, DirectoryAccount, transactionsApi, newIdempotencyKey } from '../api/accounts';
import { useAuth } from '../context/AuthContext';
import { ArrowRight, CheckCircle, AlertCircle } from 'lucide-react';

function formatCurrency(amount: string | number, currency = 'INR') {
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency }).format(parseFloat(amount as string));
}

export default function TransferPage() {
  const { user } = useAuth();
  const [mine, setMine] = useState<Account[]>([]);
  const [directory, setDirectory] = useState<DirectoryAccount[]>([]);
  const [fromId, setFromId] = useState('');
  const [toId, setToId] = useState('');
  const [amount, setAmount] = useState('');
  const [description, setDescription] = useState('');
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  // One Idempotency-Key per user intent. Double-clicks and retries of the same form re-send
  // the same key, so the server moves money once. Editing any field starts a new intent.
  const [intentKey, setIntentKey] = useState(newIdempotencyKey());

  const load = async () => {
    const [accs, dir] = await Promise.all([accountsApi.list(), accountsApi.directory()]);
    // The server decides who may move money; this list is only a convenience.
    setMine(accs.filter((a) => a.is_active && (user?.role === 'admin' || a.owner_id === user?.id)));
    setDirectory(dir);
    setLoading(false);
  };

  useEffect(() => { load().catch(() => setLoading(false)); }, []);

  const edit = <T,>(setter: (v: T) => void) => (v: T) => { setter(v); setIntentKey(newIdempotencyKey()); };

  const fromAccount = mine.find((a) => a.id === fromId);
  const toAccount = directory.find((a) => a.id === toId);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    setError('');
    setSuccess('');

    if (!fromId || !toId) { setError('Select both accounts'); return; }
    if (fromId === toId) { setError('Cannot transfer to the same account'); return; }
    const amt = parseFloat(amount);
    if (isNaN(amt) || amt <= 0) { setError('Enter a valid amount'); return; }

    setSubmitting(true);
    try {
      await transactionsApi.transfer(
        { from_account_id: fromId, to_account_id: toId, amount: amt, description: description || 'Transfer' },
        intentKey
      );
      setSuccess(`Transferred ${formatCurrency(amt)} from ${fromAccount?.name} to ${toAccount?.name}`);
      setAmount('');
      setDescription('');
      setIntentKey(newIdempotencyKey()); // completed: the next submit is a new intent
      await load();
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { message?: string } } })?.response?.data?.message ?? 'Transfer failed';
      setError(msg); // key is kept: pressing Confirm again is a safe retry of the same intent
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) return (
    <div className="p-8 flex items-center justify-center">
      <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
    </div>
  );

  return (
    <div className="p-8 max-w-2xl">
      <h1 className="text-2xl font-bold text-gray-900 mb-2">Transfer Money</h1>
      <p className="text-gray-500 mb-8">Move money between accounts. The server checks your permission and balance on every request.</p>

      {success && (
        <div className="flex items-center gap-2 text-green-700 bg-green-50 p-4 rounded-lg mb-6" role="status">
          <CheckCircle className="w-5 h-5 flex-shrink-0" />
          {success}
        </div>
      )}

      <div className="card">
        <form onSubmit={handleSubmit} className="space-y-6">
          <div className="grid grid-cols-1 md:grid-cols-[1fr,auto,1fr] gap-4 items-end">
            <div>
              <label htmlFor="from" className="block text-sm font-medium text-gray-700 mb-1">From account</label>
              <select id="from" className="input-field" value={fromId} onChange={(e) => edit(setFromId)(e.target.value)} required>
                <option value="">Select source...</option>
                {mine.map((a) => (
                  <option key={a.id} value={a.id} disabled={a.id === toId}>
                    {a.name} — {formatCurrency(a.balance, a.currency)}
                  </option>
                ))}
              </select>
              {fromAccount && (
                <p className="text-xs text-gray-400 mt-1">
                  Available: {formatCurrency(parseFloat(fromAccount.balance) + parseFloat(fromAccount.overdraft_limit), fromAccount.currency)}
                </p>
              )}
            </div>

            <div className="flex items-center justify-center pb-1" aria-hidden="true">
              <ArrowRight className="w-5 h-5 text-gray-400" />
            </div>

            <div>
              <label htmlFor="to" className="block text-sm font-medium text-gray-700 mb-1">To account</label>
              <select id="to" className="input-field" value={toId} onChange={(e) => edit(setToId)(e.target.value)} required>
                <option value="">Select destination...</option>
                {directory.map((a) => (
                  <option key={a.id} value={a.id} disabled={a.id === fromId}>
                    {a.name} ({a.owner_name})
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <label htmlFor="amount" className="block text-sm font-medium text-gray-700 mb-1">Amount (INR)</label>
            <input
              id="amount"
              className="input-field text-lg"
              type="number"
              step="0.01"
              min="0.01"
              max="10000000"
              value={amount}
              onChange={(e) => edit(setAmount)(e.target.value)}
              placeholder="0.00"
              required
            />
          </div>

          <div>
            <label htmlFor="desc" className="block text-sm font-medium text-gray-700 mb-1">Description (optional)</label>
            <input
              id="desc"
              className="input-field"
              value={description}
              onChange={(e) => edit(setDescription)(e.target.value)}
              placeholder="e.g. Rent, Invoice #123"
              maxLength={500}
            />
          </div>

          {error && (
            <div className="flex items-center gap-2 text-red-600 bg-red-50 p-3 rounded-lg" role="alert">
              <AlertCircle className="w-4 h-4 flex-shrink-0" />
              {error}
            </div>
          )}

          <button type="submit" disabled={submitting} className="btn-primary w-full text-base py-3">
            {submitting ? 'Processing transfer...' : 'Confirm transfer'}
          </button>
        </form>
      </div>

      <p className="text-xs text-gray-400 mt-4 text-center">
        If a request times out, press Confirm again: the same request key is reused and money moves at most once.
      </p>
    </div>
  );
}
