/**
 * Spreadsheet formula-injection primitives shared by the Sheets helpers (sheets-docs.ts) and the
 * raw google_api_call policy gate (api-call.ts), so neither path can be used to dodge the other.
 */

/**
 * A cell that Sheets would parse as a formula (or a signed number) under USER_ENTERED. Leading
 * whitespace, control, format (zero-width, BOM, word joiner...) and separator characters and quote
 * marks are skipped first, because Sheets ignores or strips them before deciding.
 */
export const FORMULA_TRIGGER = /^[\s\p{Cc}\p{Cf}\p{Z}᠎﻿'"‘’“”]*[=+\-@]/u;

const GAP = String.raw`[\s\p{Cc}\p{Cf}\p{Z}]*`;
/**
 * Network / exfiltration / paid-service functions that stay blocked even when formulas are allowed.
 * Case-insensitive, tolerant of whitespace or format characters before "(" and of sheet-name or
 * _xlfn. prefixes (matching starts at a word boundary). This is a BLOCKLIST: a custom (Apps Script)
 * function or one built by string concatenation cannot be enumerated; see docs Known limits.
 */
export const DANGEROUS_FUNCTION = new RegExp(
  String.raw`\b(?:IMPORT[A-Z]*|IMAGE|HYPERLINK|AI|GOOGLEFINANCE|WEBSERVICE|CUBE[A-Z]*)${GAP}\(` +
    String.raw`|\bQUERY${GAP}\([^]*?(?:https?:|//)`,
  'iu',
);

/** True when a formula string calls one of the blocked functions. */
export const hasDangerousFunction = (s: string): boolean => DANGEROUS_FUNCTION.test(s);
