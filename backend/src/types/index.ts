export type Role = 'admin' | 'account_holder' | 'auditor';

export interface User {
  id: string;
  email: string;
  name: string;
  role: Role;
  created_at: Date;
}

export interface Account {
  id: string;
  owner_id: string;
  name: string;
  balance: string; // stored as numeric string to avoid float issues
  currency: string;
  overdraft_limit: string;
  is_active: boolean;
  created_at: Date;
}

export interface LedgerEntry {
  id: string;
  transaction_id: string;
  account_id: string;
  entry_type: 'DEBIT' | 'CREDIT';
  amount: string;
  running_balance: string;
  description: string;
  initiated_by: string;
  created_at: Date;
  metadata: Record<string, unknown>;
}

export interface Transaction {
  id: string;
  idempotency_key: string | null;
  type: 'DEPOSIT' | 'WITHDRAWAL' | 'TRANSFER' | 'ADJUSTMENT';
  status: 'PENDING' | 'COMPLETED' | 'FAILED' | 'REVERSED';
  from_account_id: string | null;
  to_account_id: string | null;
  amount: string;
  description: string;
  initiated_by: string;
  created_at: Date;
  completed_at: Date | null;
  metadata: Record<string, unknown>;
}

export interface IdempotencyRecord {
  key: string;
  status: 'PENDING' | 'COMPLETE' | 'FAILED';
  response_status: number | null;
  response_body: Record<string, unknown> | null;
  created_at: Date;
  completed_at: Date | null;
}

export interface JwtPayload {
  sub: string; // user id
  email: string;
  role: Role;
  iat: number;
  exp: number;
}

export interface ApiError {
  error: string;
  message: string;
  statusCode: number;
}
