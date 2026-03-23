import { SupabaseClient } from '@supabase/supabase-js';
import { createLogger } from '../core/logger.js';
import { sendTextMessage, sendTemplateMessage, setTypingIndicator } from '../services/whatsapp.js';
import { getOrAssignPersona } from './persona-engine.js';
import { notifyDirector } from '../services/director-notifier.js';
import { calculateDelay, sleep } from './human-simulator.js';

const log = createLogger('meeting-reminder');

const REMINDER_24H_WINDOW_MS = 26 * 60 * 60_000;
const REMINDER_24H_CUTOFF_MS = 22 * 60 * 60_000;
const REMINDER_1H_WINDOW_MS = 75 * 60_000;
const REMINDER_1H_CUTOFF_MS = 30 * 60_000;
const PENDING_REMINDER_EXPIRY_MS = 6 * 60 * 60_000;
const FOLLOW_UP_TEMPLATE = 'seguimiento_amigable';

function formatMeetingTime(startTime: string): string {
  const d = new Date(startTime);
  return d.toLocaleString('es-PA', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone: 'America/Panama',
  });
}

function buildReminderMessage(
  contactName: string,
  personaName: string,
  meetingTitle: string,
  meetingStart: string,
  meetLink: string,
  reminderType: '24h' | '1h'
): string {
  const timeStr = formatMeetingTime(meetingStart);
  const firstName = (contactName || '').split(' ')[0] || '';
  const greeting = firstName ? `Hola ${firstName}` : 'Hola';

  if (reminderType === '1h') {
    const lines = [
      `${greeting}, te recuerdo que en una hora tenemos nuestra reunion.`,
    ];
    if (meetLink) {
      lines.push(`Aqui esta el link: ${meetLink}`);
    }
    lines.push('Nos vemos ahi?');
    return lines.join('\n');
  }

  const lines = [
    `${greeting}, te escribo para recordarte que manana tenemos nuestra reunion programada para ${timeStr}.`,
  ];
  if (meetLink) {
    lines.push(`El link de la llamada es: ${meetLink}`);
  }
  lines.push('Seguimos en pie?');
  return lines.join('\n');
}

async function isWindowOpen(supabase: SupabaseClient, contactId: string): Promise<boolean> {
  const { data } = await supabase
    .from('whatsapp_contacts')
    .select('last_inbound_at')
    .eq('id', contactId)
    .maybeSingle();

  if (!data?.last_inbound_at) return false;
  const hoursSince = (Date.now() - new Date(data.last_inbound_at).getTime()) / (1000 * 60 * 60);
  return hoursSince < 24;
}

async function recordOutbound(
  supabase: SupabaseClient,
  conversationId: string,
  contactId: string,
  waMessageId: string,
  content: string,
  senderName: string,
  metadata: Record<string, unknown>
) {
  await supabase.from('whatsapp_messages').insert({
    conversation_id: conversationId,
    contact_id: contactId,
    wa_message_id: waMessageId,
    direction: 'outbound',
    message_type: 'text',
    content,
    status: 'sent',
    sender_name: senderName,
    metadata,
  });

  await supabase
    .from('whatsapp_conversations')
    .update({
      last_message_at: new Date().toISOString(),
      last_message_preview: content.slice(0, 100),
    })
    .eq('id', conversationId);
}

async function sendReminderDirect(
  supabase: SupabaseClient,
  meeting: MeetingRow,
  reminderType: '24h' | '1h'
): Promise<boolean> {
  const { data: contact } = await supabase
    .from('whatsapp_contacts')
    .select('display_name, wa_id, phone_number')
    .eq('id', meeting.contact_id)
    .maybeSingle();

  if (!contact) return false;

  const waId = contact.wa_id || contact.phone_number || '';
  if (!waId) return false;

  const persona = await getOrAssignPersona(supabase, meeting.conversation_id, meeting.contact_id);
  const message = buildReminderMessage(
    contact.display_name || '',
    persona.full_name,
    meeting.title,
    meeting.start_time,
    meeting.meet_link || '',
    reminderType
  );

  await setTypingIndicator(supabase, meeting.conversation_id, true);
  await sleep(calculateDelay(message, false));
  await setTypingIndicator(supabase, meeting.conversation_id, false);

  const result = await sendTextMessage(waId, message).catch((err) => {
    log.warn('Reminder direct send failed', { meetingId: meeting.id, error: err instanceof Error ? err.message : String(err) });
    return null;
  });

  if (!result || (!result.success && result.reason === 'window_expired')) {
    return false;
  }

  await recordOutbound(
    supabase,
    meeting.conversation_id,
    meeting.contact_id,
    result.messageId,
    message,
    persona.full_name,
    { meeting_reminder: true, reminder_type: reminderType, meeting_id: meeting.id }
  );

  log.info('Reminder sent directly', {
    meetingId: meeting.id,
    reminderType,
    contact: contact.display_name,
  });

  return true;
}

