import { config } from '../core/config.js';
import { createLogger } from '../core/logger.js';
import { callOpenAIWithVision, ChatMessage } from './openai.js';

const log = createLogger('media');

const VISION_PROMPT =
  'Describe en una oracion breve y en espanol que contiene esta imagen. Si parece un comprobante de pago, indica que es un comprobante de pago. Si es un diseno o mockup, describe brevemente lo que muestra. No uses markdown.';

const DOCUMENT_PROMPT =
  'Resume en 2-3 oraciones en espanol el contenido de este documento. No uses markdown.';

export interface MediaResult {
  description: string;
  success: boolean;
}

export async function downloadMedia(mediaId: string): Promise<{ buffer: Buffer; mimeType: string }> {
  const res = await fetch(`${config.d360.baseUrl}/media/${mediaId}`, {
    headers: { 'D360-API-KEY': config.d360.apiKey },
  });

  if (!res.ok) {
    throw new Error(`Media download failed: HTTP ${res.status}`);
  }

  const contentType = res.headers.get('content-type') || 'application/octet-stream';
  const arrayBuffer = await res.arrayBuffer();
  return { buffer: Buffer.from(arrayBuffer), mimeType: contentType };
}

export async function downloadFromUrl(url: string): Promise<{ buffer: Buffer; mimeType: string }> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`URL download failed: HTTP ${res.status}`);
  }
  const contentType = res.headers.get('content-type') || 'application/octet-stream';
  const arrayBuffer = await res.arrayBuffer();
  return { buffer: Buffer.from(arrayBuffer), mimeType: contentType };
}

export async function describeImage(imageBuffer: Buffer, mimeType: string): Promise<MediaResult> {
  try {
    const base64 = imageBuffer.toString('base64');
    const mediaType = normalizeImageMimeType(mimeType);
    const dataUrl = `data:${mediaType};base64,${base64}`;

    const messages: ChatMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: dataUrl, detail: 'low' } },
          { type: 'text', text: VISION_PROMPT },
        ],
      },
    ];

    const response = await callOpenAIWithVision(messages, {
      maxTokens: 200,
      temperature: 0.3,
      tier: 'secondary',
    });

    log.info('Image described', { length: response.text.length });
    return { description: response.text.trim(), success: true };
  } catch (err) {
    log.error('describeImage failed', { error: err instanceof Error ? err.message : String(err) });
    return { description: '', success: false };
  }
}

export async function transcribeAudio(audioBuffer: Buffer, mimeType: string): Promise<MediaResult> {
  if (!config.openai.apiKey) {
    log.warn('OPENAI_KEY not configured, cannot transcribe audio');
    return { description: '', success: false };
  }

  try {
    const ext = audioMimeToExt(mimeType);
    const blob = new Blob([new Uint8Array(audioBuffer)], { type: mimeType });

    const formData = new FormData();
    formData.append('file', blob, `audio.${ext}`);
    formData.append('model', 'whisper-1');
    formData.append('language', 'es');

    const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.openai.apiKey}`,
      },
      body: formData,
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Whisper API error ${res.status}: ${err}`);
    }

    const data = await res.json();
    const text = data.text?.trim() || '';

    log.info('Audio transcribed', { length: text.length });
    return { description: text, success: true };
  } catch (err) {
    log.error('transcribeAudio failed', { error: err instanceof Error ? err.message : String(err) });
    return { description: '', success: false };
  }
}

export async function describeDocument(docBuffer: Buffer, mimeType: string): Promise<MediaResult> {
  try {
    if (mimeType.includes('text') || mimeType.includes('json') || mimeType.includes('xml')) {
      const text = docBuffer.toString('utf-8').slice(0, 5000);
      return { description: `Documento de texto: ${text.slice(0, 500)}`, success: true };
    }

    return await describeDocumentWithVision(docBuffer, mimeType);
  } catch (err) {
    log.error('describeDocument failed', { error: err instanceof Error ? err.message : String(err) });
    return { description: '', success: false };
  }
}

async function describeDocumentWithVision(docBuffer: Buffer, mimeType: string): Promise<MediaResult> {
  const base64 = docBuffer.toString('base64');
  const isPdf = mimeType === 'application/pdf' || mimeType.includes('pdf');
  const resolvedMime = isPdf ? 'application/pdf' : normalizeImageMimeType(mimeType);
  const dataUrl = `data:${resolvedMime};base64,${base64}`;

  const messages: ChatMessage[] = [
    {
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: dataUrl, detail: 'low' } },
        { type: 'text', text: DOCUMENT_PROMPT },
      ],
    },
  ];

  const response = await callOpenAIWithVision(messages, {
    maxTokens: 300,
    temperature: 0.3,
    tier: 'secondary',
  });

  log.info('Document described', { length: response.text.length, mimeType });
  return { description: response.text.trim(), success: true };
}

function normalizeImageMimeType(mime: string): string {
  const clean = mime.split(';')[0].trim().toLowerCase();
  const allowed = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
  return allowed.includes(clean) ? clean : 'image/jpeg';
}

function audioMimeToExt(mime: string): string {
  const map: Record<string, string> = {
    'audio/ogg': 'ogg',
    'audio/ogg; codecs=opus': 'ogg',
    'audio/mpeg': 'mp3',
    'audio/mp3': 'mp3',
    'audio/amr': 'amr',
    'audio/aac': 'aac',
    'audio/mp4': 'mp4',
    'audio/wav': 'wav',
  };
  return map[mime.toLowerCase()] || 'ogg';
}
