import { callOpenAI, callOpenAIWithVision, ChatMessage, ModelTier } from './openai.js';

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
  return callOpenAI(systemPrompt, messages, {
    maxTokens: options?.maxTokens,
    temperature: options?.temperature,
    tier,
  });
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
  return callOpenAIWithVision(messages, {
    maxTokens: options?.maxTokens,
    temperature: options?.temperature,
    tier: 'secondary',
  });
}