async function sendTemplateAndQueue(
  supabase: SupabaseClient,
  meeting: MeetingRow,
  reminderType: '24h' | '1h'
): Promise<boolean> {
  const { data: contact } = await supabase
    .from('whatsapp_contacts')
    .select('display_name, wa_id, phone_number')
    .eq('id', meeting.contact_id)
    .maybeSingle();

  if (!contact) return false;

  const waId = contact.wa_id || contact.phone_number || '';
  if (!waId) return false;

  const tplResult = await sendTemplateMessage(waId, FOLLOW_UP_TEMPLATE, 'es_PA').catch((err) => {
    log.error('Reminder template send failed', { meetingId: meeting.id, error: err instanceof Error ? err.message : String(err) });
    return null;
  });

  if (!tplResult || !tplResult.success) {
    notifyDirector({
      type: 'send_failed',
      contactName: contact.display_name || 'Desconocido',
      contactPhone: waId,
      reason: `No se pudo enviar template de recordatorio (${reminderType}) para reunion "${meeting.title}"`,
    }).catch(() => {});
    return false;
  }

  const persona = await getOrAssignPersona(supabase, meeting.conversation_id, meeting.contact_id);

  await recordOutbound(
    supabase,
    meeting.conversation_id,
    meeting.contact_id,
    tplResult.messageId,
    `[Template: ${FOLLOW_UP_TEMPLATE}]`,
    persona.full_name,
    { meeting_reminder_template: true, reminder_type: reminderType, meeting_id: meeting.id }
  );

  await supabase.from('meeting_reminder_queue').insert({
    meeting_id: meeting.id,
    contact_id: meeting.contact_id,
    conversation_id: meeting.conversation_id,
    reminder_type: reminderType,
    status: 'pending_response',
    meet_link: meeting.meet_link || '',
    meeting_title: meeting.title,
    meeting_start_time: meeting.start_time,
    template_sent_at: new Date().toISOString(),
  });

  log.info('Reminder template sent and queued', {
    meetingId: meeting.id,
    reminderType,
    contact: contact.display_name,
  });

  return true;
}

interface MeetingRow {
  id: string;
  conversation_id: string;
  contact_id: string;
  title: string;
  start_time: string;
  end_time: string;
  meet_link: string | null;
  status: string;
  reminder_24h_sent: boolean;
  reminder_1h_sent: boolean;
}

