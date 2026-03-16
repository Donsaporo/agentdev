import { SupabaseClient } from '@supabase/supabase-js';
import { config } from '../core/config.js';
import { createLogger } from '../core/logger.js';
import { getOrAssignPersona } from './persona-engine.js';
import { buildContext } from './context-builder.js';
import { decide, AgentAction } from './decision-engine.js';
import { calculateDelay, sleep, shouldSplitMessage } from './human-simulator.js';
import { sanitizeResponse } from './response-sanitizer.js';
import { shouldSkipResponse, isFarewellMessage, markFarewellSent, clearFarewell } from './conversation-closer.js';
import { sendTextMessage, sendTemplateMessage, setTypingIndicator } from '../services/whatsapp.js';
import type { SendResult } from '../services/whatsapp.js';
import { notifyDirector } from '../services/director-notifier.js';
import { processMediaContent } from '../services/media-processor.js';
import { scheduleMeetingViaCrm, type CrmScheduleResult } from '../services/calendar.js';
import { joinMeeting } from '../services/recall.js';
import { addCrmClientInsight } from '../services/crm-postventa.js';
import * as crm from '../services/crm.js';
import { shouldSummarize, summarizeConversation, saveInsight } from '../services/conversation-summarizer.js';

const log = createLogger('conversation-manager');

const processingLock = new Set<string>();
const pendingMessages = new Map<string, { messages: IncomingMessage[]; timer: ReturnType<typeof setTimeout> }>();
const requeueCount = new Map<string, number>();
const MAX_REQUEUE = 3;

interface IncomingMessage {
  id: string;
  conversationId: string;
  contactId: string;
  content: string;
  messageType: string;
  mediaUrl?: string;
  mediaMimeType?: string;
}

export async function handleIncomingMessage(
  supabase: SupabaseClient,
  msg: IncomingMessage
): Promise<void> {
  const existing = pendingMessages.get(msg.conversationId);

  if (existing) {
    clearTimeout(existing.timer);
    existing.messages.push(msg);
    log.debug('Batching message', {
      conversationId: msg.conversationId,
      batchSize: existing.messages.length,
    });

    const extraDelay = config.agent.messageBatchExtraDelay * existing.messages.length;
    existing.timer = setTimeout(() => {
      processBatch(supabase, msg.conversationId);
    }, Math.min(extraDelay, 30_000));
    return;
  }

  pendingMessages.set(msg.conversationId, {
    messages: [msg],
    timer: setTimeout(() => {
      processBatch(supabase, msg.conversationId);
    }, config.agent.messageBatchWindow),
  });
}

async function processBatch(supabase: SupabaseClient, conversationId: string): Promise<void> {
  const batch = pendingMessages.get(conversationId);
  pendingMessages.delete(conversationId);

  if (!batch || batch.messages.length === 0) return;

  const mediaTypes = ['image', 'audio', 'document', 'video'];
  const enrichedContents: string[] = [];

  for (const m of batch.messages) {
    if (mediaTypes.includes(m.messageType)) {
      const { data: dbMsg } = await supabase
        .from('whatsapp_messages')
        .select('media_url, media_mime_type, media_local_path, media_download_status')
        .eq('id', m.id)
        .maybeSingle();

      const mediaId = dbMsg?.media_url || m.mediaUrl || '';
      const mimeType = dbMsg?.media_mime_type || m.mediaMimeType || '';
      const localPath = dbMsg?.media_local_path || '';
      const downloadStatus = dbMsg?.media_download_status || '';

      if (mediaId || localPath) {
        const enriched = await processMediaContent(m.messageType, mediaId, mimeType, localPath, downloadStatus);
        if (enriched) {
          enrichedContents.push(enriched);
          await supabase
            .from('whatsapp_messages')
            .update({ metadata: { media_description: enriched } })
            .eq('id', m.id);
          continue;
        }
      }
    }
    enrichedContents.push(m.content || `[${m.messageType}]`);
  }

  const combined: IncomingMessage = {
    id: batch.messages[batch.messages.length - 1].id,
    conversationId,
    contactId: batch.messages[0].contactId,
    content: enrichedContents.filter(Boolean).join('\n'),
    messageType: 'text',
  };

  if (batch.messages.length > 1) {
    log.info('Processing batched messages', {
      conversationId,
      count: batch.messages.length,
    });
  }

  await processMessage(supabase, combined);
}

