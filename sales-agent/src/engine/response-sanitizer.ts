import { createLogger } from '../core/logger.js';

const log = createLogger('response-sanitizer');

export interface SanitizeResult {
  text: string;
  blocked: boolean;
  reason?: string;
}

const FALLBACK_MESSAGE = 'Disculpa, dame un momento por favor.';

const PRICE_FALLBACK = 'Cada proyecto es a medida. Para darte una propuesta acertada necesitamos entender mejor tu proyecto en una reunion.';

const OUT_OF_SCOPE_FALLBACK = 'Eso no es algo en lo que podamos ayudarte. Nuestros servicios son de desarrollo de software y marketing digital para empresas.';

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

const PRICE_PATTERNS = [
  /\$\s*\d+/,
  /\d+\s*(?:USD|usd)/,
  /\d+\s*(?:dolares|dólares)/i,
  /\d+\s*(?:balboas)/i,
  /B\/\.\s*\d+/,
  /desde\s+\$?\d+/i,
  /a\s+partir\s+de\s+\$?\d+/i,
  /(?:entre|de)\s+\$?\d+[\s-]+(?:y|a)\s+\$?\d+/i,
  /(?:costo|precio|cobr|valor|tarifa|cuota|mensualidad)\w*\s+(?:es|de|seria|sería|está|esta|va|aproxim)\w*\s+\$?\d+/i,
  /\d{2,}[\s-]+(?:a|y)[\s-]+\d{2,}\s*(?:USD|dolares|dólares|balboas)/i,
];

const BANNED_CONTENT_PATTERNS = [
  /\bonlyfans?\b/i,
  /\bonly\s+fans?\b/i,
  /\bcontenido\s+(?:adulto|para\s+adultos|explicito|erótico|erotico)\b/i,
  /\bwebcam\b/i,
  /\bapuestas?\s+deportivas?\b/i,
  /\bcasino\s+online\b/i,
  /\bcrypto\s+trading\b/i,
  /\bbitcoin\s+trading\b/i,
  /\b\+18\b/,
  /\bxxx\b/i,
  /\bpornograf/i,
  /\bescort[s]?\b/i,
  /\bmultinivel\b/i,
  /\besquema\s+piramidal\b/i,
];

const PRIVATE_INFO_PATTERNS = [
  /\bclase\s+de\b/i,
  /\breunion\s+con\s+[A-Z]/,
  /\buniversidad\b/i,
  /\brevision\s+de\b/i,
  /\bcompromisos?\s+personal/i,
];

const AI_REVEAL_PATTERNS = [
  /\bcomo\s+modelo\s+de\s+lenguaje\b/i,
  /\bcomo\s+inteligencia\s+artificial\b/i,
  /\bsoy\s+un\s+bot\b/i,
  /\bsoy\s+una?\s+(?:IA|AI|inteligencia\s+artificial)\b/i,
  /\bno\s+soy\s+humano\b/i,
  /\bcomo\s+(?:IA|AI)\b/i,
  /\bmodelo\s+de\s+(?:IA|AI)\b/i,
  /\bchatgpt\b/i,
  /\bgpt-?4\b/i,
  /\bopenai\b/i,
];

const MAX_RESPONSE_LENGTH = 400;

function looksLikeInternalJson(text: string): boolean {
  const matchCount = INTERNAL_JSON_KEYS.filter((key) => text.includes(`"${key}"`)).length;
  if (matchCount >= 2) return true;

  const trimmed = text.trim();
  if ((trimmed.startsWith('{') || trimmed.includes('```')) && matchCount >= 1) return true;

  return false;
}

function containsRuntimeError(text: string): boolean {
  return RUNTIME_ERROR_PATTERNS.some((pattern) => pattern.test(text));
}

function containsSourceCode(text: string): boolean {
  const matches = SOURCE_CODE_PATTERNS.filter((pattern) => pattern.test(text));
  return matches.length >= 3;
}

function containsPriceInfo(text: string): boolean {
  return PRICE_PATTERNS.some((pattern) => pattern.test(text));
}

function containsBannedContent(text: string): boolean {
  return BANNED_CONTENT_PATTERNS.some((pattern) => pattern.test(text));
}

function containsPrivateInfo(text: string): boolean {
  return PRIVATE_INFO_PATTERNS.some((pattern) => pattern.test(text));
}

function revealsAI(text: string): boolean {
  return AI_REVEAL_PATTERNS.some((pattern) => pattern.test(text));
}

function truncateIfTooLong(text: string): string {
  if (text.length <= MAX_RESPONSE_LENGTH) return text;

  const truncated = text.slice(0, MAX_RESPONSE_LENGTH);
  const lastPunctuation = Math.max(
    truncated.lastIndexOf('.'),
    truncated.lastIndexOf('!'),
    truncated.lastIndexOf('?')
  );

  if (lastPunctuation > MAX_RESPONSE_LENGTH * 0.5) {
    return truncated.slice(0, lastPunctuation + 1);
  }

  const lastSpace = truncated.lastIndexOf(' ');
  if (lastSpace > MAX_RESPONSE_LENGTH * 0.5) {
    return truncated.slice(0, lastSpace) + '.';
  }

  return truncated + '...';
}

const REASONING_PREFIXES = /^(Let me|I'll|I will|Based on|Here is|Here's|Analizando|Basandome en|Voy a analizar|Reasoning:)[^\n]*/im;

function stripReasoningPrefix(text: string): string {
  let result = text;
  while (REASONING_PREFIXES.test(result)) {
    result = result.replace(REASONING_PREFIXES, '').trim();
  }
  return result;
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

  if (containsPrivateInfo(text)) {
    log.warn('Blocked private info leak', { preview: text.slice(0, 120) });
    return { text: FALLBACK_MESSAGE, blocked: false, reason: 'private_info_replaced' };
  }

  if (containsPriceInfo(text)) {
    log.warn('Blocked price information', { preview: text.slice(0, 120) });
    return { text: PRICE_FALLBACK, blocked: false, reason: 'price_replaced' };
  }

  if (containsBannedContent(text)) {
    log.warn('Blocked out-of-scope content', { preview: text.slice(0, 120) });
    return { text: OUT_OF_SCOPE_FALLBACK, blocked: false, reason: 'banned_content_replaced' };
  }

  if (revealsAI(text)) {
    log.warn('Blocked AI identity reveal', { preview: text.slice(0, 120) });
    return { text: FALLBACK_MESSAGE, blocked: false, reason: 'ai_reveal_replaced' };
  }

  let cleaned = stripReasoningPrefix(text);
  if (cleaned !== text) {
    log.debug('Stripped reasoning prefix from response');
    if (cleaned.length < 5) {
      return { text: FALLBACK_MESSAGE, blocked: true, reason: 'reasoning_only' };
    }
  }

  if (cleaned.length > MAX_RESPONSE_LENGTH) {
    const original = cleaned;
    cleaned = truncateIfTooLong(cleaned);
    log.info('Response truncated', { originalLength: original.length, newLength: cleaned.length });
  }

  return { text: cleaned, blocked: false };
}
