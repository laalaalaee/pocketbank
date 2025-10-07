import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import express from 'express';
import session from 'express-session';
import nunjucks from 'nunjucks';
import dotenv from 'dotenv';
import bcrypt from 'bcryptjs';
import { stringify } from 'csv-stringify/sync';

dotenv.config();

const PORT = Number(process.env.PORT || 3000);
const FILES = { BANK: 'data/bank.json', USERS: 'data/users.json' };
const TXN_TYPES = new Set(['deposit', 'withdraw', 'transfer', 'expense', 'income']);
const TXN_STATUSES = new Set(['completed', 'pending', 'declined']);

// ---------- storage (serialised JSON files) ----------
let queue = Promise.resolve();
function enqueue(task) {
  const run = queue.then(task, task);
  queue = run.catch(() => {});
  return run;
}

const loadDb = (file) =>
  enqueue(async () => {
    try {
      return JSON.parse(await fs.readFile(file, 'utf8'));
    } catch {
      return {};
    }
  });

const saveDb = (file, data) =>
  enqueue(async () => {
    await fs.mkdir('data', { recursive: true });
    await fs.writeFile(file, JSON.stringify(data, null, 2), 'utf8');
  });

// ---------- transaction helpers ----------
function normalizeType(raw, fallbackAmount = 0) {
  const t = String(raw || '').trim().toLowerCase();
  if (TXN_TYPES.has(t)) return t;
  return Number(fallbackAmount) < 0 ? 'withdraw' : 'deposit';
}

function normalizeStatus(raw) {
  const s = String(raw || '').trim().toLowerCase();
  return TXN_STATUSES.has(s) ? s : 'completed';
}

function normalizeAmount(raw, type) {
  const n = Number(raw || 0);
  if (!Number.isFinite(n)) return 0;
  const abs = Math.abs(n);
  if (type === 'withdraw' || type === 'expense') return -abs;
  if (type === 'deposit' || type === 'income') return abs;
  return n;
}

function normalizeDate(raw, fallbackIso) {
  const d = String(raw || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(d)) return d;
  return String(fallbackIso || new Date().toISOString()).slice(0, 10);
}

function makeTxn(fields) {
  const createdAt = fields.created_at || new Date().toISOString();
  const type = normalizeType(fields.txn_type, fields.amount);
  return {
    id: fields.id || crypto.randomUUID(),
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

function normalizeBank(raw) {
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
  const balance = transactions.filter((t) => t.status === 'completed').reduce((s, t) => s + t.amount, 0);
  return { version: 2, balance, transactions, approval_history: raw?.approval_history || [] };
}

const loadBank = async () => normalizeBank(await loadDb(FILES.BANK));
const saveBank = (bank) => saveDb(FILES.BANK, normalizeBank(bank));

const newestFirst = (a, b) => `${b.date} ${b.created_at}`.localeCompare(`${a.date} ${a.created_at}`);

// ---------- app + templates ----------
const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.static('public'));

let sessionSecret = process.env.SESSION_SECRET;
if (!sessionSecret || sessionSecret === 'change-me') {
  sessionSecret = crypto.randomBytes(32).toString('hex');
  console.log('[WARN] SESSION_SECRET not set - sessions reset on restart. Set it in .env');
}

app.use(
  session({
    secret: sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: 'lax', maxAge: 7 * 24 * 60 * 60 * 1000 },
  })
);

