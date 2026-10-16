# Design decisions

Short notes on why things are the way they are, so the trade-offs are visible.

## JSON files instead of a database
The project started as a club treasury tool where one person edited a few hundred rows. A JSON file needs no setup and is easy to inspect and back up. All reads and writes go through one queue (`lib/store.js`) and writes are atomic (write a temp file, then rename), so concurrent requests cannot corrupt the file. The limit is a single process and a few thousand transactions. Moving to SQLite is the first item on the roadmap, and the store is the only place that would change.

## Money is handled in integer paise
Floats cannot represent 0.1 exactly, so summing many amounts drifts. Amounts are stored as numbers with at most two decimals, but every sum converts to integer paise first (`lib/ledger.js`). A test adds 0.1 a thousand times and expects exactly 100.

## Every new transaction starts as pending
A deposit or withdrawal submitted by a user, or through the API, does not touch the balance until an admin approves it. This came from the original use case (a treasurer approving spending requests). It also makes the API safer: a leaked write key can only create requests, not move money.

## Each user has their own account
Transactions carry an `owner`, and every dashboard and API view is filtered by it. Admins can see and edit all accounts from the admin panel.

## API keys are hashed, scoped and shown once
Keys are stored as SHA-256 hashes (they are random 192-bit values, so a slow password hash is not needed). The full key is displayed once at creation. Keys are either `read` or `write`. The widget is meant for read keys, because anything placed in a public page is visible to its visitors.

## No CSRF tokens, an Origin check instead
Form posts are rejected when the `Origin`/`Referer` host differs from the request host, and session cookies are `SameSite=Lax`. This keeps the templates free of hidden token fields. The API does not use cookies, so it is not affected. If the app ever needs to support old browsers or embed forms across sites, switch to per-session tokens.

## In-memory rate limiting
Login is limited to 10 failures per IP per 15 minutes, and each API key to 120 requests per minute. The counters live in process memory. That is fine for one instance; with several instances they would need a shared store.
