/** Default (read-write) scope per Discovery service; a read-only policy narrows it. */
export const SCOPE_PREFIX = 'https://www.googleapis.com/auth/';

export const SERVICE_SCOPES: Record<string, { rw: string; ro: string }> = {
  sheets: { rw: 'spreadsheets', ro: 'spreadsheets.readonly' },
  docs: { rw: 'documents', ro: 'documents.readonly' },
  drive: { rw: 'drive', ro: 'drive.readonly' },
  slides: { rw: 'presentations', ro: 'presentations.readonly' },
  calendar: { rw: 'calendar', ro: 'calendar.readonly' },
  forms: { rw: 'forms.body', ro: 'forms.body.readonly' },
};

export function scopesFor(service: string, readOnly: boolean): string[] {
  const s = Object.prototype.hasOwnProperty.call(SERVICE_SCOPES, service)
    ? SERVICE_SCOPES[service]
    : undefined;
  if (!s)
    throw new Error(
      `no default scope for service "${service}"; supported: ${Object.keys(SERVICE_SCOPES).join(', ')}`,
    );
  return [SCOPE_PREFIX + (readOnly ? s.ro : s.rw)];
}

/**
 * True when every requested scope is granted, treating a read-write grant as covering its
 * `.readonly` sibling (Google honours a read call under the wider scope).
 */
export function scopesCovered(granted: string[], requested: string[]): boolean {
  return requested.every(
    (r) => granted.includes(r) || granted.includes(r.replace(/\.readonly$/, '')),
  );
}
