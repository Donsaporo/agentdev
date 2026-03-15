import { config } from '../core/config.js';
import { createLogger } from '../core/logger.js';

const log = createLogger('whatsapp');

const MAX_RETRIES = 3;
const BACKOFF_BASE_MS = 1_000;

export interface SendResult {
  messageId: string;
  success: boolean;
  retryCount: number;
  reason?: string;
}

function isRetryable(status: number): boolean {
  return [429, 500, 502, 503, 504].includes(status);
}

function isWindowExpired(errMsg: string): boolean {
  const lower = errMsg.toLowerCase();
  return lower.includes('24 hour') || lower.includes('outside') || lower.includes('allowed window') || lower.includes('131026');
}

async function sendWithRetry(recipient: string, payload: Record<string, unknown>): Promise<SendResult> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(`${config.d360.baseUrl}/messages`, {
        method: 'POST',
        headers: {
          'D360-API-KEY': config.d360.apiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      if (res.ok) {
        const data = await res.json();
        const messageId = data.messages?.[0]?.id || '';
        log.info('Message sent', { to: recipient, messageId, attempt });
        return { messageId, success: true, retryCount: attempt };
      }

      let errMsg: string;
      try {
        const errData = await res.json();
        errMsg =
          errData.errors?.[0]?.details ||
          errData.error?.message ||
          errData.meta?.developer_message ||
          JSON.stringify(errData);
      } catch {
        errMsg = `HTTP ${res.status}`;
      }

      if (isWindowExpired(errMsg)) {
        log.warn('Window expired', { to: recipient, error: errMsg });
        return { messageId: '', success: false, retryCount: attempt, reason: 'window_expired' };
      }

      if (isRetryable(res.status) && attempt < MAX_RETRIES - 1) {
        const delay = BACKOFF_BASE_MS * Math.pow(2, attempt);
        log.warn('Retrying send', { to: recipient, status: res.status, attempt, delay });
        await new Promise((r) => setTimeout(r, delay));
        lastError = new Error(errMsg);
        continue;
      }

      throw new Error(errMsg);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < MAX_RETRIES - 1) {
        const delay = BACKOFF_BASE_MS * Math.pow(2, attempt);
        log.warn('Retrying after error', { to: recipient, attempt, delay, error: lastError.message });
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
    }
  }

  log.error('Failed to send after all retries', { to: recipient, error: lastError?.message });
  throw lastError || new Error('Send failed');
}

export async function sendTextMessage(to: string, text: string): Promise<SendResult> {
  const recipient = to.replace(/[\s\-\+\(\)]/g, '');

  const payload = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: recipient,
    type: 'text',
    text: { body: text },
  };

  return sendWithRetry(recipient, payload);
}

export async function sendTemplateMessage(
  to: string,
  templateName: string,
  languageCode = 'es',
  components?: unknown[]
): Promise<SendResult> {
  const recipient = to.replace(/[\s\-\+\(\)]/g, '');

  const template: Record<string, unknown> = {
    name: templateName,
    language: { code: languageCode },
  };
  if (components && components.length > 0) {
    template.components = components;
  }

  const payload = {
    messaging_product: 'whatsapp',
    to: recipient,
    type: 'template',
    template,
  };

  return sendWithRetry(recipient, payload);
}

export async function sendDocumentMessage(
  to: string,
  documentUrl: string,
  filename: string,
  caption?: string
): Promise<SendResult> {
  const recipient = to.replace(/[\s\-\+\(\)]/g, '');

  const document: Record<string, string> = {
    link: documentUrl,
    filename,
  };
  if (caption) {
    document.caption = caption;
  }

  const payload = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: recipient,
    type: 'document',
    document,
  };

  return sendWithRetry(recipient, payload);
}

export async function setTypingIndicator(
  supabase: ReturnType<typeof import('../core/supabase.js').getSupabase>,
  conversationId: string,
  typing: boolean
): Promise<void> {
  await supabase
    .from('whatsapp_conversations')
    .update({ is_agent_typing: typing })
    .eq('id', conversationId);
}
