import { config } from '../core/config.js';
import { createLogger } from '../core/logger.js';

const log = createLogger('whatsapp');

interface SendResult {
  messageId: string;
  success: boolean;
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

  const res = await fetch(`${config.d360.baseUrl}/messages`, {
    method: 'POST',
    headers: {
      'D360-API-KEY': config.d360.apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    let errMsg: string;
    try {
      const errData = await res.json();
      errMsg =
        errData.errors?.[0]?.details ||
        errData.error?.message ||
        errData.meta?.developer_message ||
        JSON.stringify(errData);
    } catch {
      errMsg = await res.text().catch(() => `HTTP ${res.status}`);
    }
    log.error('Failed to send message', { to: recipient, error: errMsg });
    throw new Error(errMsg);
  }

  const data = await res.json();

  const messageId = data.messages?.[0]?.id || '';
  log.info('Message sent', { to: recipient, messageId });

  return { messageId, success: true };
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
