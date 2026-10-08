// Pure ledger helpers. All arithmetic is done in integer minor units (paise)
// so sums never drift the way floating point does (0.1 + 0.2 !== 0.3).
import crypto from 'node:crypto';

export const TXN_TYPES = new Set(['deposit', 'withdraw', 'transfer', 'expense', 'income']);
export const TXN_STATUSES = new Set(['completed', 'pending', 'declined']);

export const toMinor = (value) => Math.round(Number(value || 0) * 100);
export const fromMinor = (minor) => minor / 100;
export const sumMinor = (txns) => txns.reduce((total, t) => total + toMinor(t.amount), 0);

export function normalizeType(raw, fallbackAmount = 0) {
  const t = String(raw || '').trim().toLowerCase();
  if (TXN_TYPES.has(t)) return t;
  return Number(fallbackAmount) < 0 ? 'withdraw' : 'deposit';
}

export function normalizeStatus(raw) {
  const s = String(raw || '').trim().toLowerCase();
  return TXN_STATUSES.has(s) ? s : 'completed';
}

// Money going out is always negative, money coming in is always positive.
export function normalizeAmount(raw, type) {
  const n = Number(raw || 0);
  if (!Number.isFinite(n)) return 0;
  const minor = Math.abs(toMinor(n));
  if (type === 'withdraw' || type === 'expense') return fromMinor(-minor);
  if (type === 'deposit' || type === 'income') return fromMinor(minor);
  return fromMinor(toMinor(n));
}

export function normalizeDate(raw, fallbackIso) {
  const d = String(raw || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(d)) return d;
  return String(fallbackIso || new Date().toISOString()).slice(0, 10);
}

export function makeTxn(fields) {
  const createdAt = fields.created_at || new Date().toISOString();
  const type = normalizeType(fields.txn_type, fields.amount);
  return {
    id: fields.id || crypto.randomUUID(),
    owner: String(fields.owner || 'admin'),
    date: normalizeDate(fields.date, createdAt),
    amount: normalizeAmount(fields.amount, type),
    txn_type: type,
    category: String(fields.category || 'Misc').trim() || 'Misc',
    description: String(fields.description || '').trim() || 'Transaction',
    reference: String(fields.reference || '').trim(),
    created_by: String(fields.created_by || 'system'),
    created_at: createdAt,
    status: normalizeStatus(fields.status),
  };
}

export function normalizeBank(raw) {
  const rows = Array.isArray(raw?.transactions) ? raw.transactions : [];
  const seen = new Set();
  const transactions = [];
  for (const row of rows) {
    const txn = makeTxn(row);
    if (seen.has(txn.id)) continue;
    seen.add(txn.id);
    transactions.push(txn);
  }
  transactions.sort((a, b) => `${a.date} ${a.created_at}`.localeCompare(`${b.date} ${b.created_at}`));
  return { version: 3, transactions, approval_history: raw?.approval_history || [] };
}

export const newestFirst = (a, b) => `${b.date} ${b.created_at}`.localeCompare(`${a.date} ${a.created_at}`);

// Balance and totals for a list of transactions. Only completed ones count.
export function summarize(txns, now = new Date()) {
  const completed = txns.filter((t) => t.status === 'completed');
  const pending = txns.filter((t) => t.status === 'pending');
  const monthPrefix = now.toISOString().slice(0, 7);

  const inMinor = completed.filter((t) => t.amount > 0).reduce((s, t) => s + toMinor(t.amount), 0);
  const outMinor = completed.filter((t) => t.amount < 0).reduce((s, t) => s + toMinor(t.amount), 0);
  const monthMinor = completed.filter((t) => t.date.startsWith(monthPrefix)).reduce((s, t) => s + toMinor(t.amount), 0);

  return {
    balance: fromMinor(sumMinor(completed)),
    total_in: fromMinor(inMinor),
    total_out: fromMinor(Math.abs(outMinor)),
    this_month_net: fromMinor(monthMinor),
    pending_count: pending.length,
  };
}
