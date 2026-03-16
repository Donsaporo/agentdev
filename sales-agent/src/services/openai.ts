import { config } from '../core/config.js';
import { createLogger } from '../core/logger.js';

const log = createLogger('openai');

const API_URL = 'https://api.openai.com/v1/chat/completions';
const MAX_RETRIES = 3;
const RETRY_BASE_DELAY = 2_000;
const REQUEST_TIMEOUT = 60_000;

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | Array<{ type: string; text?: string; image_url?: { url: string; detail?: string } }>;
}

export interface ChatResponse {
  text: string;
  inputTokens: number;
  outputTokens: number;
  model: string;
}

export type ModelTier = 'primary' | 'secondary';

function getModel(tier: ModelTier): string {
  return tier === 'primary'
    ? config.openai.primaryModel
    : config.openai.secondaryModel;
}

export async function callOpenAI(
  systemPrompt: string,
  messages: { role: 'user' | 'assistant'; content: string }[],
  options?: { maxTokens?: number; temperature?: number; tier?: ModelTier }
): Promise<ChatResponse> {
  const tier = options?.tier || 'primary';
  const model = getModel(tier);
  const maxTokens = options?.maxTokens || config.openai.maxTokens;
  const temperature = options?.temperature ?? 0.7;

  const chatMessages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    ...messages.map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content })),
  ];

  return callOpenAIRaw(chatMessages, { model, maxTokens, temperature });
}

export async function callOpenAIWithVision(
  messages: ChatMessage[],
  options?: { maxTokens?: number; temperature?: number; tier?: ModelTier }
): Promise<ChatResponse> {
  const tier = options?.tier || 'secondary';
  const model = getModel(tier);
  const maxTokens = options?.maxTokens || 500;
  const temperature = options?.temperature ?? 0.3;

  return callOpenAIRaw(messages, { model, maxTokens, temperature });
}

async function callOpenAIRaw(
  messages: ChatMessage[],
  opts: { model: string; maxTokens: number; temperature: number }
): Promise<ChatResponse> {
  const body = {
    model: opts.model,
    max_tokens: opts.maxTokens,
    temperature: opts.temperature,
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
          Authorization: `Bearer ${config.openai.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (res.status === 429 || res.status >= 500) {
        const retryAfter = res.headers.get('retry-after');
        const delay = retryAfter
          ? parseInt(retryAfter, 10) * 1000
          : RETRY_BASE_DELAY * Math.pow(2, attempt) + Math.random() * 1000;

        log.warn(`OpenAI API returned ${res.status}, retrying in ${Math.round(delay)}ms`, {
          attempt: attempt + 1,
          status: res.status,
          model: opts.model,
        });

        await new Promise((r) => setTimeout(r, delay));
        continue;
      }

      const data = await res.json();

      if (!res.ok) {
        const errMsg = data.error?.message || `OpenAI API error: ${res.status}`;
        throw new Error(errMsg);
      }

      const text = data.choices?.[0]?.message?.content || '';
      const inputTokens = data.usage?.prompt_tokens || 0;
      const outputTokens = data.usage?.completion_tokens || 0;

      log.debug('OpenAI response received', {
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
        log.warn('OpenAI API request timed out', { attempt: attempt + 1, model: opts.model });
      }

      if (attempt < MAX_RETRIES - 1) {
        const delay = RETRY_BASE_DELAY * Math.pow(2, attempt) + Math.random() * 1000;
        log.warn(`OpenAI API call failed, retrying in ${Math.round(delay)}ms`, {
          attempt: attempt + 1,
          error: lastError.message,
        });
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }

  log.error('OpenAI API call failed after all retries', { error: lastError?.message, model: opts.model });
  throw lastError || new Error('OpenAI API call failed');
}
