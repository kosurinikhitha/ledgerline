import api from './client';
import { v4 as uuidv4 } from 'uuid';

export interface Account {
  id: string;
  owner_id: string;
  owner_name: string;
  owner_email: string;
  name: string;
  balance: string;
  currency: string;
  overdraft_limit: string;
  is_active: boolean;
  created_at: string;
}

export interface LedgerEntry {
  id: string;
  transaction_id: string;
  entry_type: 'DEBIT' | 'CREDIT';
  amount: string;
  running_balance: string;
  description: string;
  created_at: string;
  initiated_by_name: string;
  transaction_type: string;
  from_account_id: string | null;
  to_account_id: string | null;
}

export interface StatementResponse {
  entries: LedgerEntry[];
  refused_attempts: RefusedAttempt[];
  pagination: { page: number; limit: number; total: number; pages: number };
}

export interface RefusedAttempt {
  id: string;
  operation: string;
  amount: string;
  reason: string;
  balance_at_attempt: string | null;
  created_at: string;
  attempted_by_name: string;
}

export const accountsApi = {
  list: () => api.get<Account[]>('/accounts').then((r) => r.data),

  directory: () => api.get('/accounts/directory').then((r) => r.data as DirectoryAccount[]),
  
  get: (id: string) => api.get<Account>(`/accounts/${id}`).then((r) => r.data),
  
  create: (data: { name: string; currency?: string; overdraft_limit?: number }) =>
    api.post<Account>('/accounts', data).then((r) => r.data),

  statement: (id: string, params?: { page?: number; limit?: number }) =>
    api.get<StatementResponse>(`/accounts/${id}/statement`, { params }).then((r) => r.data),
};

// The caller owns the Idempotency-Key: one key per user INTENT. A retry or double-click
// of the same form re-sends the same key (so the server dedupes); a new intent gets a new key.
export const newIdempotencyKey = () => uuidv4();

export interface DirectoryAccount {
  id: string;
  name: string;
  currency: string;
  owner_name: string;
}

export const transactionsApi = {
  deposit: (data: { account_id: string; amount: number; description: string }, key: string) =>
    api.post('/transactions/deposit', data, { headers: { 'Idempotency-Key': key } }).then((r) => r.data),

  withdrawal: (data: { account_id: string; amount: number; description: string }, key: string) =>
    api.post('/transactions/withdrawal', data, { headers: { 'Idempotency-Key': key } }).then((r) => r.data),

  transfer: (data: { from_account_id: string; to_account_id: string; amount: number; description: string }, key: string) =>
    api.post('/transactions/transfer', data, { headers: { 'Idempotency-Key': key } }).then((r) => r.data),

  list: (params?: { page?: number; limit?: number; type?: string }) =>
    api.get('/transactions', { params }).then((r) => r.data),

  get: (id: string) => api.get(`/transactions/${id}`).then((r) => r.data),
};

export const adminApi = {
  users: () => api.get('/admin/users').then((r) => r.data),
  conservation: () => api.get('/admin/conservation').then((r) => r.data),
  auditLog: (params?: { page?: number }) => api.get('/admin/audit-log', { params }).then((r) => r.data),
  refusedAttempts: () => api.get('/admin/refused-attempts').then((r) => r.data),
  updateUser: (id: string, data: { is_active: boolean }) => api.patch(`/admin/users/${id}`, data).then((r) => r.data),
};

export const auditorApi = {
  ledger: (params?: { page?: number; account_id?: string }) =>
    api.get('/auditor/ledger', { params }).then((r) => r.data),
  conservation: () => api.get('/auditor/conservation').then((r) => r.data),
  allAccounts: () => api.get('/auditor/all-accounts').then((r) => r.data),
  refusedAttempts: () => api.get('/auditor/refused-attempts').then((r) => r.data),
  idempotencyKeys: () => api.get('/auditor/idempotency-keys').then((r) => r.data),
};
