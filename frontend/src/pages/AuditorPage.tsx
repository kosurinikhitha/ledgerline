import React, { useEffect, useState } from 'react';
import { auditorApi } from '../api/accounts';
import { BookOpen, CheckCircle, AlertTriangle, Key, XCircle } from 'lucide-react';
import { format } from 'date-fns';

interface LedgerEntry {
  id: string;
  account_name: string;
  entry_type: 'DEBIT' | 'CREDIT';
  amount: string;
  running_balance: string;
  description: string;
  created_at: string;
  initiated_by_name: string;
  transaction_type: string;
  transaction_status: string;
}

interface IdempotencyKey {
  key: string;
  user_name: string;
  status: string;
  response_status: number;
  created_at: string;
  completed_at: string | null;
}

export default function AuditorPage() {
  const [ledger, setLedger] = useState<LedgerEntry[]>([]);
  const [idemKeys, setIdemKeys] = useState<IdempotencyKey[]>([]);
  const [conservation, setConservation] = useState<{ balanced: boolean; ledger_net: string; total_balance_sum: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<'ledger' | 'idempotency' | 'conservation'>('ledger');

  useEffect(() => {
    Promise.all([
      auditorApi.ledger({ page: 1 }),
      auditorApi.idempotencyKeys(),
      auditorApi.conservation(),
    ]).then(([l, k, c]) => {
      setLedger(l.entries);
      setIdemKeys(k);
      setConservation(c);
      setLoading(false);
    });
  }, []);

  if (loading) return (
    <div className="p-8 flex items-center justify-center">
      <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
    </div>
  );

  return (
    <div className="p-8">
      <div className="mb-8 flex items-center gap-3">
        <BookOpen className="w-6 h-6 text-blue-600" />
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Audit Ledger</h1>
          <p className="text-gray-500">Read-only view of all financial records</p>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-4 mb-6 border-b border-gray-200">
        {([
          { key: 'ledger', label: 'Ledger Entries' },
          { key: 'idempotency', label: 'Idempotency Log' },
          { key: 'conservation', label: 'Conservation' },
        ] as const).map(({ key, label }) => (
          <button
            key={key}
            onClick={() => setActiveTab(key)}
            className={`pb-3 text-sm font-medium border-b-2 transition-colors ${activeTab === key ? 'border-blue-600 text-blue-600' : 'border-transparent text-gray-500 hover:text-gray-700'}`}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Ledger */}
      {activeTab === 'ledger' && (
        <div className="card">
          <p className="text-xs text-gray-400 mb-4 bg-yellow-50 border border-yellow-200 rounded-lg p-3">
            <strong>Append-only:</strong> These entries cannot be updated or deleted. Any attempt raises a database exception.
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-gray-500 border-b border-gray-100">
                  <th className="pb-3 pr-4">Date</th>
                  <th className="pb-3 pr-4">Account</th>
                  <th className="pb-3 pr-4">Type</th>
                  <th className="pb-3 pr-4 text-right">Amount</th>
                  <th className="pb-3 pr-4 text-right">Running Balance</th>
                  <th className="pb-3">Initiated By</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {ledger.map((entry) => (
                  <tr key={entry.id} className="hover:bg-gray-50">
                    <td className="py-3 pr-4 text-xs text-gray-500 whitespace-nowrap">
                      {format(new Date(entry.created_at), 'dd MMM yyyy HH:mm:ss')}
                    </td>
                    <td className="py-3 pr-4 text-gray-700">{entry.account_name}</td>
                    <td className="py-3 pr-4">
                      <span className={entry.entry_type === 'CREDIT' ? 'badge-credit' : 'badge-debit'}>
                        {entry.entry_type}
                      </span>
                    </td>
                    <td className={`py-3 pr-4 text-right font-mono ${entry.entry_type === 'CREDIT' ? 'text-green-600' : 'text-red-600'}`}>
                      {entry.entry_type === 'CREDIT' ? '+' : '−'}₹{parseFloat(entry.amount).toFixed(2)}
                    </td>
                    <td className="py-3 pr-4 text-right font-mono text-gray-900">
                      ₹{parseFloat(entry.running_balance).toFixed(2)}
                    </td>
                    <td className="py-3 text-xs text-gray-500">{entry.initiated_by_name}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Idempotency Keys */}
      {activeTab === 'idempotency' && (
        <div className="card">
          <p className="text-xs text-gray-400 mb-4 bg-blue-50 border border-blue-200 rounded-lg p-3">
            Each key here represents one client request. Status COMPLETE = processed once. Duplicates reuse the same key and get the same response.
          </p>
          <div className="space-y-2">
            {idemKeys.map((k) => (
              <div key={k.key} className="flex items-center gap-3 py-2 border-b border-gray-50">
                <Key className="w-4 h-4 text-gray-400 flex-shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-xs font-mono text-gray-600 truncate">{k.key}</span>
                    <span className={`text-xs px-2 py-0.5 rounded-full ${
                      k.status === 'COMPLETE' ? 'bg-green-100 text-green-700' :
                      k.status === 'PENDING' ? 'bg-yellow-100 text-yellow-700' :
                      'bg-red-100 text-red-700'
                    }`}>{k.status}</span>
                    <span className="text-xs text-gray-400">HTTP {k.response_status}</span>
                  </div>
                  <p className="text-xs text-gray-500 mt-0.5">
                    By {k.user_name} · Created {format(new Date(k.created_at), 'dd MMM HH:mm:ss')}
                    {k.completed_at && ` · Completed ${format(new Date(k.completed_at), 'HH:mm:ss')}`}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Conservation */}
      {activeTab === 'conservation' && conservation && (
        <div className={`card ${conservation.balanced ? 'border-green-200 bg-green-50' : 'border-red-200 bg-red-50'}`}>
          <div className="flex items-center gap-3 mb-6">
            {conservation.balanced
              ? <CheckCircle className="w-8 h-8 text-green-600" />
              : <AlertTriangle className="w-8 h-8 text-red-600" />
            }
            <div>
              <h2 className={`text-xl font-bold ${conservation.balanced ? 'text-green-900' : 'text-red-900'}`}>
                {conservation.balanced ? 'Money is conserved' : 'Conservation failure detected'}
              </h2>
              <p className="text-sm text-gray-600">The invariant: SUM(credits) - SUM(debits) = SUM(account balances)</p>
            </div>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="bg-white rounded-lg p-4">
              <p className="text-sm text-gray-500">Ledger Net</p>
              <p className="text-2xl font-mono font-bold text-gray-900">₹{parseFloat(conservation.ledger_net).toLocaleString('en-IN')}</p>
            </div>
            <div className="bg-white rounded-lg p-4">
              <p className="text-sm text-gray-500">Sum of Account Balances</p>
              <p className="text-2xl font-mono font-bold text-gray-900">₹{parseFloat(conservation.total_balance_sum).toLocaleString('en-IN')}</p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
