import React, { useEffect, useState } from 'react';
import { adminApi } from '../api/accounts';
import { CheckCircle, XCircle, AlertTriangle, Users, Activity, Shield } from 'lucide-react';
import { format } from 'date-fns';

interface ConservationResult {
  ledger_net: string;
  total_balance_sum: string;
  balanced: boolean;
  discrepancy: string;
  checked_at: string;
}

interface UserRecord {
  id: string;
  email: string;
  name: string;
  role: string;
  is_active: boolean;
  account_count: string;
  created_at: string;
}

interface AuditEntry {
  id: string;
  user_name: string;
  action: string;
  resource: string;
  details: Record<string, unknown>;
  created_at: string;
}

export default function AdminPage() {
  const [conservation, setConservation] = useState<ConservationResult | null>(null);
  const [users, setUsers] = useState<UserRecord[]>([]);
  const [auditLog, setAuditLog] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<'conservation' | 'users' | 'audit'>('conservation');

  const load = async () => {
    try {
      const [cons, usrs, audit] = await Promise.all([
        adminApi.conservation(),
        adminApi.users(),
        adminApi.auditLog({ page: 1 }),
      ]);
      setConservation(cons);
      setUsers(usrs);
      setAuditLog(audit.logs);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const toggleUser = async (userId: string, currentActive: boolean) => {
    await adminApi.updateUser(userId, { is_active: !currentActive });
    setUsers((prev) => prev.map((u) => u.id === userId ? { ...u, is_active: !currentActive } : u));
  };

  if (loading) return (
    <div className="p-8 flex items-center justify-center">
      <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
    </div>
  );

  return (
    <div className="p-8">
      <div className="mb-8 flex items-center gap-3">
        <Shield className="w-6 h-6 text-blue-600" />
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Admin Panel</h1>
          <p className="text-gray-500">System health, users, and audit trail</p>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-4 mb-6 border-b border-gray-200">
        {([
          { key: 'conservation', label: 'Conservation Check', icon: Activity },
          { key: 'users', label: 'Users', icon: Users },
          { key: 'audit', label: 'Audit Log', icon: Activity },
        ] as const).map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            onClick={() => setActiveTab(key)}
            className={`flex items-center gap-2 pb-3 text-sm font-medium border-b-2 transition-colors ${activeTab === key ? 'border-blue-600 text-blue-600' : 'border-transparent text-gray-500 hover:text-gray-700'}`}
          >
            <Icon className="w-4 h-4" />
            {label}
          </button>
        ))}
      </div>

      {/* Conservation Check */}
      {activeTab === 'conservation' && conservation && (
        <div className="space-y-4">
          <div className={`card ${conservation.balanced ? 'border-green-200 bg-green-50' : 'border-red-200 bg-red-50'}`}>
            <div className="flex items-center gap-3 mb-4">
              {conservation.balanced
                ? <CheckCircle className="w-6 h-6 text-green-600" />
                : <AlertTriangle className="w-6 h-6 text-red-600" />
              }
              <div>
                <h2 className={`text-lg font-semibold ${conservation.balanced ? 'text-green-900' : 'text-red-900'}`}>
                  Money {conservation.balanced ? 'is conserved ✓' : 'is NOT balanced ✗'}
                </h2>
                <p className="text-sm text-gray-500">Checked at {format(new Date(conservation.checked_at), 'HH:mm:ss dd MMM yyyy')}</p>
              </div>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-sm">
              <div>
                <p className="text-gray-500">Ledger Net (Credits - Debits)</p>
                <p className="font-mono font-semibold text-gray-900">₹{parseFloat(conservation.ledger_net).toLocaleString('en-IN', { minimumFractionDigits: 4 })}</p>
              </div>
              <div>
                <p className="text-gray-500">Sum of All Balances</p>
                <p className="font-mono font-semibold text-gray-900">₹{parseFloat(conservation.total_balance_sum).toLocaleString('en-IN', { minimumFractionDigits: 4 })}</p>
              </div>
              <div>
                <p className="text-gray-500">Discrepancy</p>
                <p className={`font-mono font-semibold ${conservation.discrepancy === '0.0000' ? 'text-green-600' : 'text-red-600'}`}>
                  ₹{conservation.discrepancy}
                </p>
              </div>
            </div>
          </div>
          <button onClick={load} className="btn-secondary">Refresh Check</button>
        </div>
      )}

      {/* Users */}
      {activeTab === 'users' && (
        <div className="card">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-gray-500 border-b border-gray-100">
                  <th className="pb-3 pr-4">Name</th>
                  <th className="pb-3 pr-4">Email</th>
                  <th className="pb-3 pr-4">Role</th>
                  <th className="pb-3 pr-4">Accounts</th>
                  <th className="pb-3 pr-4">Status</th>
                  <th className="pb-3">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {users.map((u) => (
                  <tr key={u.id}>
                    <td className="py-3 pr-4 font-medium">{u.name}</td>
                    <td className="py-3 pr-4 text-gray-500">{u.email}</td>
                    <td className="py-3 pr-4">
                      <span className="text-xs bg-blue-100 text-blue-700 px-2 py-0.5 rounded-full capitalize">
                        {u.role.replace('_', ' ')}
                      </span>
                    </td>
                    <td className="py-3 pr-4 text-gray-500">{u.account_count}</td>
                    <td className="py-3 pr-4">
                      {u.is_active
                        ? <span className="flex items-center gap-1 text-green-600 text-xs"><CheckCircle className="w-3 h-3" /> Active</span>
                        : <span className="flex items-center gap-1 text-red-600 text-xs"><XCircle className="w-3 h-3" /> Inactive</span>
                      }
                    </td>
                    <td className="py-3">
                      <button
                        onClick={() => toggleUser(u.id, u.is_active)}
                        className={`text-xs px-2 py-1 rounded-lg ${u.is_active ? 'bg-red-50 text-red-600 hover:bg-red-100' : 'bg-green-50 text-green-600 hover:bg-green-100'}`}
                      >
                        {u.is_active ? 'Deactivate' : 'Activate'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Audit Log */}
      {activeTab === 'audit' && (
        <div className="card">
          <div className="space-y-2">
            {auditLog.map((log) => (
              <div key={log.id} className="flex items-start gap-3 py-2 border-b border-gray-50">
                <Activity className="w-4 h-4 text-gray-400 flex-shrink-0 mt-0.5" />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-medium text-gray-900">{log.action}</span>
                    <span className="text-xs text-gray-500">by {log.user_name}</span>
                    <span className="text-xs text-gray-400">{format(new Date(log.created_at), 'dd MMM HH:mm:ss')}</span>
                  </div>
                  <p className="text-xs text-gray-500 mt-0.5 font-mono truncate">{JSON.stringify(log.details)}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