const env = nunjucks.configure('templates', { autoescape: true, express: app });
env.addFilter('money', (v) =>
  new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(v || 0))
);
env.addFilter('string', (v) => String(v));
env.addFilter('date_human', (v) => {
  const raw = String(v || '').trim();
  if (!raw) return '';
  const d = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? new Date(`${raw}T00:00:00`) : new Date(raw);
  if (Number.isNaN(d.getTime())) return raw;
  return new Intl.DateTimeFormat('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }).format(d);
});
env.addFilter('datetime_human', (v) => {
  const d = new Date(String(v || ''));
  if (Number.isNaN(d.getTime())) return String(v || '');
  return new Intl.DateTimeFormat('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  }).format(d);
});

function flash(req, category, message) {
  req.session.flashes = req.session.flashes || [];
  req.session.flashes.push([category, message]);
}

app.use((req, res, next) => {
  const flashes = req.session.flashes || [];
  req.session.flashes = [];
  res.locals.flashes = flashes;
  res.locals.request = { path: req.path };
  res.locals.session = {
    get: (k, d) => (req.session?.[k] === undefined ? d : req.session[k]),
  };
  next();
});

const loginRequired = (req, res, next) => (req.session.logged_in ? next() : res.redirect('/login'));

function adminRequired(req, res, next) {
  if (req.session.role !== 'admin') {
    flash(req, 'error', 'Admin access required.');
    return res.redirect('/bank');
  }
  next();
}

// ---------- auth ----------
app.get('/login', (req, res) => {
  if (req.session.logged_in) return res.redirect('/bank');
  res.render('login.html');
});

app.post('/login', async (req, res) => {
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  const users = await loadDb(FILES.USERS);
  const user = Object.prototype.hasOwnProperty.call(users, username) ? users[username] : null;

  if (user && user.password && (await bcrypt.compare(password, user.password))) {
    return req.session.regenerate((err) => {
      if (err) return res.redirect('/login');
      req.session.logged_in = true;
      req.session.username = username;
      req.session.role = user.role || 'user';
      req.session.display_name = user.display_name || username;
      req.session.pfp = user.pfp || '';
      res.redirect('/bank');
    });
  }

  flash(req, 'error', 'Invalid username or password.');
  res.redirect('/login');
});

app.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

app.post('/api/profile/edit', loginRequired, async (req, res) => {
  const displayName = String(req.body.display_name || '').trim();
  const pfp = String(req.body.pfp || '').trim();
  if (!displayName || displayName.length > 32) {
    flash(req, 'error', 'Display name is required and must be 32 characters or fewer.');
    return res.redirect('/bank');
  }
  if (pfp && !/^https?:\/\//i.test(pfp)) {
    flash(req, 'error', 'Avatar must be an http(s) image URL.');
    return res.redirect('/bank');
  }
  const users = await loadDb(FILES.USERS);
  if (users[req.session.username]) {
    users[req.session.username].display_name = displayName;
    users[req.session.username].pfp = pfp;
    await saveDb(FILES.USERS, users);
    req.session.display_name = displayName;
    req.session.pfp = pfp;
    flash(req, 'success', 'Profile updated.');
  }
  res.redirect('/bank');
});

app.get('/', (req, res) => res.redirect(req.session.logged_in ? '/bank' : '/login'));

// ---------- bank ----------
app.get('/bank', loginRequired, async (req, res) => {
  const bank = await loadBank();
  const txns = bank.transactions;
  const completed = txns.filter((t) => t.status === 'completed');
  const pending = txns.filter((t) => t.status === 'pending');

  const totalIn = completed.filter((t) => t.amount > 0).reduce((s, t) => s + t.amount, 0);
  const totalOut = Math.abs(completed.filter((t) => t.amount < 0).reduce((s, t) => s + t.amount, 0));
  const monthPrefix = new Date().toISOString().slice(0, 7);
  const thisMonthNet = completed.filter((t) => t.date.startsWith(monthPrefix)).reduce((s, t) => s + t.amount, 0);

  res.render('bank.html', {
    bank,
    recent_transactions: txns.slice().sort(newestFirst),
    completed_transactions: completed.slice().sort(newestFirst),
    pending_transactions: pending.slice().sort(newestFirst),
    stats: { total_in: totalIn, total_out: totalOut, pending_count: pending.length, this_month_net: thisMonthNet },
  });
});

// Any signed-in user can submit a transaction; it stays pending until an admin approves it.
app.post('/api/bank/action', loginRequired, async (req, res) => {
  const type = String(req.body.action_type || req.body.txn_type || '').toLowerCase() === 'withdraw' ? 'withdraw' : 'deposit';
  const amount = normalizeAmount(req.body.amount, type);
  const description = String(req.body.description || req.body.note || '').trim();
  if (amount === 0 || !description) {
    flash(req, 'error', 'Amount and description are required.');
    return res.redirect('/bank');
  }

  const bank = await loadBank();
  bank.transactions.push(
    makeTxn({
      amount,
      txn_type: type,
      category: req.body.category,
      description,
      reference: req.body.reference,
      created_by: req.session.username,
      status: 'pending',
    })
  );
  await saveBank(bank);
  flash(req, 'success', 'Transaction submitted for approval.');
  res.redirect('/bank');
});

app.post('/api/bank/pending_action', loginRequired, adminRequired, async (req, res) => {
  const id = String(req.body.txn_id || '').trim();
  const decision = String(req.body.decision || '').toLowerCase();
  if (!id || !['approve', 'decline'].includes(decision)) {
    flash(req, 'error', 'Invalid pending transaction action.');
    return res.redirect('/bank');
  }

  const bank = await loadBank();
  const txn = bank.transactions.find((t) => t.id === id);
  if (!txn || txn.status !== 'pending') {
    flash(req, 'error', 'Pending transaction not found.');
    return res.redirect('/bank');
  }

  txn.status = decision === 'approve' ? 'completed' : 'declined';
  bank.approval_history.push({ txn_id: id, decision, by: req.session.username, at: new Date().toISOString() });
  await saveBank(bank);
  flash(req, 'success', decision === 'approve' ? 'Transaction approved.' : 'Transaction declined.');
  res.redirect('/bank');
});

app.post('/api/bank/admin/add_txn', loginRequired, adminRequired, async (req, res) => {
  const type = normalizeType(req.body.txn_type, req.body.amount);
  const amount = normalizeAmount(req.body.amount, type);
  const description = String(req.body.description || '').trim();
  if (!description || amount === 0) {
    flash(req, 'error', 'Amount and description are required.');
    return res.redirect('/bank');
  }

  const bank = await loadBank();
  bank.transactions.push(
    makeTxn({
      date: req.body.date,
      amount,
      txn_type: type,
      category: req.body.category,
      description,
      reference: req.body.reference,
      created_by: req.session.username,
      status: 'completed',
    })
  );
  await saveBank(bank);
  flash(req, 'success', 'Transaction added.');
  res.redirect('/bank');
});

app.post('/api/bank/admin/edit_txn', loginRequired, adminRequired, async (req, res) => {
  const bank = await loadBank();
  const txn = bank.transactions.find((t) => t.id === String(req.body.txn_id || '').trim());
  if (!txn) {
    flash(req, 'error', 'Transaction not found.');
    return res.redirect('/bank');
  }

  const amount = normalizeAmount(req.body.amount, txn.txn_type);
  const description = String(req.body.description || txn.description).trim();
  if (!description || amount === 0) {
    flash(req, 'error', 'Amount and description are required.');
    return res.redirect('/bank');
  }

  txn.date = normalizeDate(req.body.date, txn.created_at);
  txn.amount = amount;
  txn.category = String(req.body.category || txn.category).trim() || 'Misc';
  txn.description = description;
  txn.reference = String(req.body.reference || '').trim();
  txn.status = normalizeStatus(req.body.status || txn.status);
  await saveBank(bank);
  flash(req, 'success', 'Transaction updated.');
  res.redirect('/bank');
});

app.post('/api/bank/admin/delete_txn', loginRequired, adminRequired, async (req, res) => {
  const id = String(req.body.txn_id || '').trim();
  const bank = await loadBank();
  const before = bank.transactions.length;
  bank.transactions = bank.transactions.filter((t) => t.id !== id);
  if (bank.transactions.length === before) {
    flash(req, 'error', 'Transaction not found.');
    return res.redirect('/bank');
  }
  await saveBank(bank);
  flash(req, 'success', 'Transaction deleted.');
  res.redirect('/bank');
});

// ---------- user management (admin) ----------
app.get('/admin', loginRequired, adminRequired, async (req, res) => {
  res.render('admin.html', { users: await loadDb(FILES.USERS) });
});

app.post('/admin', loginRequired, adminRequired, async (req, res) => {
  const users = await loadDb(FILES.USERS);
  const action = String(req.body.action || '');
  const target = String(req.body.target_user || '').trim();
  const exists = (name) => Object.prototype.hasOwnProperty.call(users, name);

  if (action === 'add_user') {
    const username = String(req.body.new_username || '').trim();
    const password = String(req.body.new_password || '');
    const displayName = String(req.body.new_display_name || '').trim().slice(0, 32);
    if (!/^[A-Za-z0-9_.-]{3,32}$/.test(username)) {
      flash(req, 'error', 'Username must be 3-32 characters: letters, numbers, _ . -');
    } else if (exists(username)) {
      flash(req, 'error', `User '${username}' already exists.`);
    } else if (password.length < 8) {
      flash(req, 'error', 'Password must be at least 8 characters.');
    } else {
      users[username] = { password: await bcrypt.hash(password, 12), role: 'user', display_name: displayName || username };
      await saveDb(FILES.USERS, users);
      flash(req, 'success', `User '${username}' created.`);
    }
    return res.redirect('/admin');
  }

  if (!target || !exists(target)) return res.redirect('/admin');

  if (action === 'edit_user') {
    const password = String(req.body.edit_password || '');
    if (password.length < 8) {
      flash(req, 'error', 'Password must be at least 8 characters.');
    } else {
      users[target].password = await bcrypt.hash(password, 12);
      await saveDb(FILES.USERS, users);
      flash(req, 'success', `Password updated for '${target}'.`);
    }
  } else if (action === 'promote_user') {
    users[target].role = 'admin';
    await saveDb(FILES.USERS, users);
    flash(req, 'success', `'${target}' promoted to admin.`);
  } else if (action === 'demote_user' || action === 'delete_user') {
    if (target === req.session.username) {
      flash(req, 'error', 'You cannot do that to your own account.');
    } else if (action === 'demote_user') {
      users[target].role = 'user';
      await saveDb(FILES.USERS, users);
      flash(req, 'success', `'${target}' demoted to user.`);
    } else {
      delete users[target];
      await saveDb(FILES.USERS, users);
      flash(req, 'success', `User '${target}' removed.`);
    }
  }
  res.redirect('/admin');
});

app.get('/export/csv', loginRequired, adminRequired, async (req, res) => {
  const bank = await loadBank();
  const rows = bank.transactions.slice().sort(newestFirst).map((t) => [
    t.date, t.txn_type, t.category, t.description, t.reference, t.amount, t.status, t.created_by,
  ]);
  const csv = stringify([['date', 'type', 'category', 'description', 'reference', 'amount', 'status', 'created_by'], ...rows]);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="transactions.csv"');
  res.send(csv);
});

app.listen(PORT, () => console.log(`PocketBank running at http://localhost:${PORT}`));
