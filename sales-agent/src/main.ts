import { config } from './core/config.js';
import { createLogger } from './core/logger.js';
import { getSupabase } from './core/supabase.js';
import { handleIncomingMessage } from './engine/conversation-manager.js';
import { isDirectorPhone, handleDirectorCommand } from './engine/director-commands.js';
import { loadPersonas, getOrAssignPersona } from './engine/persona-engine.js';
import { invalidateInstructionsCache } from './engine/knowledge-search.js';
import { sendTextMessage, setTypingIndicator } from './services/whatsapp.js';
import { callClaude } from './services/claude.js';
import { calculateDelay, sleep } from './engine/human-simulator.js';

const log = createLogger('main');

let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let followUpTimer: ReturnType<typeof setInterval> | null = null;
let realtimeChannel: ReturnType<ReturnType<typeof getSupabase>['channel']> | null = null;
let instructionsChannel: ReturnType<ReturnType<typeof getSupabase>['channel']> | null = null;

async function updateHeartbeat(supabase: ReturnType<typeof getSupabase>) {
  await supabase.from('sales_agent_heartbeat').upsert(
    {
      id: 'sales-agent',
      status: 'online',
      last_seen: new Date().toISOString(),
      version: '1.0.0',
    },
    { onConflict: 'id' }
  );
}

async function setOffline(supabase: ReturnType<typeof getSupabase>) {
  await supabase
    .from('sales_agent_heartbeat')
    .update({ status: 'offline', last_seen: new Date().toISOString() })
    .eq('id', 'sales-agent');
}

async function routeMessage(supabase: ReturnType<typeof getSupabase>, msg: Record<string, string>) {
  if (config.director.phones.length > 0) {
    const { data: contact } = await supabase
      .from('whatsapp_contacts')
      .select('wa_id')
      .eq('id', msg.contact_id)
      .maybeSingle();

    if (contact?.wa_id && isDirectorPhone(contact.wa_id, config.director.phones)) {
      log.info('Director message detected, routing to command handler', { waId: contact.wa_id });
      await handleDirectorCommand(supabase, {
        conversationId: msg.conversation_id,
        contactId: msg.contact_id,
        content: msg.content || '',
        directorWaId: contact.wa_id,
      });
      return;
    }
  }

  await handleIncomingMessage(supabase, {
    id: msg.id,
    conversationId: msg.conversation_id,
    contactId: msg.contact_id,
    content: msg.content || '',
    messageType: msg.message_type || 'text',
  });
}

function subscribeToMessages(supabase: ReturnType<typeof getSupabase>) {
  realtimeChannel = supabase
    .channel('sales-agent-messages')
    .on(
      'postgres_changes',
      {
        event: 'INSERT',
        schema: 'public',
        table: 'whatsapp_messages',
        filter: 'direction=eq.inbound',
      },
      (payload) => {
        const msg = payload.new as Record<string, string>;
        log.info('New inbound message detected', {
          conversationId: msg.conversation_id,
          type: msg.message_type,
        });

        routeMessage(supabase, msg).catch((err) => {
          log.error('Message handling failed', {
            error: err instanceof Error ? err.message : String(err),
          });
        });
      }
    )
    .subscribe((status) => {
      log.info('Realtime subscription status', { status });
    });
}

function subscribeToInstructions(supabase: ReturnType<typeof getSupabase>) {
  instructionsChannel = supabase
    .channel('sales-agent-instructions')
    .on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: 'sales_agent_instructions',
      },
      () => {
        log.info('Instructions changed, invalidating cache');
        invalidateInstructionsCache();
      }
    )
    .subscribe();
}

const FOLLOW_UP_INTERVAL = 30 * 60_000;
const FOLLOW_UP_AFTER_HOURS = 24;
const MAX_FOLLOW_UPS = 2;

