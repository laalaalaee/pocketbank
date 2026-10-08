import dotenv from 'dotenv';
import bcrypt from 'bcryptjs';
import fs from 'node:fs';
import path from 'node:path';
import { createApp } from './app.js';

dotenv.config();

const PORT = Number(process.env.PORT || 3000);
const dataDir = process.env.DATA_DIR || path.join(process.cwd(), 'data');

let sessionSecret = process.env.SESSION_SECRET;
if (!sessionSecret || sessionSecret === 'change-me') {
  sessionSecret = undefined;
  console.log('[WARN] SESSION_SECRET not set - sessions reset on restart. Set it in .env');
}

// Nudge people who deploy the demo data unchanged.
try {
  const users = JSON.parse(fs.readFileSync(path.join(dataDir, 'users.json'), 'utf8'));
  const weak = Object.entries(users).filter(([name, u]) => ['admin123', 'demo123'].some((p) => bcrypt.compareSync(p, u.password || '')));
  if (weak.length) console.log(`[WARN] Demo passwords still in use for: ${weak.map(([n]) => n).join(', ')}. Change them before exposing this publicly.`);
} catch {
  console.log('[WARN] No data/users.json found. Run "npm run seed" first.');
}

const app = createApp({
  dataDir,
  sessionSecret,
  trustProxy: process.env.TRUST_PROXY === 'true',
  secureCookies: process.env.COOKIE_SECURE === 'true',
});

app.listen(PORT, () => console.log(`PocketBank running at http://localhost:${PORT}`));
