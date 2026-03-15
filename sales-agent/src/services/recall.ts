import { config } from '../core/config.js';
import { createLogger } from '../core/logger.js';

const log = createLogger('recall');

const RECALL_BASE = 'https://api.recall.ai/api/v1';

function isConfigured(): boolean {
  return !!config.recall.apiKey;
}

function headers(): Record<string, string> {
  return {
    Authorization: `Token ${config.recall.apiKey}`,
    'Content-Type': 'application/json',
  };
}

export async function joinMeeting(meetUrl: string): Promise<string | null> {
  if (!isConfigured()) {
    log.warn('Recall.ai integration not configured');
    return null;
  }

  const webhookUrl = `${config.supabase.url}/functions/v1/recall-webhook`;

  const res = await fetch(`${RECALL_BASE}/bot`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({
      meeting_url: meetUrl,
      bot_name: 'Obzide Meeting Assistant',
      transcription_options: {
        provider: 'default',
      },
      real_time_transcription: {
        destination_url: webhookUrl,
        partial_results: false,
      },
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    log.error('Failed to create Recall bot', { error: err });
    return null;
  }

  const data = await res.json();
  log.info('Recall bot created', { botId: data.id, meetUrl });
  return data.id;
}

export async function getBotStatus(botId: string): Promise<string | null> {
  if (!isConfigured()) return null;

  const res = await fetch(`${RECALL_BASE}/bot/${botId}`, {
    headers: headers(),
  });

  if (!res.ok) return null;

  const data = await res.json();
  return data.status?.code || null;
}
