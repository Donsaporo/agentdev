import { createLogger } from '../core/logger.js';

const log = createLogger('recall');

export interface TranscriptResult {
  transcript: string;
  summary: string;
  actionItems: string[];
  duration: number;
}

export async function joinMeeting(_meetUrl: string): Promise<string | null> {
  log.warn('Recall.ai integration not yet configured');
  return null;
}

export async function getTranscript(_botId: string): Promise<TranscriptResult | null> {
  log.warn('Recall.ai integration not yet configured');
  return null;
}
