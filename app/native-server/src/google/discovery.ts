/** Google API Discovery: fetch/cache service documents and resolve a method id to its description. */
import fs from 'node:fs';
import path from 'node:path';
import { getAgentDir } from '../security/local-auth';

const TTL_MS = 7 * 24 * 3600 * 1000;
const NAME_RE = /^[a-z][a-z0-9]{0,40}$/;
const VERSION_RE = /^v[0-9][a-z0-9.]{0,15}$/;

export const DEFAULT_VERSIONS: Record<string, string> = {
  sheets: 'v4',
  docs: 'v1',
  drive: 'v3',
  slides: 'v1',
  calendar: 'v3',
  forms: 'v1',
};

export interface DiscoveryParam {
  type?: string;
  location?: 'path' | 'query';
  required?: boolean;
  enum?: string[];
  repeated?: boolean;
  description?: string;
}

export interface DiscoveryMethod {
  id: string;
  path: string;
  httpMethod: string;
  description?: string;
  parameters?: Record<string, DiscoveryParam>;
  parameterOrder?: string[];
  request?: { $ref: string };
  response?: { $ref: string };
  scopes?: string[];
}

export interface DiscoveryDoc {
  name: string;
  version: string;
  rootUrl: string;
  servicePath: string;
  baseUrl?: string;
  parameters?: Record<string, DiscoveryParam>;
  schemas?: Record<string, unknown>;
  resources?: Record<string, { methods?: Record<string, DiscoveryMethod>; resources?: any }>;
  methods?: Record<string, DiscoveryMethod>;
}

const memory = new Map<string, { doc: DiscoveryDoc; at: number }>();

export function resolveVersion(service: string, version?: string): string {
  const v = version || DEFAULT_VERSIONS[service];
  if (!v) throw new Error(`version is required for service "${service}"`);
  return v;
}

export function discoveryUrl(service: string, version: string): string {
  if (!NAME_RE.test(service)) throw new Error(`invalid service name "${service}"`);
  if (!VERSION_RE.test(version)) throw new Error(`invalid version "${version}"`);
  return `https://www.googleapis.com/discovery/v1/apis/${service}/${version}/rest`;
}

const cacheFile = (service: string, version: string) =>
  path.join(getAgentDir(), 'discovery', `${service}.${version}.json`);

const FETCH_TIMEOUT_MS = 30_000;

function isGoogleApisUrl(u: unknown): boolean {
  try {
    const url = new URL(String(u));
    return (
      url.protocol === 'https:' &&
      (url.hostname === 'googleapis.com' || url.hostname.endsWith('.googleapis.com'))
    );
  } catch {
    return false;
  }
}

/** Structural check for a Discovery document, applied to both network and disk-cache reads. */
function isPlausibleDoc(doc: unknown, service: string): doc is DiscoveryDoc {
  if (doc === null || typeof doc !== 'object') return false;
  const d = doc as Partial<DiscoveryDoc> & { name?: unknown };
  return (
    typeof d.servicePath === 'string' &&
    isGoogleApisUrl(d.rootUrl) &&
    (d.baseUrl === undefined || isGoogleApisUrl(d.baseUrl)) &&
    (d.name === undefined || d.name === service)
  );
}

export async function getDiscoveryDoc(service: string, version?: string): Promise<DiscoveryDoc> {
  const v = resolveVersion(service, version);
  const url = discoveryUrl(service, v);
  const key = `${service}/${v}`;
  const mem = memory.get(key);
  if (mem && Date.now() - mem.at < TTL_MS) return mem.doc;

  try {
    const file = cacheFile(service, v);
    const stat = fs.statSync(file);
    if (Date.now() - stat.mtimeMs < TTL_MS) {
      const doc = JSON.parse(fs.readFileSync(file, 'utf8')) as DiscoveryDoc;
      if (isPlausibleDoc(doc, service)) {
        memory.set(key, { doc, at: Date.now() });
        return doc;
      }
      // A tampered or corrupt cache falls through to a fresh fetch, which overwrites it.
    }
  } catch {
    /* no usable disk cache */
  }

  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`discovery fetch failed for ${key} (${res.status})`);
  const doc = (await res.json()) as DiscoveryDoc;
  if (!isPlausibleDoc(doc, service)) throw new Error('malformed discovery document');
  memory.set(key, { doc, at: Date.now() });
  try {
    const file = cacheFile(service, v);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, JSON.stringify(doc), { mode: 0o600 });
  } catch {
    /* cache is best-effort */
  }
  return doc;
}