async function processMessage(
  supabase: SupabaseClient,
  msg: IncomingMessage
): Promise<void> {
  if (processingLock.has(msg.conversationId)) {
    const count = (requeueCount.get(msg.conversationId) || 0) + 1;
    if (count > MAX_REQUEUE) {
      log.warn('Max requeue attempts reached, dropping message', {
        conversationId: msg.conversationId,
        attempts: count,
      });
      requeueCount.delete(msg.conversationId);
      return;
    }
    requeueCount.set(msg.conversationId, count);
    log.debug('Conversation already being processed, requeueing', {
      conversationId: msg.conversationId,
      attempt: count,
    });
    handleIncomingMessage(supabase, msg).catch(() => {});
    return;
  }

  processingLock.add(msg.conversationId);

  try {
    const { data: conversation } = await supabase
      .from('whatsapp_conversations')
      .select('agent_mode, contact_id')
      .eq('id', msg.conversationId)
      .maybeSingle();

    if (!conversation || conversation.agent_mode !== 'ai') {
      log.debug('Conversation not in AI mode, skipping', {
        conversationId: msg.conversationId,
        mode: conversation?.agent_mode,
      });
      return;
    }

    if (shouldSkipResponse(msg.conversationId, msg.content)) {
      return;
    }

    const { data: contact } = await supabase
      .from('whatsapp_contacts')
      .select('phone_number, wa_id, intro_sent, is_imported')
      .eq('id', msg.contactId)
      .maybeSingle();

    if (!contact) {
      log.error('Contact not found', { contactId: msg.contactId });
      return;
    }

    const persona = await getOrAssignPersona(supabase, msg.conversationId, msg.contactId);

    await supabase
      .from('whatsapp_contacts')
      .update({ follow_up_count: 0 })
      .eq('id', msg.contactId);

    const needsIntro = !contact.intro_sent && !contact.is_imported;
    if (needsIntro) {
      await sendIntroMessage(supabase, msg.conversationId, msg.contactId, contact.wa_id || contact.phone_number, persona);
    }

    const context = await buildContext(
      supabase,
      msg.conversationId,
      msg.contactId,
      msg.content,
      persona
    );

    const decision = await decide(context, msg.content);

    if (decision.shouldEscalate) {
      await handleEscalation(
        supabase,
        msg.conversationId,
        msg.contactId,
        decision.escalationReason
      );
    }

    if (decision.responseText) {
      const sanitized = sanitizeResponse(decision.responseText);

      if (sanitized.blocked) {
        log.warn('Response blocked by sanitizer', {
          conversationId: msg.conversationId,
          reason: sanitized.reason,
        });
        await handleEscalation(
          supabase,
          msg.conversationId,
          msg.contactId,
          `Respuesta bloqueada por filtro tecnico: ${sanitized.reason}`
        );
        return;
      }

      const actionResult = await executeActions(supabase, msg.conversationId, msg.contactId, decision.actions, persona.full_name);

      if (actionResult.messageSent) {
        await logAction(supabase, msg.conversationId, msg.contactId, persona.id, {
          type: 'send_message',
          input: msg.content,
          output: decision.responseText,
          reasoning: decision.reasoning + ' [response suppressed: action already sent message]',
          model: decision.model,
          inputTokens: decision.inputTokens,
          outputTokens: decision.outputTokens,
        });
        return;
      }

      const finalText = actionResult.meetingFailed
        ? actionResult.meetingFailureMessage
        : sanitized.text;

      const chunks = shouldSplitMessage(finalText);
      const recipientPhone = contact.wa_id || contact.phone_number;

      const { data: contactWindow } = await supabase
        .from('whatsapp_contacts')
        .select('last_inbound_at')
        .eq('id', msg.contactId)
        .maybeSingle();

      const lastInboundAt = contactWindow?.last_inbound_at
        ? new Date(contactWindow.last_inbound_at as string).getTime()
        : 0;
      const hoursSinceInbound = (Date.now() - lastInboundAt) / (1000 * 60 * 60);
      const windowOpen = hoursSinceInbound < 24;

      if (!windowOpen) {
        log.warn('Window closed before send, sending template directly', { conversationId: msg.conversationId });
        try {
          const tplResult = await sendTemplateMessage(recipientPhone, 'seguimiento_amigable', 'es_PA');
          if (tplResult.success) {
            await recordOutbound(supabase, msg.conversationId, msg.contactId, tplResult.messageId, '[Template: seguimiento_amigable]', persona.full_name);
          } else {
            throw new Error(tplResult.reason || 'Template send failed');
          }
        } catch (tplErr) {
          log.error('Template send failed (window closed)', { error: tplErr instanceof Error ? tplErr.message : String(tplErr) });
        }

        const failContact = await loadContactForCrm(supabase, msg.contactId);
        notifyDirector({
          type: 'send_failed',
          contactName: failContact?.display_name || 'Desconocido',
          contactPhone: failContact?.phone_number || recipientPhone,
          reason: `Ventana de 24h cerrada. Se envio template. Mensaje pendiente: "${sanitized.text.slice(0, 120)}"`,
        }).catch(() => {});
      } else {
        for (let i = 0; i < chunks.length; i++) {
          const isShort = chunks[i].split(/\s+/).length <= 5;
          const delay = calculateDelay(chunks[i], isShort);
          await setTypingIndicator(supabase, msg.conversationId, true);
          await sleep(delay);
          await setTypingIndicator(supabase, msg.conversationId, false);

          let result: SendResult;
          try {
            result = await sendTextMessage(recipientPhone, chunks[i]);
          } catch (sendErr) {
            log.error('Message send failed after retries', {
              conversationId: msg.conversationId,
              error: sendErr instanceof Error ? sendErr.message : String(sendErr),
            });
            await recordOutbound(supabase, msg.conversationId, msg.contactId, '', chunks[i], persona.full_name);
            await supabase
              .from('whatsapp_messages')
              .update({ status: 'failed' })
              .eq('conversation_id', msg.conversationId)
              .eq('content', chunks[i])
              .eq('direction', 'outbound');

            const failContact = await loadContactForCrm(supabase, msg.contactId);
            notifyDirector({
              type: 'escalation',
              contactName: failContact?.display_name || 'Desconocido',
              contactPhone: failContact?.phone_number || recipientPhone,
              reason: `Envio de mensaje fallo: ${sendErr instanceof Error ? sendErr.message : String(sendErr)}`,
            }).catch(() => {});
            break;
          }

          if (!result.success && result.reason === 'window_expired') {
            log.warn('Window expired mid-send, falling back to template', { conversationId: msg.conversationId });
            try {
              const tplResult = await sendTemplateMessage(recipientPhone, 'seguimiento_amigable', 'es_PA');
              if (tplResult.success) {
                await recordOutbound(supabase, msg.conversationId, msg.contactId, tplResult.messageId, '[Template: seguimiento_amigable]', persona.full_name);
              } else {
                throw new Error(tplResult.reason || 'Template send failed');
              }
            } catch (tplErr) {
              log.error('Template fallback also failed', { error: tplErr instanceof Error ? tplErr.message : String(tplErr) });
              const failContact = await loadContactForCrm(supabase, msg.contactId);
              notifyDirector({
                type: 'send_failed',
                contactName: failContact?.display_name || 'Desconocido',
                contactPhone: failContact?.phone_number || recipientPhone,
                reason: 'No se pudo enviar mensaje ni template (ventana de 24h cerrada)',
              }).catch(() => {});
            }
            break;
          }

          await recordOutbound(supabase, msg.conversationId, msg.contactId, result.messageId, chunks[i], persona.full_name);

          if (i < chunks.length - 1) {
            await sleep(4_000 + Math.random() * 6_000);
          }
        }
      }
    } else if (decision.actions.length > 0) {
      await executeActions(supabase, msg.conversationId, msg.contactId, decision.actions, persona.full_name);
    }

    await logAction(supabase, msg.conversationId, msg.contactId, persona.id, {
      type: 'send_message',
      input: msg.content,
      output: decision.responseText,
      reasoning: decision.reasoning,
      model: decision.model,
      inputTokens: decision.inputTokens,
      outputTokens: decision.outputTokens,
    });

    if (isFarewellMessage(msg.content) && decision.responseText) {
      markFarewellSent(msg.conversationId);
    } else if (!isFarewellMessage(msg.content)) {
      clearFarewell(msg.conversationId);
    }

    await autoSyncToCrm(supabase, msg.contactId, persona.full_name).catch((err) => {
      log.warn('Auto CRM sync failed (non-blocking)', { error: err instanceof Error ? err.message : String(err) });
    });

    triggerAutoSummary(supabase, msg.conversationId, msg.contactId).catch((err) => {
      log.warn('Auto summary failed (non-blocking)', { error: err instanceof Error ? err.message : String(err) });
    });

    log.info('Message handled', {
      conversation: msg.conversationId,
      persona: persona.full_name,
      responseLength: decision.responseText.length,
      actions: decision.actions.length,
      escalated: decision.shouldEscalate,
    });
  } catch (err) {
    log.error('Failed to handle message', {
      conversationId: msg.conversationId,
      error: err instanceof Error ? err.message : String(err),
    });
  } finally {
    processingLock.delete(msg.conversationId);
    requeueCount.delete(msg.conversationId);
    await setTypingIndicator(supabase, msg.conversationId, false).catch(() => {});
  }
}

