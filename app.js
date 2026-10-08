import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import session from 'express-session';
import nunjucks from 'nunjucks';
import bcrypt from 'bcryptjs';
import { stringify } from 'csv-stringify/sync';
import { createStore } from './lib/store.js';
import { createLimiter } from './lib/ratelimit.js';
import {
  makeTxn,
  normalizeBank,
  normalizeType,
  normalizeAmount,
  normalizeDate,
  normalizeStatus,
  newestFirst,
  summarize,
  toMinor,
} from './lib/ledger.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const BANK = 'bank.json';
const USERS = 'users.json';
const KEYS = 'keys.json';
const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
const hashKey = (key) => crypto.createHash('sha256').update(key).digest('hex');

export function createApp({ dataDir = path.join(ROOT, 'data'), sessionSecret, trustProxy = false, secureCookies = false } = {}) {
  const store = createStore(dataDir);
  const app = express();
  if (trustProxy) app.set('trust proxy', 1);

  const loginLimiter = createLimiter({ max: 10, windowMs: 15 * 60 * 1000 });
  const apiLimiter = createLimiter({ max: 120, windowMs: 60 * 1000 });

  const loadBank = async () => normalizeBank(await store.load(BANK));
  const saveBank = (bank) => store.save(BANK, normalizeBank(bank));

  // ---------- middleware ----------
  app.use(express.static(path.join(ROOT, 'public')));
  app.use(express.urlencoded({ extended: false }));

  app.use(
    session({
      secret: sessionSecret || crypto.randomBytes(32).toString('hex'),
      resave: false,
      saveUninitialized: false,
      cookie: { httpOnly: true, sameSite: 'lax', secure: secureCookies, maxAge: 7 * 24 * 60 * 60 * 1000 },
    })
  );

  // Reject cross-site form posts. Browsers always send Origin on a cross-site POST,
  // and SameSite=Lax cookies cover the rest. The API uses bearer keys, not cookies.
  app.use((req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS' || req.path.startsWith('/api/v1')) return next();
    const origin = req.get('origin') || req.get('referer');
    if (origin) {
      let host = '';
      try {
        host = new URL(origin).host;
      } catch {
        /* fall through and reject */
      }
      if (host !== req.get('host')) return res.status(403).send('Cross-site request blocked.');
    }
    next();
  });

  const env = nunjucks.configure(path.join(ROOT, 'templates'), { autoescape: true, express: app });
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
    res.locals.session = { get: (k, d) => (req.session?.[k] === undefined ? d : req.session[k]) };
    next();
  });

  const loginRequired = (req, res, next) => (req.session.logged_in ? next() : res.redirect('/login'));
  const adminRequired = (req, res, next) => {
    if (req.session.role !== 'admin') {
      flash(req, 'error', 'Admin access required.');
      return res.redirect('/bank');
    }
    next();
  };

  // ---------- auth ----------
  app.get('/login', (req, res) => {
    if (req.session.logged_in) return res.redirect('/bank');
    res.render('login.html');
  });

  app.post('/login', async (req, res) => {
    const ip = req.ip || 'unknown';
    if (loginLimiter.blocked(ip)) {
      flash(req, 'error', 'Too many failed attempts. Try again in a few minutes.');
      return res.status(429).redirect('/login');
    }

    const username = String(req.body.username || '').trim();
    const password = String(req.body.password || '');
    const users = await store.load(USERS);
    const user = has(users, username) ? users[username] : null;

    if (user && user.password && (await bcrypt.compare(password, user.password))) {
      loginLimiter.reset(ip);
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

    loginLimiter.fail(ip);
    flash(req, 'error', 'Invalid username or password.');
    res.redirect('/login');
  });

  app.get('/logout', (req, res) => req.session.destroy(() => res.redirect('/login')));
  app.get('/', (req, res) => res.redirect(req.session.logged_in ? '/bank' : '/login'));

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
    const users = await store.load(USERS);
    if (has(users, req.session.username)) {
      users[req.session.username].display_name = displayName;
      users[req.session.username].pfp = pfp;
      await store.save(USERS, users);
      req.session.display_name = displayName;
      req.session.pfp = pfp;
      flash(req, 'success', 'Profile updated.');
    }
    res.redirect('/bank');
  });

  // ---------- dashboard (each user sees their own account) ----------
  app.get('/bank', loginRequired, async (req, res) => {
    const me = req.session.username;
    const bank = await loadBank();
    const isAdmin = req.session.role === 'admin';
    const mine = bank.transactions.filter((t) => t.owner === me);
    const stats = summarize(mine);

    const view = {
      bank: { balance: stats.balance, transactions: mine },
      recent_transactions: mine.slice().sort(newestFirst),
      stats,
      pending_transactions: [],
      all_transactions: [],
      users: [],
    };
    if (isAdmin) {
      view.pending_transactions = bank.transactions.filter((t) => t.status === 'pending').sort(newestFirst);
      view.all_transactions = bank.transactions;
      view.users = Object.keys(await store.load(USERS));
    }
    res.render('bank.html', view);
  });

  // Any signed-in user can submit a transaction on their own account; it stays pending until an admin approves it.
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
        owner: req.session.username,
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
    const users = await store.load(USERS);
    const owner = String(req.body.owner || req.session.username);
    const type = normalizeType(req.body.txn_type, req.body.amount);
    const amount = normalizeAmount(req.body.amount, type);
    const description = String(req.body.description || '').trim();
    if (!has(users, owner)) {
      flash(req, 'error', 'Unknown account.');
      return res.redirect('/bank');
    }
    if (!description || amount === 0) {
      flash(req, 'error', 'Amount and description are required.');
      return res.redirect('/bank');
    }
    const bank = await loadBank();
    bank.transactions.push(
      makeTxn({
        owner,
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
    res.render('admin.html', { users: await store.load(USERS) });
  });

  app.post('/admin', loginRequired, adminRequired, async (req, res) => {
    const users = await store.load(USERS);
    const action = String(req.body.action || '');
    const target = String(req.body.target_user || '').trim();

    if (action === 'add_user') {
      const username = String(req.body.new_username || '').trim();
      const password = String(req.body.new_password || '');
      const displayName = String(req.body.new_display_name || '').trim().slice(0, 32);
      if (!/^[A-Za-z0-9_.-]{3,32}$/.test(username)) {
        flash(req, 'error', 'Username must be 3-32 characters: letters, numbers, _ . -');
      } else if (has(users, username)) {
        flash(req, 'error', `User '${username}' already exists.`);
      } else if (password.length < 8) {
        flash(req, 'error', 'Password must be at least 8 characters.');
      } else {
        users[username] = { password: await bcrypt.hash(password, 12), role: 'user', display_name: displayName || username };
        await store.save(USERS, users);
        flash(req, 'success', `User '${username}' created.`);
      }
      return res.redirect('/admin');
    }

    if (!target || !has(users, target)) return res.redirect('/admin');

    if (action === 'edit_user') {
      const password = String(req.body.edit_password || '');
      if (password.length < 8) {
        flash(req, 'error', 'Password must be at least 8 characters.');
      } else {
        users[target].password = await bcrypt.hash(password, 12);
        await store.save(USERS, users);
        flash(req, 'success', `Password updated for '${target}'.`);
      }
    } else if (action === 'promote_user') {
      users[target].role = 'admin';
      await store.save(USERS, users);
      flash(req, 'success', `'${target}' promoted to admin.`);
    } else if (action === 'demote_user' || action === 'delete_user') {
      if (target === req.session.username) {
        flash(req, 'error', 'You cannot do that to your own account.');
      } else if (action === 'demote_user') {
        users[target].role = 'user';
        await store.save(USERS, users);
        flash(req, 'success', `'${target}' demoted to user.`);
      } else {
        delete users[target];
        await store.save(USERS, users);
        const keys = await store.load(KEYS);
        for (const id of Object.keys(keys)) if (keys[id].user === target) delete keys[id];
        await store.save(KEYS, keys);
        flash(req, 'success', `User '${target}' removed.`);
      }
    }
    res.redirect('/admin');
  });

  app.get('/export/csv', loginRequired, adminRequired, async (req, res) => {
    const bank = await loadBank();
    const rows = bank.transactions.slice().sort(newestFirst).map((t) => [
      t.date, t.owner, t.txn_type, t.category, t.description, t.reference, t.amount, t.status, t.created_by,
    ]);
    const csv = stringify([['date', 'account', 'type', 'category', 'description', 'reference', 'amount', 'status', 'created_by'], ...rows]);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="transactions.csv"');
    res.send(csv);
  });

  // ---------- API keys (each user manages their own) ----------
  app.get('/keys', loginRequired, async (req, res) => {
    const keys = await store.load(KEYS);
    const mine = Object.values(keys)
      .filter((k) => k.user === req.session.username)
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
    const newKey = req.session.new_key || null;
    req.session.new_key = null;
    res.render('keys.html', { keys: mine, new_key: newKey, base_url: `${req.protocol}://${req.get('host')}` });
  });

  app.post('/keys/create', loginRequired, async (req, res) => {
    const label = String(req.body.label || '').trim().slice(0, 40) || 'Untitled key';
    const scope = req.body.scope === 'write' ? 'write' : 'read';
    const secret = `pk_${crypto.randomBytes(24).toString('base64url')}`;
    const keys = await store.load(KEYS);
    const id = crypto.randomUUID();
    keys[id] = {
      id,
      user: req.session.username,
      label,
      scope,
      prefix: secret.slice(0, 9),
      hash: hashKey(secret),
      created_at: new Date().toISOString(),
      last_used: null,
    };
    await store.save(KEYS, keys);
    req.session.new_key = secret; // shown once, never stored in plain text
    res.redirect('/keys');
  });

  app.post('/keys/revoke', loginRequired, async (req, res) => {
    const keys = await store.load(KEYS);
    const id = String(req.body.key_id || '');
    if (has(keys, id) && keys[id].user === req.session.username) {
      delete keys[id];
      await store.save(KEYS, keys);
      flash(req, 'success', 'Key revoked.');
    }
    res.redirect('/keys');
  });

  // ---------- public JSON API ----------
  const api = express.Router();
  api.use(express.json({ limit: '10kb' }));
  api.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });

  api.use(async (req, res, next) => {
    const header = req.get('authorization') || '';
    const match = /^Bearer\s+(\S+)$/i.exec(header);
    if (!match) return res.status(401).json({ error: 'Missing API key. Send "Authorization: Bearer <key>".' });

    const keys = await store.load(KEYS);
    const record = Object.values(keys).find((k) => k.hash === hashKey(match[1]));
    if (!record) return res.status(401).json({ error: 'Invalid API key.' });

    const users = await store.load(USERS);
    if (!has(users, record.user)) return res.status(401).json({ error: 'Invalid API key.' });
    if (!apiLimiter.take(record.id)) return res.status(429).json({ error: 'Rate limit exceeded. Try again in a minute.' });

    // Record usage at most once a minute so reads do not turn into disk writes.
    if (!record.last_used || Date.now() - Date.parse(record.last_used) > 60 * 1000) {
      record.last_used = new Date().toISOString();
      keys[record.id] = record;
      await store.save(KEYS, keys);
    }

    req.apiKey = record;
    next();
  });

  const publicTxn = (t) => ({
    id: t.id, date: t.date, amount: t.amount, type: t.txn_type,
    category: t.category, description: t.description, reference: t.reference, status: t.status,
  });

  api.get('/balance', async (req, res) => {
    const bank = await loadBank();
    const stats = summarize(bank.transactions.filter((t) => t.owner === req.apiKey.user));
    res.json({
      account: req.apiKey.user,
      currency: 'INR',
      balance: stats.balance,
      total_in: stats.total_in,
      total_out: stats.total_out,
      pending_count: stats.pending_count,
    });
  });

  api.get('/transactions', async (req, res) => {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
    const status = req.query.status ? String(req.query.status) : '';
    const bank = await loadBank();
    const rows = bank.transactions
      .filter((t) => t.owner === req.apiKey.user && (!status || t.status === status))
      .sort(newestFirst)
      .slice(0, limit)
      .map(publicTxn);
    res.json({ account: req.apiKey.user, count: rows.length, transactions: rows });
  });

  // Creates a *pending* transaction, exactly like the dashboard form. An admin approves it.
  api.post('/transactions', async (req, res) => {
    if (req.apiKey.scope !== 'write') return res.status(403).json({ error: 'This key is read-only.' });
    const body = req.body || {};
    const type = String(body.type || '').toLowerCase();
    if (!['deposit', 'withdraw'].includes(type)) return res.status(400).json({ error: 'type must be "deposit" or "withdraw".' });
    const amount = Number(body.amount);
    if (!Number.isFinite(amount) || toMinor(amount) <= 0) return res.status(400).json({ error: 'amount must be a positive number.' });
    const description = String(body.description || '').trim();
    if (!description) return res.status(400).json({ error: 'description is required.' });

    const bank = await loadBank();
    const txn = makeTxn({
      owner: req.apiKey.user,
      amount,
      txn_type: type,
      category: body.category,
      description,
      reference: body.reference,
      created_by: `api:${req.apiKey.prefix}`,
      status: 'pending',
    });
    bank.transactions.push(txn);
    await saveBank(bank);
    res.status(201).json(publicTxn(txn));
  });

  api.use((req, res) => res.status(404).json({ error: 'Not found.' }));
  app.use('/api/v1', api);

  return app;
}
