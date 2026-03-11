import { config } from '../core/config.js';
import { createLogger } from '../core/logger.js';

const log = createLogger('claude');

const API_URL = 'https://api.anthropic.com/v1/messages';

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

  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'x-api-key': config.anthropic.apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  const data = await res.json();

  if (!res.ok) {
    const errMsg = data.error?.message || `Claude API error: ${res.status}`;
    log.error('Claude API call failed', { error: errMsg, status: res.status });
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
}