async function sendIntroMessage(
  supabase: SupabaseClient,
  conversationId: string,
  contactId: string,
  recipientPhone: string,
  persona: { full_name: string; first_name: string }
) {
  try {
    const introText = `Hola, gracias por comunicarte con Obzide Tech. Te voy a comunicar con ${persona.first_name}, quien te va a atender. Un momento por favor.`;

    await setTypingIndicator(supabase, conversationId, true);
    await sleep(5_000 + Math.random() * 5_000);
    await setTypingIndicator(supabase, conversationId, false);

    const result = await sendTextMessage(recipientPhone, introText);
    await recordOutbound(supabase, conversationId, contactId, result.messageId, introText, 'Obzide Tech');

    await supabase
      .from('whatsapp_contacts')
      .update({ intro_sent: true })
      .eq('id', contactId);

    await sleep(8_000 + Math.random() * 7_000);

    log.info('Intro message sent', { conversationId, persona: persona.full_name });
  } catch (err) {
    log.warn('Failed to send intro message', { error: err instanceof Error ? err.message : String(err) });
    await supabase
      .from('whatsapp_contacts')
      .update({ intro_sent: true })
      .eq('id', contactId);
  }
}

async function recordOutbound(
  supabase: SupabaseClient,
  conversationId: string,
  contactId: string,
  waMessageId: string,
  content: string,
  senderName: string
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
    metadata: { sent_by: 'sales_agent' },
  });

  await supabase
    .from('whatsapp_conversations')
    .update({
      last_message_at: new Date().toISOString(),
      last_message_preview: content.slice(0, 100),
    })
    .eq('id', conversationId);

  await supabase
    .from('whatsapp_contacts')
    .update({ last_message_direction: 'outbound' })
    .eq('id', contactId);
}

