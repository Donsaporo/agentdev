import { config } from '../core/config.js';
import { createLogger } from '../core/logger.js';

const log = createLogger('human-simulator');

export function calculateDelay(responseText: string, isShortReply = false): number {
  const wordCount = responseText.split(/\s+/).length;

  // Short replies (confirmations, "ok", "dale") - quick response like a real person multitasking
  if (isShortReply || wordCount <= 5) {
    const quick = 4_000 + Math.random() * 4_000;
    log.debug('Quick reply delay', { words: wordCount, delayMs: Math.round(quick) });
    return Math.round(quick);
  }

  // Medium messages - thinking + typing
  if (wordCount <= 15) {
    const medium = 6_000 + Math.random() * 6_000;
    log.debug('Medium reply delay', { words: wordCount, delayMs: Math.round(medium) });
    return Math.round(medium);
  }

  // Longer messages - reading client msg + thinking + typing
  const readTime = Math.min(wordCount * 80, 3_000);
  const typingTime = Math.min(wordCount * 60, 3_000);
  const thinkingTime = 4_000 + Math.random() * 4_000;

  const total = thinkingTime + readTime * 0.5 + typingTime * 0.4;

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
