import { config } from '../core/config.js';
import { createLogger } from '../core/logger.js';
import { sendTextMessage } from './whatsapp.js';

const log = createLogger('director-notifier');

type NotificationType = 'escalation' | 'new_lead' | 'meeting_scheduled' | 'window_closing' | 'lead_won' | 'lead_lost';

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
};

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
      await sendTextMessage(phone, message);
      log.info('Director notified', { phone, type: payload.type });
    } catch (err) {
      log.error('Failed to notify director', {
        phone,
        type: payload.type,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
