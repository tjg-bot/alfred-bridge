/**
 * In-memory sliding-window rate limiter.
 *
 * Used to protect Alfred's WhatsApp account from spam and runaway loops:
 *   - Per-sender caps to defend against a hijacked king number
 *   - Global cap to protect the account itself from any abuse pattern
 *   - Broadcast cap so a runaway cron cannot spam the group
 *
 * The sliding window is a simple ring of timestamps. On every check we drop
 * timestamps older than windowMs, count the survivors, and if the count is
 * under maxRequests we push the new timestamp and allow. Otherwise we return
 * how long until the oldest timestamp falls out of the window.
 */

export interface RateLimitConfig {
  windowMs: number;
  maxRequests: number;
}

export interface RateLimiter {
  check(key: string): { allowed: boolean; retryAfterMs?: number };
  reset(key: string): void;
}

export function createRateLimiter(config: RateLimitConfig): RateLimiter {
  const buckets = new Map<string, number[]>();

  const cleanup = setInterval(() => {
    const cutoff = Date.now() - config.windowMs;
    for (const [key, times] of buckets) {
      const fresh = times.filter((t) => t > cutoff);
      if (fresh.length === 0) {
        buckets.delete(key);
      } else {
        buckets.set(key, fresh);
      }
    }
  }, Math.max(30_000, Math.min(config.windowMs, 5 * 60_000)));
  cleanup.unref();

  return {
    check(key: string): { allowed: boolean; retryAfterMs?: number } {
      const now = Date.now();
      const cutoff = now - config.windowMs;
      const existing = buckets.get(key) || [];
      const fresh = existing.filter((t) => t > cutoff);
      if (fresh.length >= config.maxRequests) {
        const oldest = fresh[0];
        const retryAfterMs = Math.max(0, oldest + config.windowMs - now);
        buckets.set(key, fresh);
        return { allowed: false, retryAfterMs };
      }
      fresh.push(now);
      buckets.set(key, fresh);
      return { allowed: true };
    },
    reset(key: string): void {
      buckets.delete(key);
    },
  };
}
