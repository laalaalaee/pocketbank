import test from 'node:test';
import assert from 'node:assert/strict';
import { toMinor, normalizeAmount, normalizeType, makeTxn, summarize } from '../lib/ledger.js';
import { createLimiter } from '../lib/ratelimit.js';

test('amounts convert to integer paise without float drift', () => {
  assert.equal(toMinor(0.1) + toMinor(0.2), toMinor(0.3));
  assert.equal(toMinor(1299.99), 129999);
  assert.equal(toMinor('450.50'), 45050);
});

test('money going out is negative, coming in is positive, regardless of input sign', () => {
  assert.equal(normalizeAmount(500, 'withdraw'), -500);
  assert.equal(normalizeAmount(-500, 'withdraw'), -500);
  assert.equal(normalizeAmount(-500, 'deposit'), 500);
  assert.equal(normalizeAmount(12.345, 'expense'), -12.35);
  assert.equal(normalizeAmount('abc', 'deposit'), 0);
});

test('unknown transaction types fall back to the sign of the amount', () => {
  assert.equal(normalizeType('nonsense', -5), 'withdraw');
  assert.equal(normalizeType('', 5), 'deposit');
});

test('balance only counts completed transactions', () => {
  const txns = [
    makeTxn({ amount: 1000, txn_type: 'deposit', date: '2026-01-01', status: 'completed' }),
    makeTxn({ amount: 250.1, txn_type: 'withdraw', date: '2026-01-02', status: 'completed' }),
    makeTxn({ amount: 999, txn_type: 'withdraw', date: '2026-01-03', status: 'pending' }),
    makeTxn({ amount: 500, txn_type: 'deposit', date: '2026-01-04', status: 'declined' }),
  ];
  const s = summarize(txns, new Date('2026-01-20'));
  assert.equal(s.balance, 749.9);
  assert.equal(s.total_in, 1000);
  assert.equal(s.total_out, 250.1);
  assert.equal(s.pending_count, 1);
  assert.equal(s.this_month_net, 749.9);
});

test('many small transactions sum exactly', () => {
  const txns = Array.from({ length: 1000 }, () => makeTxn({ amount: 0.1, txn_type: 'deposit', status: 'completed' }));
  assert.equal(summarize(txns).balance, 100);
});

test('rate limiter blocks after max failures and recovers after the window', () => {
  const limiter = createLimiter({ max: 3, windowMs: 1000 });
  for (let i = 0; i < 3; i++) limiter.fail('ip', 0);
  assert.equal(limiter.blocked('ip', 500), true);
  assert.equal(limiter.blocked('ip', 1500), false);
  limiter.fail('ip', 2000);
  limiter.reset('ip');
  assert.equal(limiter.blocked('ip', 2001), false);
});
