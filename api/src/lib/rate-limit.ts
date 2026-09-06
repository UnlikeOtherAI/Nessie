/**
 * How much of `X-Forwarded-For` Fastify is allowed to believe.
 *
 * `0` (the default) means none: `request.ip` is the socket peer, so a client
 * cannot choose its own rate-limit identity by sending a header. Rate limiting
 * itself lives in `services/rate-limit.ts` (the store) and
 * `routes/auth-rate-limit.ts` (buckets, rules, and the global check) — this
 * file only decides whose address `request.ip` reports.
 */
export const createFastifyTrustProxyConfig = (
  trustedProxyHops: number,
): false | number => trustedProxyHops > 0 ? trustedProxyHops : false
