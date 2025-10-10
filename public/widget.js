/*
 * PocketBank embeddable widget.
 *
 *   <div id="pocketbank"></div>
 *   <script src="https://YOUR_HOST/widget.js" data-key="pk_..."></script>
 *
 * Optional attributes on the script tag:
 *   data-target  id of the element to render into (default "pocketbank")
 *   data-limit   number of recent transactions to show (default 5)
 *
 * Use a read-only key: anything in a public page can be read by its visitors.
 */
(function () {
  var script = document.currentScript;
  if (!script) return;

  var key = script.getAttribute('data-key');
  var targetId = script.getAttribute('data-target') || 'pocketbank';
  var limit = parseInt(script.getAttribute('data-limit'), 10) || 5;
  var api = new URL(script.src).origin + '/api/v1';

  var host = document.getElementById(targetId);
  if (!host) {
    console.warn('[PocketBank] no element with id "' + targetId + '"');
    return;
  }
  // Shadow DOM keeps the widget's styles from leaking into (or out of) the host page.
  var root = host.attachShadow ? host.attachShadow({ mode: 'open' }) : host;

  var css =
    ':host{display:block;font-family:Inter,system-ui,sans-serif}' +
    '.card{background:#141418;color:#f4f4f5;border:1px solid rgba(228,69,255,.3);border-radius:16px;padding:20px;max-width:380px}' +
    '.label{font-size:11px;letter-spacing:.15em;text-transform:uppercase;color:#a1a1aa;font-weight:700}' +
    '.balance{font-size:32px;font-weight:800;margin:4px 0 14px}' +
    'ul{list-style:none;margin:0;padding:0}' +
    'li{display:flex;justify-content:space-between;gap:12px;padding:8px 0;border-top:1px solid rgba(255,255,255,.06);font-size:14px}' +
    '.d{color:#a1a1aa;font-size:12px}' +
    '.in{color:#10b981}.out{color:#ef4444}.err{color:#ef4444;font-size:14px}';

  function money(n) {
    return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }).format(n);
  }
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text; // textContent, never innerHTML: API data is untrusted
    return e;
  }
  function get(path) {
    return fetch(api + path, { headers: { Authorization: 'Bearer ' + key } }).then(function (r) {
      return r.json().then(function (body) {
        if (!r.ok) throw new Error(body.error || 'Request failed');
        return body;
      });
    });
  }

  var style = el('style');
  style.textContent = css;
  var card = el('div', 'card');
  root.appendChild(style);
  root.appendChild(card);
  card.appendChild(el('div', 'label', 'Loading…'));

  if (!key) {
    card.textContent = '';
    card.appendChild(el('div', 'err', 'PocketBank: missing data-key'));
    return;
  }

  Promise.all([get('/balance'), get('/transactions?limit=' + limit)])
    .then(function (res) {
      var bal = res[0], tx = res[1].transactions;
      card.textContent = '';
      card.appendChild(el('div', 'label', 'Balance · ' + bal.account));
      card.appendChild(el('div', 'balance', money(bal.balance)));
      var list = el('ul');
      tx.forEach(function (t) {
        var li = el('li');
        var left = el('div');
        left.appendChild(el('div', null, t.description));
        left.appendChild(el('div', 'd', t.date + ' · ' + t.status));
        li.appendChild(left);
        li.appendChild(el('div', t.amount >= 0 ? 'in' : 'out', money(t.amount)));
        list.appendChild(li);
      });
      if (!tx.length) list.appendChild(el('li', 'd', 'No transactions yet.'));
      card.appendChild(list);
    })
    .catch(function (e) {
      card.textContent = '';
      card.appendChild(el('div', 'err', 'PocketBank: ' + e.message));
    });
})();
