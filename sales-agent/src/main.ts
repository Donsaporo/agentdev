import { config } from './core/config.js';
import { createLogger } from './core/logger.js';
import { getSupabase } from './core/supabase.js';
import { handleIncomingMessage } from './engine/conversation-manager.js';
import { loadPersonas } from './engine/persona-engine.js';
import { invalidateInstructionsCache } from './engine/knowledge-search.js';
import { sendTextMessage } from './services/whatsapp.js';

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

        handleIncomingMessage(supabase, {
          id: msg.id,
          conversationId: msg.conversation_id,
          contactId: msg.contact_id,
          content: msg.content || '',
          messageType: msg.message_type || 'text',
        }).catch((err) => {
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

async function processFollowUps(supabase: ReturnType<typeof getSupabase>) {
  try {
    const cutoff = new Date(Date.now() - FOLLOW_UP_AFTER_HOURS * 60 * 60_000).toISOString();

    const { data: staleConversations } = await supabase
      .from('whatsapp_conversations')
      .select('id, contact_id, last_message_at, contact:whatsapp_contacts(display_name, phone_number, lead_stage, notes)')
      .eq('agent_mode', 'ai')
      .eq('status', 'active')
      .in('category', ['new_lead', 'active_client'])
      .lt('last_message_at', cutoff)
      .order('last_message_at', { ascending: true })
      .limit(5);

    if (!staleConversations || staleConversations.length === 0) return;

    for (const conv of staleConversations) {
      const contact = conv.contact as Record<string, string> | null;
      if (!contact) continue;

      const stage = contact.lead_stage;
      if (['cerrado_ganado', 'cerrado_perdido', 'inactivo'].includes(stage)) continue;

      const lastMsg = await supabase
        .from('whatsapp_messages')
        .select('direction')
        .eq('conversation_id', conv.id)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (lastMsg?.data?.direction !== 'outbound') continue;

      const name = contact.display_name || '';
      const greeting = name ? `Hola ${name.split(' ')[0]}` : 'Hola';
      const followUpText = `${greeting}, espero que estes bien. Queria dar seguimiento a nuestra conversacion anterior. Tienes algun momento para que platiquemos?`;

      const waId = contact.phone_number;
      if (!waId) continue;

      await sendTextMessage(waId, followUpText).catch((err) => {
        log.warn('Follow-up send failed', { conversationId: conv.id, error: err instanceof Error ? err.message : String(err) });
      });

      await supabase.from('whatsapp_messages').insert({
        conversation_id: conv.id,
        contact_id: conv.contact_id,
        wa_message_id: '',
        direction: 'outbound',
        message_type: 'text',
        content: followUpText,
        status: 'sent',
        sender_name: 'Sales Agent',
        metadata: { auto_follow_up: true },
      });

      log.info('Follow-up sent', { conversationId: conv.id, contact: name });
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
