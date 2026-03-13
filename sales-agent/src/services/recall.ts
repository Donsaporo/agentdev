import { config } from '../core/config.js';
import { createLogger } from '../core/logger.js';
import { callClaude } from './claude.js';

const log = createLogger('recall');

const RECALL_BASE = 'https://api.recall.ai/api/v1';

export interface TranscriptResult {
  transcript: string;
  summary: string;
  actionItems: string[];
  duration: number;
}

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

export async function getTranscript(botId: string): Promise<TranscriptResult | null> {
  if (!isConfigured()) {
    log.warn('Recall.ai integration not configured');
    return null;
  }

  const res = await fetch(`${RECALL_BASE}/bot/${botId}/transcript`, {
    headers: headers(),
  });

  if (!res.ok) {
    const err = await res.text();
    log.error('Failed to get transcript', { botId, error: err });
    return null;
  }

  const segments: Array<{
    speaker: string;
    words: Array<{ text: string; start_time: number; end_time: number }>;
  }> = await res.json();

  if (!segments || segments.length === 0) {
    log.warn('Empty transcript', { botId });
    return null;
  }

  const lines = segments.map((seg) => {
    const text = seg.words.map((w) => w.text).join(' ');
    return `${seg.speaker}: ${text}`;
  });

  const lastWord = segments[segments.length - 1]?.words;
  const duration = lastWord?.[lastWord.length - 1]?.end_time || 0;

  log.info('Transcript retrieved', { botId, segments: segments.length, duration });

  const transcriptText = lines.join('\n');
  const { summary, actionItems } = await summarizeTranscript(transcriptText);

  return {
    transcript: transcriptText,
    summary,
    actionItems,
    duration: Math.round(duration),
  };
}

async function summarizeTranscript(transcript: string): Promise<{ summary: string; actionItems: string[] }> {
  try {
    const prompt = `Eres un asistente de reuniones de Obzide Tech. Analiza la siguiente transcripcion y devuelve JSON con:
- "summary": Resumen ejecutivo en espanol (3-5 oraciones)
- "action_items": Array de compromisos y proximos pasos identificados

Responde SOLO con JSON valido.`;

    const response = await callClaude(prompt, [
      { role: 'user', content: transcript.slice(0, 10_000) },
    ], { maxTokens: 512, temperature: 0.3 });

    const parsed = JSON.parse(response.text.replace(/```json|```/g, '').trim());
    return {
      summary: parsed.summary || '',
      actionItems: Array.isArray(parsed.action_items) ? parsed.action_items : [],
    };
  } catch (err) {
    log.warn('Failed to summarize transcript', { error: err instanceof Error ? err.message : String(err) });
    return { summary: '', actionItems: [] };
  }
}
