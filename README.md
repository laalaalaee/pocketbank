# AI Bank

A small banking / ledger dashboard: track a balance, submit transactions for approval, and manage them from an admin panel. Built with Express, Nunjucks and plain JSON file storage, so it runs with zero setup and is easy to extend.

## Features

- Username/password login (bcrypt, session cookies)
- Balance, income / expense totals and monthly net at a glance
- Any user can submit a deposit or withdrawal, which stays **pending** until an admin approves or declines it
- Admin panel: add, edit and delete transactions, approve the pending queue, export CSV
- Transaction types: deposit, withdraw, transfer, income, expense, with categories and references

## Run it locally

```bash
npm install
cp .env.example .env        # then set SESSION_SECRET
npm run seed                # creates demo data in data/
npm start                   # http://localhost:9013
```

Demo logins created by the seed script: `admin` / `admin123` (admin) and `demo` / `demo123` (regular user). Set `ADMIN_PASSWORD` when seeding to choose your own admin password. Change both before putting this anywhere public.

## Project layout

```
app.js            server, routes and transaction logic
templates/        Nunjucks views (base, login, bank dashboard)
scripts/seed.js   demo users and transactions
data/             runtime JSON storage (git-ignored)
```

## Background

This started as the treasury module of Playstorm Esports Club's internal management system at Amity University, which handled data for 1,200+ members. The bank part was extracted into a standalone project and is being rebuilt as a general-purpose banking platform.

## Roadmap

- [ ] CSRF protection and login rate limiting
- [ ] Move storage from JSON files to SQLite/Postgres
- [ ] Multiple accounts per user and transfers between them
- [ ] Charts and monthly statements
- [ ] AI-assisted categorisation and spending insights
- [ ] Tests and CI
