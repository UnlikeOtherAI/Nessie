import { isIPv6 } from 'node:net'

/**
 * Expand an IPv6 address to its eight zero-padded hextets. Input is already
 * validated by `isIPv6`, so this only handles `::` compression and an
 * embedded IPv4 tail (`::ffff:192.0.2.1`); any zone id (`%eth0`) is dropped.
 */
const expandIPv6Hextets = (ip: string): string[] => {
  let addr = ip.toLowerCase().split('%', 1)[0] ?? ''
  if (addr.includes('.')) {
    const octets = addr
      .slice(addr.lastIndexOf(':') + 1)
      .split('.')
      .map((part) => Number.parseInt(part, 10))
    addr = `${addr.slice(0, addr.lastIndexOf(':'))}:${
      (((octets[0] ?? 0) << 8) | (octets[1] ?? 0)).toString(16)
    }:${(((octets[2] ?? 0) << 8) | (octets[3] ?? 0)).toString(16)}`
  }
  const [head = '', tail = ''] = addr.split('::')
  const headParts = head === '' ? [] : head.split(':')
  const tailParts = tail === '' ? [] : tail.split(':')
  const fill = 8 - headParts.length - tailParts.length
  return [
    ...headParts,
    ...Array.from({ length: Math.max(fill, 0) }, () => '0'),
    ...tailParts,
  ].map((part) => part.padStart(4, '0'))
}

/**
 * Canonicalize an IP identity before it is hashed into a bucket key: IPv6
 * collapses to its /64 prefix (the smallest routed allocation — an attacker
 * with a /64 otherwise rotates through 2^64 fresh counters), IPv4 is
 * unchanged and stays per-address.
 */
export const canonicalizeIpIdentity = (ip: string): string => {
  if (!isIPv6(ip)) return ip
  return `${expandIPv6Hextets(ip).slice(0, 4).join(':')}::/64`
}
