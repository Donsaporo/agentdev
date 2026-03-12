import { config } from '../core/config.js';
import { createLogger } from '../core/logger.js';

const log = createLogger('claude');

const API_URL = 'https://api.anthropic.com/v1/messages';
const MAX_RETRIES = 3;
const RETRY_BASE_DELAY = 2_000;
const REQUEST_TIMEOUT = 60_000;

export interface ClaudeMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface ClaudeResponse {
  text: string;
  inputTokens: number;
  outputTokens: number;
  model: string;
}

export async function callClaude(
  systemPrompt: string,
  messages: ClaudeMessage[],
  options?: { maxTokens?: number; temperature?: number }
): Promise<ClaudeResponse> {
  const maxTokens = options?.maxTokens || config.anthropic.maxTokens;
  const temperature = options?.temperature ?? 0.7;

  const body = {
    model: config.anthropic.model,
    max_tokens: maxTokens,
    temperature,
    system: systemPrompt,
    messages,
  };

  let lastError: Error | null = null;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

      const res = await fetch(API_URL, {
        method: 'POST',
        headers: {
          'x-api-key': config.anthropic.apiKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (res.status === 429 || res.status === 529 || res.status >= 500) {
        const retryAfter = res.headers.get('retry-after');
        const delay = retryAfter
          ? parseInt(retryAfter, 10) * 1000
          : RETRY_BASE_DELAY * Math.pow(2, attempt) + Math.random() * 1000;

        log.warn(`Claude API returned ${res.status}, retrying in ${Math.round(delay)}ms`, {
          attempt: attempt + 1,
          status: res.status,
        });

        await new Promise((r) => setTimeout(r, delay));
        continue;
      }

      const data = await res.json();

      if (!res.ok) {
        const errMsg = data.error?.message || `Claude API error: ${res.status}`;
        throw new Error(errMsg);
      }

      const text = data.content
        ?.filter((b: { type: string }) => b.type === 'text')
        .map((b: { text: string }) => b.text)
        .join('') || '';

      const inputTokens = data.usage?.input_tokens || 0;
      const outputTokens = data.usage?.output_tokens || 0;

      log.debug('Claude response received', {
        model: data.model,
        inputTokens,
        outputTokens,
      });

      return {
        text,
        inputTokens,
        outputTokens,
        model: data.model,
      };
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));

      if (lastError.name === 'AbortError') {
        log.warn('Claude API request timed out', { attempt: attempt + 1 });
      }

      if (attempt < MAX_RETRIES - 1) {
        const delay = RETRY_BASE_DELAY * Math.pow(2, attempt) + Math.random() * 1000;
        log.warn(`Claude API call failed, retrying in ${Math.round(delay)}ms`, {
          attempt: attempt + 1,
          error: lastError.message,
        });
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }

  log.error('Claude API call failed after all retries', { error: lastError?.message });
  throw lastError || new Error('Claude API call failed');
}
