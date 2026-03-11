import { SupabaseClient } from '@supabase/supabase-js';
import { config } from '../core/config.js';
import { createLogger } from '../core/logger.js';
import { getOrAssignPersona } from './persona-engine.js';
import { buildContext } from './context-builder.js';
import { decide, AgentAction } from './decision-engine.js';
import { calculateDelay, sleep, shouldSplitMessage } from './human-simulator.js';
import { sendTextMessage, setTypingIndicator } from '../services/whatsapp.js';
import { scheduleMeeting } from '../services/calendar.js';
import { joinMeeting } from '../services/recall.js';

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
    log.debug('Conversation already being processed, skipping', {
      conversationId: msg.conversationId,
    });
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
      .select('phone_number, wa_id')
      .eq('id', msg.contactId)
      .maybeSingle();

    if (!contact) {
      log.error('Contact not found', { contactId: msg.contactId });
      return;
    }

    const persona = await getOrAssignPersona(supabase, msg.conversationId);

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
      const chunks = shouldSplitMessage(decision.responseText);
      const recipientPhone = contact.wa_id || contact.phone_number;

      for (let i = 0; i < chunks.length; i++) {
        const delay = calculateDelay(chunks[i]);
        await setTypingIndicator(supabase, msg.conversationId, true);
        await sleep(delay);
        await setTypingIndicator(supabase, msg.conversationId, false);

        const result = await sendTextMessage(recipientPhone, chunks[i]);

        await recordOutbound(supabase, msg.conversationId, msg.contactId, result.messageId, chunks[i]);

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

async function recordOutbound(
  supabase: SupabaseClient,
  conversationId: string,
  contactId: string,
  waMessageId: string,
  content: string
) {
  await supabase.from('whatsapp_messages').insert({
    conversation_id: conversationId,
    contact_id: contactId,
    wa_message_id: waMessageId,
    direction: 'outbound',
    message_type: 'text',
    content,
    status: 'sent',
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
    priority: 'normal',
    status: 'open',
  });

  await supabase
    .from('whatsapp_conversations')
    .update({ agent_mode: 'manual', category: 'escalated' })
    .eq('id', conversationId);

  log.warn('Conversation escalated', { conversationId, reason });
}

async function executeActions(
  supabase: SupabaseClient,
  conversationId: string,
  contactId: string,
  actions: AgentAction[]
) {
  for (const action of actions) {
    try {
      switch (action.type) {
        case 'update_lead_stage':
          await supabase
            .from('whatsapp_contacts')
            .update({ lead_stage: action.params.stage })
            .eq('id', contactId);
          break;

        case 'add_note':
          await supabase
            .from('whatsapp_contacts')
            .update({
              notes: action.params.note,
            })
            .eq('id', contactId);
          break;

        case 'escalate':
          await handleEscalation(supabase, conversationId, contactId, action.params.reason);
          break;

        case 'schedule_meeting': {
          const contactData = await supabase
            .from('whatsapp_contacts')
            .select('display_name, email')
            .eq('id', contactId)
            .maybeSingle();

          const meeting = await scheduleMeeting(
            action.params.title || `Reunion Obzide - ${contactData?.data?.display_name || 'Cliente'}`,
            action.params.datetime,
            parseInt(action.params.duration || '30', 10),
            contactData?.data?.email || action.params.email
          );

          if (meeting) {
            await supabase.from('sales_meetings').insert({
              conversation_id: conversationId,
              contact_id: contactId,
              google_event_id: meeting.eventId,
              title: meeting.title,
              start_time: meeting.start,
              end_time: meeting.end,
              meet_link: meeting.meetLink,
              status: 'scheduled',
            });

            if (meeting.meetLink) {
              const botId = await joinMeeting(meeting.meetLink);
              if (botId) {
                await supabase
                  .from('sales_meetings')
                  .update({ recall_bot_id: botId })
                  .eq('google_event_id', meeting.eventId);
              }
            }

            log.info('Meeting scheduled and recorded', {
              eventId: meeting.eventId,
              meetLink: meeting.meetLink,
            });
          }
          break;
        }

        case 'create_crm_lead':
          log.info(`Action ${action.type} queued (integration pending)`, action.params);
          break;
      }
    } catch (err) {
      log.error(`Action ${action.type} failed`, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
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
