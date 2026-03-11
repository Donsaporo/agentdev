import { config } from '../core/config.js';
import { createLogger } from '../core/logger.js';

const log = createLogger('human-simulator');

export function calculateDelay(responseText: string): number {
  const wordCount = responseText.split(/\s+/).length;
  const readTime = Math.min(wordCount * 300, 10_000);
  const typingTime = Math.min(wordCount * 150, 8_000);
  const thinkingTime = 2_000 + Math.random() * 5_000;

  const total = thinkingTime + readTime * 0.4 + typingTime * 0.5;

  const clamped = Math.max(
    config.agent.minResponseDelay,
    Math.min(total, config.agent.maxResponseDelay)
  );

  const jitter = clamped * (0.85 + Math.random() * 0.3);

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
  if (text.length < 160) return [text];

  const sentences = text.match(/[^.!?\n]+[.!?\n]+/g) || [text];

  if (sentences.length <= 2) return [text];

  const chunks: string[] = [];
  let current = '';

  for (const sentence of sentences) {
    if ((current + sentence).length > 250 && current.length > 30) {
      chunks.push(current.trim());
      current = sentence;
    } else {
      current += sentence;
    }
  }

  if (current.trim()) chunks.push(current.trim());

  return chunks.length > 1 ? chunks : [text];
}