/** Flattens the nested resource tree into `{ "spreadsheets.values.get": method }`. */
export function indexMethods(doc: DiscoveryDoc): Record<string, DiscoveryMethod> {
  const out: Record<string, DiscoveryMethod> = {};
  const prefix = `${doc.name}.`;
  const walk = (node: { methods?: Record<string, DiscoveryMethod>; resources?: any }) => {
    for (const m of Object.values(node.methods ?? {})) {
      out[m.id.startsWith(prefix) ? m.id.slice(prefix.length) : m.id] = m;
    }
    for (const child of Object.values(node.resources ?? {})) walk(child as any);
  };
  walk({ methods: doc.methods, resources: doc.resources });
  return out;
}

export function findMethod(doc: DiscoveryDoc, methodName: string): DiscoveryMethod {
  const idx = indexMethods(doc);
  const bare = methodName.startsWith(`${doc.name}.`)
    ? methodName.slice(doc.name.length + 1)
    : methodName;
  const m = idx[bare];
  if (!m) {
    const near = Object.keys(idx)
      .filter((k) => k.split('.').slice(0, -1).join('.') === bare.split('.').slice(0, -1).join('.'))
      .slice(0, 12);
    throw new Error(
      `unknown method "${methodName}" in ${doc.name} ${doc.version}` +
        (near.length
          ? `; similar: ${near.join(', ')}`
          : '; use google_api_schema without "method" to list all'),
    );
  }
  return m;
}

const MAX_SCHEMA_DEPTH = 4;

/** Expands $ref up to a depth so the model sees the real request shape without a 500KB dump. */
export function expandSchema(
  doc: DiscoveryDoc,
  ref: string | undefined,
  depth = 0,
  seen = new Set<string>(),
): unknown {
  if (!ref) return undefined;
  const schema: any = doc.schemas?.[ref];
  if (!schema) return { $ref: ref };
  if (seen.has(ref) || depth >= MAX_SCHEMA_DEPTH) return { $ref: ref };
  const nextSeen = new Set(seen).add(ref);
  const walk = (s: any): any => {
    if (!s || typeof s !== 'object') return s;
    if (s.$ref) return expandSchema(doc, s.$ref, depth + 1, nextSeen);
    const o: any = { type: s.type, description: s.description, enum: s.enum };
    if (s.properties) {
      o.properties = {};
      for (const [k, v] of Object.entries(s.properties)) o.properties[k] = walk(v);
    }
    if (s.items) o.items = walk(s.items);
    if (s.additionalProperties) o.additionalProperties = walk(s.additionalProperties);
    return JSON.parse(JSON.stringify(o));
  };
  return walk(schema);
}

export async function describeSchema(args: {
  service: string;
  version?: string;
  method?: string;
  query?: string;
}) {
  const doc = await getDiscoveryDoc(args.service, args.version);
  if (!args.method) {
    const idx = indexMethods(doc);
    const q = args.query?.toLowerCase();
    const list = Object.entries(idx)
      .filter(
        ([k, m]) =>
          !q || k.toLowerCase().includes(q) || (m.description ?? '').toLowerCase().includes(q),
      )
      .slice(0, 200)
      .map(([k, m]) => ({
        method: k,
        http: m.httpMethod,
        summary: (m.description ?? '').split('\n')[0].slice(0, 140),
      }));
    return { service: doc.name, version: doc.version, count: list.length, methods: list };
  }
  const m = findMethod(doc, args.method);
  return {
    service: doc.name,
    version: doc.version,
    method: m.id,
    http: m.httpMethod,
    path: m.path,
    description: m.description,
    parameters: m.parameters,
    required: (m.parameterOrder ?? []).slice(),
    requestBody: expandSchema(doc, m.request?.$ref),
    response: m.response?.$ref,
    scopes: m.scopes,
  };
}

export function clearDiscoveryMemory(): void {
  memory.clear();
}