async function generateFollowUpMessage(
  contactName: string,
  personaName: string,
  lastMessages: string[],
  followUpNumber: number
): Promise<string> {
  const isLast = followUpNumber >= MAX_FOLLOW_UPS;
  const prompt = `Eres ${personaName}, ejecutiva de ventas de Obzide Tech. Genera un mensaje de seguimiento de WhatsApp para ${contactName || 'el cliente'}.

Este es el seguimiento #${followUpNumber} de maximo ${MAX_FOLLOW_UPS}.
${isLast ? 'Este es el ULTIMO seguimiento. Si no responde, el lead se marcara como perdido.' : ''}

Ultimos mensajes de la conversacion:
${lastMessages.slice(-5).join('\n')}

Reglas:
- Mensaje CORTO (1-2 oraciones max)
- Natural, como un humano en WhatsApp
- NO repitas el mismo enfoque que mensajes anteriores
- ${isLast ? 'Hazlo de forma que dejes la puerta abierta para el futuro, pero sin ser insistente' : 'Se amigable y ofrece valor, no solo preguntes si esta interesado'}
- NO uses emojis excesivos
- NO uses markdown ni asteriscos

Responde SOLO con el texto del mensaje, nada mas.`;

  const response = await callClaude(prompt, [{ role: 'user', content: 'Genera el mensaje de seguimiento.' }], {
    maxTokens: 200,
    temperature: 0.8,
  });

  return response.text.trim().replace(/^["']|["']$/g, '');
}

async function processFollowUps(supabase: ReturnType<typeof getSupabase>) {
  try {
    const cutoff = new Date(Date.now() - FOLLOW_UP_AFTER_HOURS * 60 * 60_000).toISOString();

    const { data: staleConversations } = await supabase
      .from('whatsapp_conversations')
      .select('id, contact_id, last_message_at, contact:whatsapp_contacts(id, display_name, phone_number, wa_id, lead_stage, notes, follow_up_count)')
      .eq('agent_mode', 'ai')
      .eq('status', 'active')
      .in('category', ['new_lead', 'active_client'])
      .lt('last_message_at', cutoff)
      .order('last_message_at', { ascending: true })
      .limit(5);

    if (!staleConversations || staleConversations.length === 0) return;

    for (const conv of staleConversations) {
      const contact = conv.contact as Record<string, string | number> | null;
      if (!contact) continue;

      const stage = String(contact.lead_stage || 'nuevo');
      if (['ganado', 'perdido'].includes(stage)) continue;

      const currentFollowUps = Number(contact.follow_up_count) || 0;

      if (currentFollowUps >= MAX_FOLLOW_UPS) {
        await supabase
          .from('whatsapp_contacts')
          .update({ lead_stage: 'perdido' })
          .eq('id', contact.id);
        await supabase
          .from('whatsapp_conversations')
          .update({ category: 'archived' })
          .eq('id', conv.id);
        log.info('Contact marked as perdido after max follow-ups', {
          conversationId: conv.id,
          contact: contact.display_name,
        });
        continue;
      }

      const lastMsg = await supabase
        .from('whatsapp_messages')
        .select('direction')
        .eq('conversation_id', conv.id)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (lastMsg?.data?.direction !== 'outbound') continue;

      const waId = String(contact.wa_id || contact.phone_number || '');
      if (!waId) continue;

      const { data: recentMessages } = await supabase
        .from('whatsapp_messages')
        .select('direction, content')
        .eq('conversation_id', conv.id)
        .order('created_at', { ascending: false })
        .limit(5);

      const lastMsgTexts = (recentMessages || [])
        .reverse()
        .map((m) => `${m.direction === 'inbound' ? 'Cliente' : 'Agente'}: ${m.content || ''}`);

      const persona = await getOrAssignPersona(supabase, conv.id, conv.contact_id);
      const newFollowUpCount = currentFollowUps + 1;

      const followUpText = await generateFollowUpMessage(
        String(contact.display_name || ''),
        persona.full_name,
        lastMsgTexts,
        newFollowUpCount
      );

      await setTypingIndicator(supabase, conv.id, true);
      await sleep(calculateDelay(followUpText, false));
      await setTypingIndicator(supabase, conv.id, false);

      const result = await sendTextMessage(waId, followUpText).catch((err) => {
        log.warn('Follow-up send failed', { conversationId: conv.id, error: err instanceof Error ? err.message : String(err) });
        return null;
      });

      if (!result) continue;

      await supabase.from('whatsapp_messages').insert({
        conversation_id: conv.id,
        contact_id: conv.contact_id,
        wa_message_id: result.messageId || '',
        direction: 'outbound',
        message_type: 'text',
        content: followUpText,
        status: 'sent',
        sender_name: persona.full_name,
        metadata: { auto_follow_up: true, follow_up_number: newFollowUpCount },
      });

      await supabase
        .from('whatsapp_contacts')
        .update({ follow_up_count: newFollowUpCount })
        .eq('id', contact.id);

      await supabase
        .from('whatsapp_conversations')
        .update({
          last_message_at: new Date().toISOString(),
          last_message_preview: followUpText.slice(0, 100),
        })
        .eq('id', conv.id);

      log.info('AI follow-up sent', {
        conversationId: conv.id,
        contact: contact.display_name,
        followUpNumber: newFollowUpCount,
        persona: persona.full_name,
      });
    }
  } catch (err) {
    log.error('Follow-up processing failed', { error: err instanceof Error ? err.message : String(err) });
  }
}

async function startup() {
  log.info('=== Obzide Sales Agent v1.0.0 ===');
  log.info('Initializing...');

  const supabase = getSupabase();

  const personas = await loadPersonas(supabase);
  log.info(`Loaded ${personas.length} personas`);

  await updateHeartbeat(supabase);
  heartbeatTimer = setInterval(() => {
    updateHeartbeat(supabase).catch((err) =>
      log.error('Heartbeat failed', { error: err instanceof Error ? err.message : String(err) })
    );
  }, config.agent.heartbeatInterval);

  subscribeToMessages(supabase);
  subscribeToInstructions(supabase);

  followUpTimer = setInterval(() => {
    processFollowUps(supabase).catch((err) =>
      log.error('Follow-up check failed', { error: err instanceof Error ? err.message : String(err) })
    );
  }, FOLLOW_UP_INTERVAL);

  log.info('Sales agent is ONLINE and listening for messages');
  log.info(`WhatsApp: 360dialog via ${config.d360.baseUrl}`);
  log.info(`AI Model: ${config.anthropic.model}`);
}

async function shutdown() {
  log.info('Shutting down...');

  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }

  if (followUpTimer) {
    clearInterval(followUpTimer);
    followUpTimer = null;
  }

  if (realtimeChannel) {
    const supabase = getSupabase();
    supabase.removeChannel(realtimeChannel);
    realtimeChannel = null;
  }

  if (instructionsChannel) {
    const supabase = getSupabase();
    supabase.removeChannel(instructionsChannel);
    instructionsChannel = null;
  }

  try {
    const supabase = getSupabase();
    await setOffline(supabase);
  } catch {
    log.error('Failed to set offline status');
  }

  log.info('Sales agent stopped');
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

process.on('unhandledRejection', (reason) => {
  log.error('Unhandled rejection', { reason: String(reason) });
});

startup().catch((err) => {
  log.error('Startup failed', { error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
