import { SupabaseClient } from '@supabase/supabase-js';
import { config } from '../core/config.js';
import { createLogger } from '../core/logger.js';
import { getOrAssignPersona } from './persona-engine.js';
import { buildContext } from './context-builder.js';
import { decide, AgentAction } from './decision-engine.js';
import { calculateDelay, sleep, shouldSplitMessage } from './human-simulator.js';
import { sanitizeResponse } from './response-sanitizer.js';
import { sendTextMessage, setTypingIndicator } from '../services/whatsapp.js';
import { scheduleMeeting } from '../services/calendar.js';
import { joinMeeting } from '../services/recall.js';
import * as crm from '../services/crm.js';

const log = createLogger('conversation-manager');

const processingLock = new Set<string>();
const pendingMessages = new Map<string, { messages: IncomingMessage[]; timer: ReturnType<typeof setTimeout> }>();

interface IncomingMessage {
  id: string;
  conversationId: string;
  contactId: string;
  content: string;
  messageType: string;
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

  const combined: IncomingMessage = {
    id: batch.messages[batch.messages.length - 1].id,
    conversationId,
    contactId: batch.messages[0].contactId,
    content: batch.messages.map((m) => m.content).filter(Boolean).join('\n'),
    messageType: batch.messages[0].messageType,
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
    log.debug('Conversation already being processed, requeueing', {
      conversationId: msg.conversationId,
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

    await executeActions(supabase, msg.conversationId, msg.contactId, decision.actions);

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
      }

      const chunks = shouldSplitMessage(sanitized.text);
      const recipientPhone = contact.wa_id || contact.phone_number;

      for (let i = 0; i < chunks.length; i++) {
        const isShort = chunks[i].split(/\s+/).length <= 5;
        const delay = calculateDelay(chunks[i], isShort);
        await setTypingIndicator(supabase, msg.conversationId, true);
        await sleep(delay);
        await setTypingIndicator(supabase, msg.conversationId, false);

        const result = await sendTextMessage(recipientPhone, chunks[i]);
        await recordOutbound(supabase, msg.conversationId, msg.contactId, result.messageId, chunks[i], persona.full_name);

        if (i < chunks.length - 1) {
          await sleep(1_500 + Math.random() * 3_000);
        }
      }
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

    await autoSyncToCrm(supabase, msg.contactId, persona.full_name).catch((err) => {
      log.warn('Auto CRM sync failed (non-blocking)', { error: err instanceof Error ? err.message : String(err) });
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
    await sleep(2_000 + Math.random() * 2_000);
    await setTypingIndicator(supabase, conversationId, false);

    const result = await sendTextMessage(recipientPhone, introText);
    await recordOutbound(supabase, conversationId, contactId, result.messageId, introText, 'Obzide Tech');

    await supabase
      .from('whatsapp_contacts')
      .update({ intro_sent: true })
      .eq('id', contactId);

    await sleep(3_000 + Math.random() * 5_000);

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
  actions: AgentAction[]
) {
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
            await crm.syncStageToCrm(contact.crm_client_id, action.params.stage, 'Sales Agent');
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
          if (!action.params.datetime || isNaN(new Date(action.params.datetime).getTime())) {
            log.warn('Invalid or missing datetime for schedule_meeting', { datetime: action.params.datetime });
            break;
          }

          const contactData = await supabase
            .from('whatsapp_contacts')
            .select('display_name, email')
            .eq('id', contactId)
            .maybeSingle();

          const isPresencial = action.params.meeting_type === 'presencial';

          const meeting = await scheduleMeeting(
            action.params.title || `Reunion Obzide - ${contactData?.data?.display_name || 'Cliente'}`,
            action.params.datetime,
            parseInt(action.params.duration || '30', 10),
            contactData?.data?.email || action.params.email,
            isPresencial
          );

          if (meeting) {
            let recallBotId: string | null = null;
            if (meeting.meetLink) {
              recallBotId = await joinMeeting(meeting.meetLink).catch((err) => {
                log.warn('Failed to launch Recall bot', { error: err instanceof Error ? err.message : String(err) });
                return null;
              });
            }

            await supabase.from('sales_meetings').insert({
              conversation_id: conversationId,
              contact_id: contactId,
              google_event_id: meeting.eventId,
              title: meeting.title,
              start_time: meeting.start,
              end_time: meeting.end,
              meet_link: meeting.meetLink || null,
              recall_bot_id: recallBotId,
              status: 'scheduled',
            });

            const meetingContact = await getContact();
            if (meetingContact?.crm_client_id) {
              await crm.addMeeting({
                clientId: meetingContact.crm_client_id,
                title: meeting.title,
                startTime: meeting.start,
                endTime: meeting.end,
                meetLink: meeting.meetLink,
                googleEventId: meeting.eventId,
                meetingType: isPresencial ? 'presencial' : 'virtual',
              });
              await crm.addTimelineEvent({
                clientId: meetingContact.crm_client_id,
                eventType: 'reunion_programada',
                title: `Reunion agendada: ${meeting.title}`,
                description: isPresencial
                  ? 'Reunion presencial en PH Plaza Real, Costa del Este, Panama'
                  : `Google Meet: ${meeting.meetLink}`,
                metadata: { google_event_id: meeting.eventId, recall_bot_id: recallBotId, meeting_type: isPresencial ? 'presencial' : 'virtual', source: 'whatsapp_sales_agent' },
              });
            }

            log.info('Meeting scheduled and recorded', {
              eventId: meeting.eventId,
              meetLink: meeting.meetLink,
              type: isPresencial ? 'presencial' : 'virtual',
              recallBotId,
            });
          }
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
          }, 'Sales Agent');

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
          }, 'Sales Agent');

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
      }
    } catch (err) {
      log.error(`Action ${action.type} failed`, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
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
