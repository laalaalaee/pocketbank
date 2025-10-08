// Creates demo users and transactions in data/ (or $DATA_DIR).
// Usage: npm run seed          (set ADMIN_PASSWORD to choose the admin password)
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';

const dir = process.env.DATA_DIR || path.join(process.cwd(), 'data');
await fs.mkdir(dir, { recursive: true });

const adminPassword = process.env.ADMIN_PASSWORD || 'admin123';
const users = {
  admin: { password: await bcrypt.hash(adminPassword, 12), role: 'admin', display_name: 'Admin' },
  demo: { password: await bcrypt.hash('demo123', 12), role: 'user', display_name: 'Demo User' },
};
await fs.writeFile(path.join(dir, 'users.json'), JSON.stringify(users, null, 2));

// Dates are relative to today so the demo always looks current.
// [owner, monthsAgo, day, amount, type, category, description, status]
const now = new Date();
const dateOf = (monthsAgo, day) => {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - monthsAgo, day));
  return d.toISOString().slice(0, 10);
};
const today = now.getUTCDate();
const rows = [
  ['admin', 3, 2, 50000, 'deposit', 'Salary', 'Salary', 'completed'],
  ['admin', 3, 5, -12000, 'expense', 'Rent', 'Monthly rent', 'completed'],
  ['admin', 3, 9, -2300, 'expense', 'Food', 'Groceries', 'completed'],
  ['admin', 3, 15, -999, 'expense', 'Bills', 'Cloud + music', 'completed'],
  ['admin', 2, 2, 50000, 'deposit', 'Salary', 'Salary', 'completed'],
  ['admin', 2, 5, -12000, 'expense', 'Rent', 'Monthly rent', 'completed'],
  ['admin', 2, 11, 4500, 'income', 'Other', 'Freelance website project', 'completed'],
  ['admin', 2, 20, -3100, 'expense', 'Travel', 'Train tickets', 'completed'],
  ['admin', 1, 2, 50000, 'deposit', 'Salary', 'Salary', 'completed'],
  ['admin', 1, 5, -12000, 'expense', 'Rent', 'Monthly rent', 'completed'],
  ['admin', 1, 18, -5400, 'expense', 'Shopping', 'Headphones', 'completed'],
  ['admin', 0, 1, 50000, 'deposit', 'Salary', 'Salary', 'completed'],
  ['admin', 0, Math.min(today, 3), -1250, 'expense', 'Food', 'Weekend groceries', 'completed'],
  ['demo', 2, 1, 8000, 'deposit', 'Savings', 'Pocket money', 'completed'],
  ['demo', 1, 7, -450.5, 'expense', 'Food', 'Lunch with friends', 'completed'],
  ['demo', 1, 14, -1299, 'expense', 'Shopping', 'Book order', 'completed'],
  ['demo', 0, Math.min(today, 2), -1800, 'expense', 'Food', 'Dinner out', 'pending'],
].map(([owner, m, day, amount, type, category, description, status]) => [owner, dateOf(m, day), amount, type, category, description, status]);
const transactions = rows.map(([owner, date, amount, txn_type, category, description, status]) => ({
  id: crypto.randomUUID(),
  owner,
  date,
  amount,
  txn_type,
  category,
  description,
  reference: '',
  created_by: owner,
  created_at: `${date}T00:00:00.000Z`,
  status,
}));
await fs.writeFile(
  path.join(dir, 'bank.json'),
  JSON.stringify({ version: 3, transactions, approval_history: [] }, null, 2)
);

console.log(`Seeded ${path.join(dir, 'users.json')} and ${path.join(dir, 'bank.json')}`);
console.log(`Login: admin / ${adminPassword}   |   demo / demo123`);