async function handleEscalation(
  supabase: SupabaseClient,
  conversationId: string,
  contactId: string,
  reason: string
) {
  await supabase.from('sales_escalation_queue').insert({
    conversation_id: conversationId,
    contact_id: contactId,
    reason,
    priority: 'high',
    status: 'open',
  });

  await supabase
    .from('whatsapp_conversations')
    .update({
      agent_mode: 'manual',
      category: 'escalated',
      needs_director_attention: true,
      priority_score: 100,
    })
    .eq('id', conversationId);

  const escContact = await loadContactForCrm(supabase, contactId);
  if (escContact?.crm_client_id) {
    await crm.addTimelineEvent({
      clientId: escContact.crm_client_id,
      eventType: 'otro',
      title: 'Conversacion escalada a humano',
      description: reason,
      metadata: { conversation_id: conversationId },
    }).catch(() => {});
  }

  await sendEscalationEmail(supabase, conversationId, contactId, reason).catch((err) => {
    log.warn('Failed to send escalation email', { error: err instanceof Error ? err.message : String(err) });
  });

  const escContactForNotify = await loadContactForCrm(supabase, contactId);
  notifyDirector({
    type: 'escalation',
    contactName: escContactForNotify?.display_name || 'Desconocido',
    contactPhone: escContactForNotify?.phone_number || '',
    reason,
  }).catch((err) => {
    log.warn('Failed to notify director via WhatsApp', { error: err instanceof Error ? err.message : String(err) });
  });

  log.warn('Conversation escalated', { conversationId, reason });
}

