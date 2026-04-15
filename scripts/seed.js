// Creates data/users.json and data/bank.json with demo data.
// Usage: npm run seed   (set ADMIN_PASSWORD to choose the admin password; defaults to "admin123")
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';

await fs.mkdir('data', { recursive: true });

const adminPassword = process.env.ADMIN_PASSWORD || 'admin123';
const users = {
  admin: {
    password: await bcrypt.hash(adminPassword, 12),
    role: 'admin',
    display_name: 'Admin',
  },
  demo: {
    password: await bcrypt.hash('demo123', 12),
    role: 'user',
    display_name: 'Demo User',
  },
};
await fs.writeFile('data/users.json', JSON.stringify(users, null, 2));

const rows = [
  ['2026-01-02', 50000, 'deposit', 'Salary', 'January salary'],
  ['2026-01-05', -12000, 'expense', 'Rent', 'Monthly rent'],
  ['2026-01-09', -2300, 'expense', 'Food', 'Groceries'],
  ['2026-01-15', -999, 'expense', 'Subscriptions', 'Cloud + music'],
  ['2026-02-02', 50000, 'deposit', 'Salary', 'February salary'],
  ['2026-02-05', -12000, 'expense', 'Rent', 'Monthly rent'],
  ['2026-02-11', 4500, 'income', 'Freelance', 'Website project'],
  ['2026-02-20', -3100, 'expense', 'Travel', 'Train tickets'],
  ['2026-03-02', 50000, 'deposit', 'Salary', 'March salary'],
  ['2026-03-05', -12000, 'expense', 'Rent', 'Monthly rent'],
  ['2026-03-18', -5400, 'expense', 'Gadgets', 'Headphones'],
];
const transactions = rows.map(([date, amount, txn_type, category, description]) => ({
  id: crypto.randomUUID(),
  date,
  amount,
  txn_type,
  category,
  description,
  reference: '',
  created_by: 'seed',
  created_at: `${date}T00:00:00.000Z`,
  status: 'completed',
}));
transactions.push({
  id: crypto.randomUUID(),
  date: '2026-03-25',
  amount: -1800,
  txn_type: 'expense',
  category: 'Food',
  description: 'Dinner (awaiting approval)',
  reference: '',
  created_by: 'demo',
  created_at: '2026-03-25T00:00:00.000Z',
  status: 'pending',
});
const balance = transactions.filter((t) => t.status === 'completed').reduce((s, t) => s + t.amount, 0);
await fs.writeFile(
  'data/bank.json',
  JSON.stringify({ version: 2, balance, transactions, approval_history: [] }, null, 2)
);

console.log('Seeded data/users.json and data/bank.json');
console.log(`Login: admin / ${adminPassword}   |   demo / demo123`);
