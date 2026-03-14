import { createLogger } from '../core/logger.js';

const log = createLogger('response-sanitizer');

export interface SanitizeResult {
  text: string;
  blocked: boolean;
  reason?: string;
}

const FALLBACK_MESSAGE = 'Disculpa, dame un momento por favor.';

const INTERNAL_JSON_KEYS = [
  'response_text',
  'should_escalate',
  'escalation_reason',
  'tool_calls',
];

const RUNTIME_ERROR_PATTERNS = [
  /TypeError\s*:/i,
  /SyntaxError\s*:/i,
  /ReferenceError\s*:/i,
  /RangeError\s*:/i,
  /\bstack\s*trace\b/i,
  /\bat\s+\S+\s*\(\S+:\d+:\d+\)/,
  /Error:\s+\S+/,
  /\bundefined\b.*\bnull\b.*\bNaN\b/,
];

const SOURCE_CODE_PATTERNS = [
  /\bfunction\s*\(/,
  /=>\s*\{/,
  /\bconst\s+\w+\s*=/,
  /\blet\s+\w+\s*=/,
  /\bimport\s+\{?\s*\w+/,
  /\bexport\s+(default\s+)?(function|class|const|let)/,
  /<\/?[a-zA-Z][a-zA-Z0-9]*(\s[^>]*)?\/?>/,
];

function looksLikeInternalJson(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{') && !trimmed.includes('```')) return false;

  const matchCount = INTERNAL_JSON_KEYS.filter((key) => text.includes(`"${key}"`)).length;
  return matchCount >= 2;
}

function containsRuntimeError(text: string): boolean {
  return RUNTIME_ERROR_PATTERNS.some((pattern) => pattern.test(text));
}

function containsSourceCode(text: string): boolean {
  const matches = SOURCE_CODE_PATTERNS.filter((pattern) => pattern.test(text));
  return matches.length >= 2;
}

function isEmptyOrWhitespace(text: string): boolean {
  return !text || text.trim().length === 0;
}

export function sanitizeResponse(text: string): SanitizeResult {
  if (isEmptyOrWhitespace(text)) {
    log.warn('Blocked empty response');
    return { text: FALLBACK_MESSAGE, blocked: true, reason: 'empty_response' };
  }

  if (looksLikeInternalJson(text)) {
    log.warn('Blocked internal JSON leak', { preview: text.slice(0, 120) });
    return { text: FALLBACK_MESSAGE, blocked: true, reason: 'json_leak' };
  }

  if (containsRuntimeError(text)) {
    log.warn('Blocked runtime error leak', { preview: text.slice(0, 120) });
    return { text: FALLBACK_MESSAGE, blocked: true, reason: 'runtime_error' };
  }

  if (containsSourceCode(text)) {
    log.warn('Blocked source code leak', { preview: text.slice(0, 120) });
    return { text: FALLBACK_MESSAGE, blocked: true, reason: 'source_code' };
  }

  return { text, blocked: false };
}
