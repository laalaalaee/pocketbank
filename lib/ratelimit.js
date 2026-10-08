// Tiny in-memory fixed-window rate limiter. Good enough for a single process;
// swap for a shared store (Redis) if you ever run more than one instance.
export function createLimiter({ max, windowMs }) {
  const hits = new Map();

  function prune(now) {
    for (const [key, entry] of hits) if (entry.resetAt <= now) hits.delete(key);
  }

  return {
    // Returns true if the caller is still within the limit (and counts the hit).
    take(key, now = Date.now()) {
      if (hits.size > 5000) prune(now);
      const entry = hits.get(key);
      if (!entry || entry.resetAt <= now) {
        hits.set(key, { count: 1, resetAt: now + windowMs });
        return true;
      }
      entry.count += 1;
      return entry.count <= max;
    },
    // Count only failures: peek without incrementing, then record on failure.
    blocked(key, now = Date.now()) {
      const entry = hits.get(key);
      return Boolean(entry && entry.resetAt > now && entry.count >= max);
    },
    fail(key, now = Date.now()) {
      const entry = hits.get(key);
      if (!entry || entry.resetAt <= now) hits.set(key, { count: 1, resetAt: now + windowMs });
      else entry.count += 1;
    },
    reset(key) {
      hits.delete(key);
    },
  };
}
