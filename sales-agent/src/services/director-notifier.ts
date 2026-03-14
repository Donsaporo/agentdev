import { config } from '../core/config.js';
import { createLogger } from '../core/logger.js';
import { getSupabase } from '../core/supabase.js';
import { sendTextMessage, sendTemplateMessage } from './whatsapp.js';

const log = createLogger('director-notifier');

type NotificationType = 'escalation' | 'new_lead' | 'meeting_scheduled' | 'window_closing' | 'lead_won' | 'lead_lost' | 'send_failed';

interface NotificationPayload {
  type: NotificationType;
  contactName?: string;
  contactPhone?: string;
  reason?: string;
  details?: string;
}

const TEMPLATES: Record<NotificationType, (p: NotificationPayload) => string> = {
  escalation: (p) =>
    `*ESCALACION*\nContacto: ${p.contactName || 'Desconocido'}\nTel: ${p.contactPhone || 'N/A'}\nRazon: ${p.reason || 'Sin especificar'}`,
  new_lead: (p) =>
    `*NUEVO LEAD*\nContacto: ${p.contactName || 'Desconocido'}\nTel: ${p.contactPhone || 'N/A'}${p.details ? `\n${p.details}` : ''}`,
  meeting_scheduled: (p) =>
    `*REUNION AGENDADA*\nContacto: ${p.contactName || 'Desconocido'}${p.details ? `\n${p.details}` : ''}`,
  window_closing: (p) =>
    `*VENTANA POR CERRAR*\nContacto: ${p.contactName || 'Desconocido'}\nTel: ${p.contactPhone || 'N/A'}\nLa ventana de 24h esta por cerrarse.`,
  lead_won: (p) =>
    `*LEAD GANADO*\nContacto: ${p.contactName || 'Desconocido'}\nTel: ${p.contactPhone || 'N/A'}${p.details ? `\n${p.details}` : ''}`,
  lead_lost: (p) =>
    `*LEAD PERDIDO*\nContacto: ${p.contactName || 'Desconocido'}\nTel: ${p.contactPhone || 'N/A'}${p.reason ? `\nRazon: ${p.reason}` : ''}`,
  send_failed: (p) =>
    `*ENVIO FALLIDO*\nContacto: ${p.contactName || 'Desconocido'}\nTel: ${p.contactPhone || 'N/A'}\nRazon: ${p.reason || 'Error desconocido'}`,
};

async function isDirectorWindowOpen(phone: string): Promise<boolean> {
  try {
    const supabase = getSupabase();
    const cleanPhone = phone.replace(/[\s\-\+\(\)]/g, '');

    const { data } = await supabase
      .from('whatsapp_contacts')
      .select('last_inbound_at')
      .or(`wa_id.eq.${cleanPhone},phone_number.eq.${cleanPhone}`)
      .order('last_inbound_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!data?.last_inbound_at) return false;

    const hoursSince = (Date.now() - new Date(data.last_inbound_at).getTime()) / (1000 * 60 * 60);
    return hoursSince < 24;
  } catch (err) {
    log.warn('Failed to check director window', { phone, error: err instanceof Error ? err.message : String(err) });
    return false;
  }
}

async function queuePendingNotification(phone: string, payload: NotificationPayload): Promise<void> {
  try {
    const supabase = getSupabase();
    await supabase.from('director_pending_notifications').insert({
      director_phone: phone,
      notification_type: payload.type,
      payload: payload as unknown as Record<string, unknown>,
      status: 'pending',
    });
    log.info('Notification queued for director', { phone, type: payload.type });
  } catch (err) {
    log.error('Failed to queue notification', { phone, error: err instanceof Error ? err.message : String(err) });
  }
}

async function sendTemplateToDirector(phone: string): Promise<boolean> {
  try {
    const result = await sendTemplateMessage(phone, 'hey_director', 'es');
    if (result.success) {
      log.info('Template hey_director sent to director', { phone });
      return true;
    }
    log.warn('Template hey_director failed', { phone, reason: result.reason });
    return false;
  } catch (err) {
    log.error('Failed to send hey_director template', { phone, error: err instanceof Error ? err.message : String(err) });
    return false;
  }
}

export async function notifyDirector(payload: NotificationPayload): Promise<void> {
  const phones = config.director.phones;
  if (!phones || phones.length === 0) {
    log.debug('No director phones configured, skipping notification');
    return;
  }

  const template = TEMPLATES[payload.type];
  if (!template) {
    log.warn('Unknown notification type', { type: payload.type });
    return;
  }

  const message = template(payload);

  for (const phone of phones) {
    try {
      const windowOpen = await isDirectorWindowOpen(phone);

      if (windowOpen) {
        await sendTextMessage(phone, message);
        log.info('Director notified', { phone, type: payload.type });
      } else {
        log.info('Director window closed, queuing notification and sending template', { phone, type: payload.type });
        await queuePendingNotification(phone, payload);
        await sendTemplateToDirector(phone);
      }
    } catch (err) {
      log.error('Failed to notify director', {
        phone,
        type: payload.type,
        error: err instanceof Error ? err.message : String(err),
      });
      await queuePendingNotification(phone, payload).catch(() => {});
    }
  }
}

export async function flushPendingNotifications(directorPhone: string): Promise<void> {
  try {
    const supabase = getSupabase();
    const cleanPhone = directorPhone.replace(/[\s\-\+\(\)]/g, '');

    const { data: pending } = await supabase
      .from('director_pending_notifications')
      .select('id, notification_type, payload')
      .eq('director_phone', cleanPhone)
      .eq('status', 'pending')
      .order('created_at', { ascending: true })
      .limit(20);

    if (!pending || pending.length === 0) {
      const partialMatch = config.director.phones.find((p) => {
        const cp = p.replace(/[\s\-\+\(\)]/g, '');
        return cleanPhone.endsWith(cp) || cp.endsWith(cleanPhone);
      });
      if (partialMatch) {
        const { data: retryPending } = await supabase
          .from('director_pending_notifications')
          .select('id, notification_type, payload')
          .eq('director_phone', partialMatch.replace(/[\s\-\+\(\)]/g, ''))
          .eq('status', 'pending')
          .order('created_at', { ascending: true })
          .limit(20);
        if (!retryPending || retryPending.length === 0) return;
        await deliverPending(supabase, retryPending);
        return;
      }
      return;
    }

    await deliverPending(supabase, pending);
  } catch (err) {
    log.error('Failed to flush pending notifications', { error: err instanceof Error ? err.message : String(err) });
  }
}

async function deliverPending(
  supabase: ReturnType<typeof getSupabase>,
  pending: { id: string; notification_type: string; payload: unknown }[]
): Promise<void> {
  log.info(`Flushing ${pending.length} pending notifications to director`);

  for (const notification of pending) {
    const payload = notification.payload as NotificationPayload;
    const templateFn = TEMPLATES[notification.notification_type as NotificationType];
    if (!templateFn) continue;

    const message = templateFn(payload);

    for (const phone of config.director.phones) {
      try {
        await sendTextMessage(phone, message);
      } catch (err) {
        log.warn('Failed to deliver pending notification', {
          id: notification.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    await supabase
      .from('director_pending_notifications')
      .update({ status: 'sent', sent_at: new Date().toISOString() })
      .eq('id', notification.id);
  }

  log.info('Pending notifications flushed');
}
