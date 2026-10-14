import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import { createApp } from '../app.js';

let server;
let base;
let dir;

// Minimal cookie-aware client so we can test real login sessions.
function client() {
  let cookie = '';
  return async (url, { method = 'GET', form, json, headers = {} } = {}) => {
    const h = { ...headers };
    if (cookie) h.cookie = cookie;
    let body;
    if (form) {
      h['content-type'] = 'application/x-www-form-urlencoded';
      body = new URLSearchParams(form).toString();
    }
    if (json) {
      h['content-type'] = 'application/json';
      body = JSON.stringify(json);
    }
    const res = await fetch(base + url, { method, headers: h, body, redirect: 'manual' });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return res;
  };
}

async function login(username, password) {
  const c = client();
  await c('/login', { method: 'POST', form: { username, password } });
  return c;
}

async function makeKey(c, scope) {
  await c('/keys/create', { method: 'POST', form: { label: 'test', scope } });
  const page = await (await c('/keys')).text();
  const match = /pk_[A-Za-z0-9_-]+/.exec(page);
  assert.ok(match, 'new key should be shown once on /keys');
  return match[0];
}

const bearer = (key) => ({ authorization: `Bearer ${key}` });

before(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pocketbank-'));
  const hash = (p) => bcrypt.hashSync(p, 4);
  await fs.writeFile(
    path.join(dir, 'users.json'),
    JSON.stringify({
      admin: { password: hash('adminpass1'), role: 'admin', display_name: 'Admin' },
      alice: { password: hash('alicepass1'), role: 'user', display_name: 'Alice' },
      bob: { password: hash('bobpass123'), role: 'user', display_name: 'Bob' },
    })
  );
  await fs.writeFile(
    path.join(dir, 'bank.json'),
    JSON.stringify({
      transactions: [
        { id: 'a1', owner: 'alice', date: '2026-01-01', amount: 1000, txn_type: 'deposit', description: 'seed', status: 'completed' },
        { id: 'b1', owner: 'bob', date: '2026-01-01', amount: 5000, txn_type: 'deposit', description: 'bob money', status: 'completed' },
      ],
    })
  );
  const app = createApp({ dataDir: dir, sessionSecret: 'test-secret', trustProxy: true });
  await new Promise((resolve) => {
    server = app.listen(0, resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.close();
  await fs.rm(dir, { recursive: true, force: true });
});

test('dashboard requires login', async () => {
  const res = await client()('/bank');
  assert.equal(res.status, 302);
  assert.match(res.headers.get('location'), /\/login/);
});

test('wrong password is rejected, right password reaches the dashboard', async () => {
  const bad = client();
  const r1 = await bad('/login', { method: 'POST', form: { username: 'alice', password: 'nope' } });
  assert.match(r1.headers.get('location'), /\/login/);
  assert.equal((await bad('/bank')).status, 302);

  const good = await login('alice', 'alicepass1');
  assert.equal((await good('/bank')).status, 200);
});

test('repeated failed logins are rate limited', async () => {
  const c = client();
  const headers = { 'x-forwarded-for': '203.0.113.9' }; // its own "IP" so other tests are unaffected
  for (let i = 0; i < 10; i++) await c('/login', { method: 'POST', headers, form: { username: 'ghost', password: 'x' } });
  // Even the right password is refused while blocked.
  await c('/login', { method: 'POST', headers, form: { username: 'bob', password: 'bobpass123' } });
  assert.equal((await c('/bank', { headers })).status, 302);
});

test('non-admins cannot open user management or export', async () => {
  const c = await login('bob', 'bobpass123');
  assert.equal((await c('/admin')).status, 302);
  assert.equal((await c('/export/csv')).status, 302);
});

test('cross-site form posts are blocked', async () => {
  const c = await login('alice', 'alicepass1');
  const res = await c('/api/bank/action', {
    method: 'POST',
    headers: { origin: 'https://evil.example' },
    form: { action_type: 'withdraw', amount: '5', description: 'csrf' },
  });
  assert.equal(res.status, 403);
});

test('API rejects missing and invalid keys', async () => {
  assert.equal((await fetch(`${base}/api/v1/balance`)).status, 401);
  assert.equal((await fetch(`${base}/api/v1/balance`, { headers: bearer('pk_nope') })).status, 401);
});

test('API returns only the key owner\'s data', async () => {
  const c = await login('alice', 'alicepass1');
  const key = await makeKey(c, 'read');

  const bal = await (await fetch(`${base}/api/v1/balance`, { headers: bearer(key) })).json();
  assert.equal(bal.account, 'alice');
  assert.equal(bal.balance, 1000);

  const list = await (await fetch(`${base}/api/v1/transactions`, { headers: bearer(key) })).json();
  assert.ok(list.transactions.every((t) => t.description !== 'bob money'));
});

test('read-only keys cannot create transactions', async () => {
  const c = await login('alice', 'alicepass1');
  const key = await makeKey(c, 'read');
  const res = await fetch(`${base}/api/v1/transactions`, {
    method: 'POST',
    headers: { ...bearer(key), 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'deposit', amount: 10, description: 'x' }),
  });
  assert.equal(res.status, 403);
});

test('write keys create pending transactions that do not change the balance until approved', async () => {
  const alice = await login('alice', 'alicepass1');
  const key = await makeKey(alice, 'write');

  const create = await fetch(`${base}/api/v1/transactions`, {
    method: 'POST',
    headers: { ...bearer(key), 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'withdraw', amount: 250.5, description: 'API spend', category: 'Food' }),
  });
  assert.equal(create.status, 201);
  const txn = await create.json();
  assert.equal(txn.status, 'pending');
  assert.equal(txn.amount, -250.5);

  let bal = await (await fetch(`${base}/api/v1/balance`, { headers: bearer(key) })).json();
  assert.equal(bal.balance, 1000);
  assert.equal(bal.pending_count, 1);

  const admin = await login('admin', 'adminpass1');
  await admin('/api/bank/pending_action', { method: 'POST', form: { txn_id: txn.id, decision: 'approve' } });

  bal = await (await fetch(`${base}/api/v1/balance`, { headers: bearer(key) })).json();
  assert.equal(bal.balance, 749.5);
  assert.equal(bal.pending_count, 0);
});