export async function processMeetingReminders(supabase: SupabaseClient): Promise<void> {
  try {
    const now = Date.now();
    const window24hStart = new Date(now + REMINDER_24H_CUTOFF_MS).toISOString();
    const window24hEnd = new Date(now + REMINDER_24H_WINDOW_MS).toISOString();

    const { data: meetings24h } = await supabase
      .from('sales_meetings')
      .select('id, conversation_id, contact_id, title, start_time, end_time, meet_link, status, reminder_24h_sent, reminder_1h_sent')
      .eq('status', 'scheduled')
      .eq('reminder_24h_sent', false)
      .gte('start_time', window24hStart)
      .lte('start_time', window24hEnd)
      .limit(5);

    for (const meeting of (meetings24h || []) as MeetingRow[]) {
      const windowOpen = await isWindowOpen(supabase, meeting.contact_id);

      let sent = false;
      if (windowOpen) {
        sent = await sendReminderDirect(supabase, meeting, '24h');
        if (!sent) {
          sent = await sendTemplateAndQueue(supabase, meeting, '24h');
        }
      } else {
        sent = await sendTemplateAndQueue(supabase, meeting, '24h');
      }

      if (sent) {
        await supabase
          .from('sales_meetings')
          .update({ reminder_24h_sent: true, updated_at: new Date().toISOString() })
          .eq('id', meeting.id);
      }
    }

    const window1hStart = new Date(now + REMINDER_1H_CUTOFF_MS).toISOString();
    const window1hEnd = new Date(now + REMINDER_1H_WINDOW_MS).toISOString();

    const { data: meetings1h } = await supabase
      .from('sales_meetings')
      .select('id, conversation_id, contact_id, title, start_time, end_time, meet_link, status, reminder_24h_sent, reminder_1h_sent')
      .eq('status', 'scheduled')
      .eq('reminder_1h_sent', false)
      .gte('start_time', window1hStart)
      .lte('start_time', window1hEnd)
      .limit(5);

    for (const meeting of (meetings1h || []) as MeetingRow[]) {
      const windowOpen = await isWindowOpen(supabase, meeting.contact_id);

      let sent = false;
      if (windowOpen) {
        sent = await sendReminderDirect(supabase, meeting, '1h');
        if (!sent) {
          sent = await sendTemplateAndQueue(supabase, meeting, '1h');
        }
      } else {
        sent = await sendTemplateAndQueue(supabase, meeting, '1h');
      }

      if (sent) {
        await supabase
          .from('sales_meetings')
          .update({ reminder_1h_sent: true, updated_at: new Date().toISOString() })
          .eq('id', meeting.id);
      }
    }

    await expireOldReminders(supabase);
  } catch (err) {
    log.error('Meeting reminder processing failed', { error: err instanceof Error ? err.message : String(err) });
  }
}

export async function checkPendingReminders(
  supabase: SupabaseClient,
  contactId: string,
  conversationId: string
): Promise<void> {
  try {
    const { data: pending } = await supabase
      .from('meeting_reminder_queue')
      .select('id, meeting_id, reminder_type, meet_link, meeting_title, meeting_start_time')
      .eq('contact_id', contactId)
      .eq('status', 'pending_response')
      .order('created_at', { ascending: true })
      .limit(3);

    if (!pending || pending.length === 0) return;

    const { data: contact } = await supabase
      .from('whatsapp_contacts')
      .select('display_name, wa_id, phone_number')
      .eq('id', contactId)
      .maybeSingle();

    if (!contact) return;

    const waId = contact.wa_id || contact.phone_number || '';
    if (!waId) return;

    const persona = await getOrAssignPersona(supabase, conversationId, contactId);

    for (const reminder of pending) {
      const meetingTime = new Date(reminder.meeting_start_time).getTime();
      if (meetingTime < Date.now()) {
        await supabase
          .from('meeting_reminder_queue')
          .update({ status: 'expired' })
          .eq('id', reminder.id);
        continue;
      }

      const message = buildReminderMessage(
        contact.display_name || '',
        persona.full_name,
        reminder.meeting_title,
        reminder.meeting_start_time,
        reminder.meet_link || '',
        reminder.reminder_type as '24h' | '1h'
      );

      await setTypingIndicator(supabase, conversationId, true);
      await sleep(calculateDelay(message, false));
      await setTypingIndicator(supabase, conversationId, false);

      const result = await sendTextMessage(waId, message).catch((err) => {
        log.warn('Pending reminder send failed', { reminderId: reminder.id, error: err instanceof Error ? err.message : String(err) });
        return null;
      });

      if (result && result.success) {
        await recordOutbound(
          supabase,
          conversationId,
          contactId,
          result.messageId,
          message,
          persona.full_name,
          { meeting_reminder: true, reminder_type: reminder.reminder_type, meeting_id: reminder.meeting_id, from_queue: true }
        );

        await supabase
          .from('meeting_reminder_queue')
          .update({ status: 'sent', message_sent_at: new Date().toISOString() })
          .eq('id', reminder.id);

        log.info('Pending reminder delivered after client response', {
          reminderId: reminder.id,
          meetingId: reminder.meeting_id,
          reminderType: reminder.reminder_type,
          contact: contact.display_name,
        });
      }
    }
  } catch (err) {
    log.error('checkPendingReminders failed', { error: err instanceof Error ? err.message : String(err) });
  }
}

