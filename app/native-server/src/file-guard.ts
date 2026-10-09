import * as path from 'path';
import * as dns from 'dns';
import * as net from 'net';

/**
 * Guards for the file-upload path: the URL a tool asks the bridge to fetch, and the file name a
 * tool asks it to write. Both values come from an MCP client and must be treated as untrusted.
 */

/** True when the IPv4 dotted quad is not a publicly routable unicast address. */
function isPrivateV4(ip: string): boolean {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = p;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && p[2] === 0) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

/** True when the IPv6 address is not a publicly routable unicast address. */
function isPrivateV6(ip: string): boolean {
  const lower = ip.toLowerCase().split('%')[0];
  if (lower === '::' || lower === '::1') return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (mapped) return isPrivateV4(mapped[1]);
  // IPv4-mapped in hex form (::ffff:7f00:1) and any other embedded-v4 form: refuse.
  if (lower.startsWith('::ffff:') || lower.startsWith('64:ff9b:') || lower.startsWith('2002:')) {
    return true;
  }
  const first = parseInt(lower.split(':')[0] || '0', 16);
  return (
    (first & 0xfe00) === 0xfc00 || // fc00::/7 unique local
    (first & 0xffc0) === 0xfe80 || // fe80::/10 link local
    (first & 0xff00) === 0xff00 || // ff00::/8 multicast
    lower.startsWith('2001:db8:') ||
    lower.startsWith('2001:0:') // Teredo
  );
}

export function isPublicAddress(ip: string): boolean {
  const family = net.isIP(ip);
  if (family === 4) return !isPrivateV4(ip);
  if (family === 6) return !isPrivateV6(ip);
  return false;
}

export type HostResolver = (hostname: string) => Promise<string[]>;

const defaultResolver: HostResolver = async (hostname) => {
  const res = await dns.promises.lookup(hostname, { all: true });
  return res.map((r) => r.address);
};

/**
 * Throws unless `rawUrl` is http(s) and every address its host resolves to is public.
 * Returns the parsed URL.
 */
export async function assertFetchableUrl(
  rawUrl: string,
  resolver: HostResolver = defaultResolver,
): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error('Invalid file URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Unsupported URL scheme: ${url.protocol}`);
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = net.isIP(host) ? [host] : await resolver(host);
  if (addresses.length === 0) throw new Error(`Cannot resolve host: ${host}`);
  for (const addr of addresses) {
    if (!isPublicAddress(addr)) {
      throw new Error(`Non-public address refused for file URL: ${host}`);
    }
  }
  return url;
}

/** Reduces a caller-supplied name to one safe path segment. Returns null when nothing is left. */
export function sanitizeFileName(name: string): string | null {
  const segment = name.replace(/\\/g, '/').split('/').pop() ?? '';
  const cleaned = Array.from(segment)
    .filter((ch) => ch.charCodeAt(0) >= 0x20)
    .join('')
    .trim();
  if (!cleaned || cleaned === '.' || cleaned === '..') return null;
  return cleaned;
}

/** True when `target`, once resolved, is a strict descendant of `dir`. */
export function isInsideDir(dir: string, target: string): boolean {
  const rel = path.relative(path.resolve(dir), path.resolve(target));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}
