import { config } from '../core/config.js';
import { createLogger } from '../core/logger.js';

const log = createLogger('human-simulator');

export function calculateDelay(responseText: string, isShortReply = false): number {
  const wordCount = responseText.split(/\s+/).length;

  if (isShortReply || wordCount <= 5) {
    const quick = 10_000 + Math.random() * 10_000;
    log.debug('Quick reply delay', { words: wordCount, delayMs: Math.round(quick) });
    return Math.round(quick);
  }

  if (wordCount <= 15) {
    const medium = 15_000 + Math.random() * 12_000;
    log.debug('Medium reply delay', { words: wordCount, delayMs: Math.round(medium) });
    return Math.round(medium);
  }

  const readTime = Math.min(wordCount * 150, 5_000);
  const typingTime = Math.min(wordCount * 100, 4_000);
  const thinkingTime = 8_000 + Math.random() * 5_000;

  const total = thinkingTime + readTime * 0.6 + typingTime * 0.5;

  const jittered = total * (0.85 + Math.random() * 0.3);

  const clamped = Math.max(
    config.agent.minResponseDelay,
    Math.min(jittered, config.agent.maxResponseDelay)
  );

  log.debug('Delay calculated', {
    words: wordCount,
    delayMs: Math.round(clamped),
  });

  return Math.round(clamped);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function shouldSplitMessage(text: string): string[] {
  if (text.length < 250) return [text];

  const sentences = text.match(/[^.!?\n]+[.!?\n]+/g) || [text];

  if (sentences.length <= 2) return [text];

  const chunks: string[] = [];
  let current = '';

  for (const sentence of sentences) {
    if ((current + sentence).length > 300 && current.length > 30) {
      chunks.push(current.trim());
      current = sentence;
    } else {
      current += sentence;
    }
  }

  if (current.trim()) chunks.push(current.trim());

  return chunks.length > 1 ? chunks : [text];
}
