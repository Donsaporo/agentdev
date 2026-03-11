import { config } from '../core/config.js';
import { createLogger } from '../core/logger.js';

const log = createLogger('human-simulator');

export function calculateDelay(responseText: string): number {
  const wordCount = responseText.split(/\s+/).length;
  const baseReadTime = Math.min(wordCount * 200, 8000);
  const typingTime = Math.min(wordCount * 120, 6000);
  const thinkingTime = 1000 + Math.random() * 2000;

  const total = thinkingTime + baseReadTime * 0.3 + typingTime * 0.5;

  const clamped = Math.max(
    config.agent.minResponseDelay,
    Math.min(total, config.agent.maxResponseDelay)
  );

  const jitter = clamped * (0.8 + Math.random() * 0.4);

  log.debug('Delay calculated', {
    words: wordCount,
    delayMs: Math.round(jitter),
  });

  return Math.round(jitter);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function shouldSplitMessage(text: string): string[] {
  if (text.length < 200) return [text];

  const sentences = text.match(/[^.!?]+[.!?]+/g) || [text];

  if (sentences.length <= 2) return [text];

  const chunks: string[] = [];
  let current = '';

  for (const sentence of sentences) {
    if ((current + sentence).length > 300 && current.length > 50) {
      chunks.push(current.trim());
      current = sentence;
    } else {
      current += sentence;
    }
  }

  if (current.trim()) chunks.push(current.trim());

  return chunks.length > 1 ? chunks : [text];
}
