import { config } from '../core/config.js';
import { createLogger } from '../core/logger.js';
import { callOpenAI, callOpenAIWithVision, ChatMessage, ModelTier } from './openai.js';
import { callClaude, ClaudeMessage } from './claude.js';

const log = createLogger('ai');

export interface AIMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface AIResponse {
  text: string;
  inputTokens: number;
  outputTokens: number;
  model: string;
}

export async function callAI(
  systemPrompt: string,
  messages: AIMessage[],
  options?: { maxTokens?: number; temperature?: number; tier?: ModelTier }
): Promise<AIResponse> {
  const tier = options?.tier || 'primary';

  try {
    return await callOpenAI(systemPrompt, messages, {
      maxTokens: options?.maxTokens,
      temperature: options?.temperature,
      tier,
    });
  } catch (err) {
    log.warn('OpenAI call failed, falling back to Claude', {
      error: err instanceof Error ? err.message : String(err),
      tier,
    });

    if (!config.anthropic.apiKey) {
      throw err;
    }

    const claudeMessages: ClaudeMessage[] = messages.map((m) => ({
      role: m.role,
      content: m.content,
    }));

    return callClaude(systemPrompt, claudeMessages, {
      maxTokens: options?.maxTokens,
      temperature: options?.temperature,
    });
  }
}

export async function callAISecondary(
  systemPrompt: string,
  messages: AIMessage[],
  options?: { maxTokens?: number; temperature?: number }
): Promise<AIResponse> {
  return callAI(systemPrompt, messages, { ...options, tier: 'secondary' });
}

export async function callAIWithVision(
  messages: ChatMessage[],
  options?: { maxTokens?: number; temperature?: number }
): Promise<AIResponse> {
  try {
    return await callOpenAIWithVision(messages, {
      maxTokens: options?.maxTokens,
      temperature: options?.temperature,
      tier: 'secondary',
    });
  } catch (err) {
    log.warn('OpenAI vision failed, falling back to Claude', {
      error: err instanceof Error ? err.message : String(err),
    });

    if (!config.anthropic.apiKey) {
      throw err;
    }

    const textContent = messages
      .filter((m) => m.role === 'user')
      .map((m) => {
        if (typeof m.content === 'string') return m.content;
        return m.content
          .filter((c) => c.type === 'text')
          .map((c) => c.text || '')
          .join(' ');
      })
      .join('\n');

    return callClaude(
      'You are a helpful assistant.',
      [{ role: 'user', content: textContent || 'Describe the content.' }],
      { maxTokens: options?.maxTokens, temperature: options?.temperature }
    );
  }
}