export async function handleMeetingConfirmation(
  supabase: SupabaseClient,
  contactId: string,
  conversationId: string,
  confirmed: boolean
): Promise<void> {
  try {
    const { data: meeting } = await supabase
      .from('sales_meetings')
      .select('id, title, start_time, meet_link, contact_id')
      .eq('contact_id', contactId)
      .eq('status', 'scheduled')
      .gt('start_time', new Date().toISOString())
      .order('start_time', { ascending: true })
      .limit(1)
      .maybeSingle();

    if (!meeting) return;

    await supabase
      .from('sales_meetings')
      .update({
        client_confirmed: confirmed,
        confirmed_at: new Date().toISOString(),
        status: confirmed ? 'scheduled' : 'cancelled',
        updated_at: new Date().toISOString(),
      })
      .eq('id', meeting.id);

    const { data: contact } = await supabase
      .from('whatsapp_contacts')
      .select('display_name, phone_number')
      .eq('id', contactId)
      .maybeSingle();

    const contactName = contact?.display_name || 'Desconocido';
    const contactPhone = contact?.phone_number || '';
    const timeStr = formatMeetingTime(meeting.start_time);

    if (confirmed) {
      notifyDirector({
        type: 'meeting_scheduled',
        contactName,
        details: `CONFIRMADO: ${contactName} confirmo asistencia a "${meeting.title}" - ${timeStr}`,
      }).catch(() => {});

      log.info('Meeting confirmed by client', { meetingId: meeting.id, contact: contactName });
    } else {
      notifyDirector({
        type: 'escalation',
        contactName,
        contactPhone,
        reason: `REUNION CANCELADA: ${contactName} cancelo la reunion "${meeting.title}" programada para ${timeStr}`,
      }).catch(() => {});

      log.info('Meeting cancelled by client', { meetingId: meeting.id, contact: contactName });
    }
  } catch (err) {
    log.error('handleMeetingConfirmation failed', { error: err instanceof Error ? err.message : String(err) });
  }
}

async function expireOldReminders(supabase: SupabaseClient): Promise<void> {
  const cutoff = new Date(Date.now() - PENDING_REMINDER_EXPIRY_MS).toISOString();

  await supabase
    .from('meeting_reminder_queue')
    .update({ status: 'expired' })
    .eq('status', 'pending_response')
    .lt('template_sent_at', cutoff);
}

export function detectMeetingConfirmation(text: string): 'confirmed' | 'cancelled' | null {
  const cleaned = text.trim().toLowerCase().replace(/[.!,;:]+$/g, '');

  const confirmPatterns = [
    /^(si|sí|yes|yep|sep|sip|claro|dale|vamos|listo|ok|okay|okey|perfecto|por supuesto|ahi estare|ahi estaremos|confirmado|confirmo|seguimos|seguro|cuenten conmigo|nos vemos)$/i,
    /seguimos en pie/i,
    /claro que si/i,
    /ahi estar/i,
    /si.*confirm/i,
    /confirm.*si/i,
    /vamos con todo/i,
    /cuenta con/i,
    /^si+$/i,
    /nos vemos/i,
  ];

  const cancelPatterns = [
    /no (puedo|podre|voy a poder|creo que pueda)/i,
    /cancela/i,
    /no va a ser posible/i,
    /no.*posible/i,
    /tengo.*compromiso/i,
    /surgio.*algo/i,
    /me salio.*algo/i,
    /no puedo asistir/i,
    /no creo.*poder/i,
    /mejor.*otro dia/i,
    /reprogramar/i,
    /reagendar/i,
    /cambiar.*fecha/i,
    /mover.*reunion/i,
    /postergar/i,
    /posponer/i,
  ];

  if (confirmPatterns.some((p) => p.test(cleaned))) return 'confirmed';
  if (cancelPatterns.some((p) => p.test(cleaned))) return 'cancelled';
  return null;
}

export async function hasUpcomingMeetingForContact(
  supabase: SupabaseClient,
  contactId: string
): Promise<boolean> {
  const { data } = await supabase
    .from('sales_meetings')
    .select('id')
    .eq('contact_id', contactId)
    .eq('status', 'scheduled')
    .gt('start_time', new Date().toISOString())
    .limit(1)
    .maybeSingle();

  return !!data;
}

export async function hasPendingReminderForContact(
  supabase: SupabaseClient,
  contactId: string
): Promise<boolean> {
  const { data } = await supabase
    .from('meeting_reminder_queue')
    .select('id')
    .eq('contact_id', contactId)
    .eq('status', 'pending_response')
    .limit(1)
    .maybeSingle();

  return !!data;
}
