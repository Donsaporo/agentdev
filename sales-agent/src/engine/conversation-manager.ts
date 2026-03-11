import { SupabaseClient } from '@supabase/supabase-js';
import { createLogger } from '../core/logger.js';
import { getOrAssignPersona } from './persona-engine.js';
import { buildContext } from './context-builder.js';
import { decide, AgentAction } from './decision-engine.js';
import { calculateDelay, sleep, shouldSplitMessage } from './human-simulator.js';
import { sendTextMessage, setTypingIndicator } from '../services/whatsapp.js';

const log = createLogger('conversation-manager');

const processingLock = new Set<string>();

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
          await sleep(800 + Math.random() * 1200);
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

        case 'schedule_meeting':
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
    input_data: { message: details.input },
    output_data: { response: details.output, reasoning: details.reasoning },
    model_used: details.model,
    input_tokens: details.inputTokens,
    output_tokens: details.outputTokens,
  });
}
