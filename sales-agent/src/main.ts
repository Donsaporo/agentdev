import { config } from './core/config.js';
import { createLogger } from './core/logger.js';
import { getSupabase } from './core/supabase.js';
import { handleIncomingMessage } from './engine/conversation-manager.js';
import { loadPersonas } from './engine/persona-engine.js';

const log = createLogger('main');

let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let realtimeChannel: ReturnType<ReturnType<typeof getSupabase>['channel']> | null = null;

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

  if (realtimeChannel) {
    const supabase = getSupabase();
    supabase.removeChannel(realtimeChannel);
    realtimeChannel = null;
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
