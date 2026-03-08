import { logger } from './logger.js';

const RETRYABLE_STATUS_CODES = new Set([429, 502, 503, 504]);
const RETRYABLE_ERROR_CODES = new Set(['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EPIPE', 'EAI_AGAIN']);

function isRetryable(err: unknown): boolean {
  if (err instanceof Error) {
    const msg = err.message;
    if (RETRYABLE_ERROR_CODES.has((err as NodeJS.ErrnoException).code || '')) return true;
    for (const code of RETRYABLE_STATUS_CODES) {
      if (msg.includes(String(code))) return true;
    }
    if (msg.includes('ECONNRESET') || msg.includes('ETIMEDOUT') || msg.includes('socket hang up')) return true;
  }
  return false;
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries: number = 3,
  baseDelayMs: number = 2000,
  operation: string = 'unknown'
): Promise<T> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));

      if (!isRetryable(err) || attempt === maxRetries) {
        throw lastError;
      }

      const delay = baseDelayMs * Math.pow(2, attempt) + Math.random() * 1000;
      await logger.warn(
        `Network retry ${attempt + 1}/${maxRetries} for ${operation}: ${lastError.message.slice(0, 150)}`,
        'pipeline'
      );
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  throw lastError || new Error('Retry exhausted');
}