async function sendEscalationEmail(
  supabase: SupabaseClient,
  conversationId: string,
  contactId: string,
  reason: string
) {
  const { data: contact } = await supabase
    .from('whatsapp_contacts')
    .select('display_name, phone_number')
    .eq('id', contactId)
    .maybeSingle();

  const supabaseUrl = config.escalation.supabaseUrl || config.supabase.url;
  const anonKey = config.escalation.supabaseAnonKey;

  if (!anonKey) {
    log.warn('Cannot send escalation email: missing SUPABASE_ANON_KEY');
    return;
  }

  const response = await fetch(`${supabaseUrl}/functions/v1/send-escalation-email`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${anonKey}`,
    },
    body: JSON.stringify({
      to: config.escalation.emailTo,
      contactName: contact?.display_name || 'Desconocido',
      contactPhone: contact?.phone_number || '',
      conversationId,
      reason,
    }),
  });

  if (!response.ok) {
    log.warn('Escalation email request failed', { status: response.status });
  }
}

async function executeActions(
  supabase: SupabaseClient,
  conversationId: string,
  contactId: string,
  actions: AgentAction[],
  personaName = 'Sales Agent'
): Promise<{ messageSent: boolean; meetingFailed: boolean; meetingFailureMessage: string }> {
  let messageSent = false;
  let meetingFailed = false;
  let meetingFailureMessage = '';
  let cachedContact: Awaited<ReturnType<typeof loadContactForCrm>> = null;

  async function getContact() {
    if (!cachedContact) {
      cachedContact = await loadContactForCrm(supabase, contactId);
    }
    return cachedContact;
  }

  for (const action of actions) {
    try {
      switch (action.type) {
        case 'update_lead_stage': {
          await supabase
            .from('whatsapp_contacts')
            .update({ lead_stage: action.params.stage })
            .eq('id', contactId);

          const contact = await getContact();
          if (contact?.crm_client_id) {
            await crm.syncStageToCrm(contact.crm_client_id, action.params.stage, personaName);
          }

          if (action.params.stage === 'ganado' || action.params.stage === 'perdido') {
            notifyDirector({
              type: action.params.stage === 'ganado' ? 'lead_won' : 'lead_lost',
              contactName: contact?.display_name || 'Desconocido',
              contactPhone: contact?.phone_number || '',
              reason: action.params.stage === 'perdido' ? (action.params.reason || 'Sin especificar') : undefined,
              details: action.params.stage === 'ganado' ? (action.params.details || '') : undefined,
            }).catch(() => {});
          }
          break;
        }

        case 'add_note': {
          const { data: current } = await supabase
            .from('whatsapp_contacts')
            .select('notes')
            .eq('id', contactId)
            .maybeSingle();

          const existingNotes = current?.notes || '';
          const timestamp = new Date().toLocaleDateString('es-PA', { day: '2-digit', month: '2-digit', year: '2-digit' });
          const newNotes = existingNotes
            ? `${existingNotes}\n[${timestamp}] ${action.params.note}`
            : `[${timestamp}] ${action.params.note}`;

          await supabase
            .from('whatsapp_contacts')
            .update({ notes: newNotes })
            .eq('id', contactId);
          break;
        }

        case 'update_client_profile': {
          const field = action.params.field;
          const value = action.params.value;
          const allowedFields = ['email', 'company', 'industry', 'estimated_budget', 'source', 'display_name'];

          if (!allowedFields.includes(field) || !value) break;

          const contactFields = ['email', 'company', 'display_name'];
          if (contactFields.includes(field)) {
            await supabase
              .from('whatsapp_contacts')
              .update({ [field]: value })
              .eq('id', contactId);
            cachedContact = null;
          }

          const { data: contactData } = await supabase
            .from('whatsapp_contacts')
            .select('client_profile_id')
            .eq('id', contactId)
            .maybeSingle();

          if (contactData?.client_profile_id) {
            await supabase
              .from('client_profiles')
              .update({ [field]: value, updated_at: new Date().toISOString() })
              .eq('id', contactData.client_profile_id);
          } else {
            const { data: profile } = await supabase
              .from('client_profiles')
              .insert({
                display_name: (await getContact())?.display_name || '',
                [field]: value,
              })
              .select('id')
              .single();

            if (profile) {
              await supabase
                .from('whatsapp_contacts')
                .update({ client_profile_id: profile.id })
                .eq('id', contactId);
            }
          }
          break;
        }

        case 'escalate':
          await handleEscalation(supabase, conversationId, contactId, action.params.reason);
          break;

        case 'schedule_meeting': {
          const contactData = await supabase
            .from('whatsapp_contacts')
            .select('display_name, email, wa_id, phone_number')
            .eq('id', contactId)
            .maybeSingle();

          const phone = contactData?.data?.wa_id || contactData?.data?.phone_number || '';

          let meetingDate = action.params.date || '';
          let startTime = action.params.start_time || '';
          let endTime = action.params.end_time || '';

          if (!meetingDate && action.params.datetime) {
            const dt = new Date(action.params.datetime);
            if (!isNaN(dt.getTime())) {
              meetingDate = dt.toLocaleDateString('en-CA', { timeZone: 'America/Panama' });
              startTime = dt.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Panama' });
              const dur = parseInt(action.params.duration || '30', 10);
              const endDt = new Date(dt.getTime() + dur * 60_000);
              endTime = endDt.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Panama' });
            }
          }

          if (!meetingDate || !startTime || !endTime || !phone) {
            log.warn('Missing scheduling params', { meetingDate, startTime, endTime, phone });
            meetingFailed = true;
            meetingFailureMessage = 'Me faltan algunos datos para agendar la reunion. Me puedes confirmar la fecha y hora que prefieres?';
            break;
          }

          const isPresencial = action.params.meeting_type === 'presencial';

          const crmResult: CrmScheduleResult = await scheduleMeetingViaCrm({
            phoneNumber: phone,
            title: action.params.title || `Reunion Obzide - ${contactData?.data?.display_name || 'Cliente'}`,
            date: meetingDate,
            startTime,
            endTime,
            meetingType: isPresencial ? 'presencial' : 'virtual',
            description: action.params.description,
            attendees: contactData?.data?.email ? [contactData.data.email] : undefined,
          });

          if (!crmResult.success) {
            log.warn('CRM scheduling failed', {
              reason: crmResult.reason,
              conflicts: crmResult.conflicts?.length,
            });

            meetingFailed = true;

            if (crmResult.reason === 'schedule_conflict' && crmResult.conflicts) {
              const conflictLines = crmResult.conflicts.map((c) => `- ${c.label}: ${c.time_range}`);
              meetingFailureMessage = `Ese horario no esta disponible.\n\n${conflictLines.join('\n')}\n\nTe parece otro horario?`;
            } else if (crmResult.reason === 'no_client_found') {
              meetingFailureMessage = crmResult.message || 'No encontre tu registro en el sistema. Me puedes confirmar tu nombre y telefono?';
            } else {
              meetingFailureMessage = crmResult.message || 'No pude agendar la reunion en este momento. Dejame verificar la disponibilidad y te confirmo.';
            }
            break;
          }

          let recallBotId: string | null = null;
          if (crmResult.meetLink) {
            recallBotId = await joinMeeting(crmResult.meetLink).catch((err) => {
              log.warn('Failed to launch Recall bot', { error: err instanceof Error ? err.message : String(err) });
              return null;
            });
          }

          const startIso = crmResult.scheduled
            ? new Date(`${crmResult.scheduled.date}T${crmResult.scheduled.start_time}:00-05:00`).toISOString()
            : new Date().toISOString();
          const endIso = crmResult.scheduled
            ? new Date(`${crmResult.scheduled.date}T${crmResult.scheduled.end_time}:00-05:00`).toISOString()
            : new Date().toISOString();

          await supabase.from('sales_meetings').insert({
            conversation_id: conversationId,
            contact_id: contactId,
            google_event_id: crmResult.googleEventId || null,
            title: action.params.title || `Reunion Obzide - ${contactData?.data?.display_name || 'Cliente'}`,
            start_time: startIso,
            end_time: endIso,
            meet_link: crmResult.meetLink || null,
            recall_bot_id: recallBotId,
            status: 'scheduled',
          });

          const meetContact = await getContact();
          notifyDirector({
            type: 'meeting_scheduled',
            contactName: meetContact?.display_name || contactData?.data?.display_name || 'Desconocido',
            details: `${action.params.title || 'Reunion Obzide'}\n${isPresencial ? 'Presencial - PH Plaza Real' : `Virtual: ${crmResult.meetLink}`}\nFecha: ${meetingDate} ${startTime}-${endTime}`,
          }).catch(() => {});

          log.info('Meeting scheduled via CRM and recorded', {
            meetingId: crmResult.meetingId,
            googleEventId: crmResult.googleEventId,
            meetLink: crmResult.meetLink,
            type: isPresencial ? 'presencial' : 'virtual',
            recallBotId,
          });
          break;
        }

        case 'create_crm_lead': {
          const contact = await getContact();
          if (contact?.crm_client_id) {
            log.info('Contact already linked to CRM', { contactId });
            break;
          }

          const clientId = await crm.syncContactToCrm({
            phone_number: contact?.phone_number || action.params.phone || '',
            display_name: contact?.display_name || action.params.name || '',
            profile_name: contact?.profile_name || '',
            email: contact?.email || action.params.email,
            company: contact?.company || action.params.company,
            notes: contact?.notes,
          }, personaName);

          if (clientId) {
            await supabase
              .from('whatsapp_contacts')
              .update({ crm_client_id: clientId })
              .eq('id', contactId);
            cachedContact = null;
            log.info('CRM lead created and linked', { contactId, crmClientId: clientId });
          }
          break;
        }

        case 'sync_to_crm': {
          const contact = await getContact();
          if (!contact) break;

          const syncClientId = await crm.syncContactToCrm({
            phone_number: contact.phone_number || '',
            display_name: contact.display_name || '',
            profile_name: contact.profile_name || '',
            email: contact.email,
            company: contact.company,
            notes: contact.notes,
          }, personaName);

          if (syncClientId && !contact.crm_client_id) {
            await supabase
              .from('whatsapp_contacts')
              .update({ crm_client_id: syncClientId })
              .eq('id', contactId);
            cachedContact = null;
          }
          break;
        }

        case 'add_crm_comment': {
          const contact = await getContact();
          if (contact?.crm_client_id && action.params.comment) {
            await crm.addComment(contact.crm_client_id, action.params.comment);
          }
          break;
        }

        case 'save_insight': {
          const validCategories = [
            'need', 'objection', 'preference', 'budget', 'timeline',
            'decision_maker', 'competitor', 'pain_point', 'positive_signal', 'personal_detail',
          ];
          if (action.params.category && validCategories.includes(action.params.category) && action.params.content) {
            await saveInsight(
              supabase,
              contactId,
              conversationId,
              action.params.category,
              action.params.content,
              action.params.confidence || 'high'
            );

            const insightContact = await getContact();
            if (insightContact?.crm_client_id) {
              const confidenceMap: Record<string, number> = { high: 0.9, medium: 0.7, low: 0.4 };
              addCrmClientInsight(insightContact.crm_client_id, {
                sourceType: 'whatsapp',
                insightType: action.params.category,
                title: action.params.category.replace(/_/g, ' '),
                content: action.params.content,
                confidence: confidenceMap[action.params.confidence || 'high'] || 0.7,
              }).catch(() => {});
            }
          }
          break;
        }

        case 'request_project_update': {
          const contact = await getContact();
          if (contact?.crm_client_id) {
            const comment = `[SOLICITUD DE ACTUALIZACION] Cliente pregunta sobre: ${action.params.project_name || 'su proyecto'}. Pregunta: ${action.params.question || 'Estado general del proyecto'}`;
            await crm.addComment(contact.crm_client_id, comment);
            await crm.addTimelineEvent({
              clientId: contact.crm_client_id,
              eventType: 'otro',
              title: 'Cliente solicita actualizacion de proyecto via WhatsApp',
              description: action.params.question || 'Estado general del proyecto',
              metadata: { conversation_id: conversationId, project_name: action.params.project_name },
            });
          }
          const updateContact = await getContact();
          notifyDirector({
            type: 'escalation',
            contactName: updateContact?.display_name || 'Desconocido',
            contactPhone: updateContact?.phone_number || '',
            reason: `Cliente necesita actualizacion de proyecto: ${action.params.project_name || 'N/A'}. Pregunta: ${action.params.question || 'Estado general'}`,
          }).catch(() => {});
          break;
        }

        case 'report_issue': {
          const contact = await getContact();
          const severity = action.params.severity || 'medium';
          const description = action.params.description || 'Problema reportado sin descripcion';

          if (contact?.crm_client_id) {
            const comment = `[REPORTE DE PROBLEMA - ${severity.toUpperCase()}] ${description}`;
            await crm.addComment(contact.crm_client_id, comment);
            await crm.addTimelineEvent({
              clientId: contact.crm_client_id,
              eventType: 'otro',
              title: `Bug/problema reportado por cliente (${severity})`,
              description,
              metadata: { conversation_id: conversationId, severity, source: 'whatsapp' },
            });
          }

          const issueContact = await getContact();
          notifyDirector({
            type: 'escalation',
            contactName: issueContact?.display_name || 'Desconocido',
            contactPhone: issueContact?.phone_number || '',
            reason: `[BUG ${severity.toUpperCase()}] ${description}`,
          }).catch(() => {});

          if (severity === 'high') {
            await handleEscalation(supabase, conversationId, contactId, `Problema critico reportado: ${description}`);
          }
          break;
        }

        case 'manage_client_task': {
          const contact = await getContact();
          const phone = contact?.phone_number || '';
          if (!phone) break;

          const crmUrl = config.crm.url;
          const crmKey = config.crm.serviceRoleKey;
          if (!crmUrl || !crmKey) {
            log.warn('CRM not configured for task management');
            break;
          }

          try {
            const taskRes = await fetch(`${crmUrl}/functions/v1/update-task-from-whatsapp`, {
              method: 'POST',
              headers: {
                Authorization: `Bearer ${crmKey}`,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({
                phone_number: phone,
                message: action.params.message || action.params.action || '',
              }),
            });

            if (taskRes.ok) {
              const result = await taskRes.json();
              log.info('Client task action completed', {
                contactId,
                replySuggestion: result.reply_suggestion?.slice(0, 100),
              });
            } else {
              log.warn('CRM task endpoint failed', { status: taskRes.status });
            }
          } catch (taskErr) {
            log.error('manage_client_task failed', {
              error: taskErr instanceof Error ? taskErr.message : String(taskErr),
            });
          }
          break;
        }
      }
    } catch (err) {
      log.error(`Action ${action.type} failed`, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { messageSent, meetingFailed, meetingFailureMessage };
}

async function autoSyncToCrm(supabase: SupabaseClient, contactId: string, personaName: string) {
  const contact = await loadContactForCrm(supabase, contactId);
  if (!contact || contact.crm_client_id) return;

  const hasName = !!(contact.display_name || contact.profile_name);
  if (!hasName) return;

  const clientId = await crm.syncContactToCrm({
    phone_number: contact.phone_number || '',
    display_name: contact.display_name || '',
    profile_name: contact.profile_name || '',
    email: contact.email,
    company: contact.company,
    notes: contact.notes,
  }, personaName);

  if (clientId) {
    await supabase
      .from('whatsapp_contacts')
      .update({ crm_client_id: clientId })
      .eq('id', contactId);

    log.info('Auto-synced contact to CRM', { contactId, crmClientId: clientId });
  }
}

async function loadContactForCrm(supabase: SupabaseClient, contactId: string) {
  const { data } = await supabase
    .from('whatsapp_contacts')
    .select('phone_number, display_name, profile_name, email, company, notes, crm_client_id, client_profile_id, follow_up_count')
    .eq('id', contactId)
    .maybeSingle();
  return data;
}

async function triggerAutoSummary(
  supabase: SupabaseClient,
  conversationId: string,
  contactId: string
): Promise<void> {
  const needsSummary = await shouldSummarize(supabase, conversationId);
  if (!needsSummary) return;

  log.info('Auto-summarizing conversation', { conversationId });
  await summarizeConversation(supabase, conversationId, contactId);
}

async function logAction(
  supabase: SupabaseClient,
  conversationId: string,
  contactId: string,
  personaId: string,
  details: {
    type: string;
    input: string;
    output: string;
    reasoning: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
  }
) {
  await supabase.from('sales_agent_actions_log').insert({
    conversation_id: conversationId,
    contact_id: contactId,
    persona_id: personaId,
    action_type: details.type,
    input_summary: details.input.slice(0, 500),
    output_summary: details.output.slice(0, 500),
    model_used: details.model,
    tokens_input: details.inputTokens,
    tokens_output: details.outputTokens,
    metadata: { reasoning: details.reasoning },
  });
}