test('API validates input', async () => {
  const c = await login('alice', 'alicepass1');
  const key = await makeKey(c, 'write');
  const post = (body) =>
    fetch(`${base}/api/v1/transactions`, {
      method: 'POST',
      headers: { ...bearer(key), 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  assert.equal((await post({ type: 'steal', amount: 5, description: 'x' })).status, 400);
  assert.equal((await post({ type: 'deposit', amount: -5, description: 'x' })).status, 400);
  assert.equal((await post({ type: 'deposit', amount: 5, description: '' })).status, 400);
});

test('revoked keys stop working', async () => {
  const c = await login('alice', 'alicepass1');
  const key = await makeKey(c, 'read');
  const page = await (await c('/keys')).text();
  // Keys are listed newest first, so the first id on the page belongs to the key just created.
  const id = /name="key_id" value="([0-9a-f-]{36})"/.exec(page)?.[1];
  assert.ok(id);
  assert.equal((await fetch(`${base}/api/v1/balance`, { headers: bearer(key) })).status, 200);
  await c('/keys/revoke', { method: 'POST', form: { key_id: id } });
  assert.equal((await fetch(`${base}/api/v1/balance`, { headers: bearer(key) })).status, 401);
});

test('deleting a user also revokes their API keys', async () => {
  const bob = await login('bob', 'bobpass123');
  const key = await makeKey(bob, 'read');
  assert.equal((await fetch(`${base}/api/v1/balance`, { headers: bearer(key) })).status, 200);

  const admin = await login('admin', 'adminpass1');
  await admin('/admin', { method: 'POST', form: { action: 'delete_user', target_user: 'bob' } });
  assert.equal((await fetch(`${base}/api/v1/balance`, { headers: bearer(key) })).status, 401);
});

test('widget script is served', async () => {
  const res = await fetch(`${base}/widget.js`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /PocketBank/);
});
