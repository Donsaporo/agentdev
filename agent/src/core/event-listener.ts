import { getSupabase } from './supabase.js';
import { logger } from './logger.js';
import type { QueueEvent } from './types.js';

type EventHandler = (event: QueueEvent) => Promise<void>;

const queue: QueueEvent[] = [];
let processing = false;
let handler: EventHandler | null = null;

export function setEventHandler(fn: EventHandler): void {
  handler = fn;
}

async function processQueue(): Promise<void> {
  if (processing || !handler) return;
  processing = true;

  while (queue.length > 0) {
    const event = queue.shift()!;
    try {
      await handler(event);
    } catch (err) {
      await logger.error(
        `Event handler failed: ${err instanceof Error ? err.message : String(err)}`,
        'system',
        event.projectId,
        { eventType: event.type }
      );
    }
  }

  processing = false;
}

function enqueue(event: QueueEvent): void {
  queue.push(event);
  processQueue();
}

export function startListening(): void {
  const supabase = getSupabase();

  supabase
    .channel('agent-messages-listener')
    .on(
      'postgres_changes',
      {
        event: 'INSERT',
        schema: 'public',
        table: 'agent_messages',
        filter: 'role=in.(user,system)',
      },
      async (payload) => {
        const msg = payload.new as { id: string; conversation_id: string; role: string; content: string };
        const { data: conv } = await supabase
          .from('agent_conversations')
          .select('project_id')
          .eq('id', msg.conversation_id)
          .maybeSingle();

        if (conv) {
          enqueue({
            type: 'chat_message',
            projectId: conv.project_id,
            payload: { messageId: msg.id, conversationId: msg.conversation_id, content: msg.content },
            timestamp: Date.now(),
          });
        }
      }
    )
    .subscribe();

  supabase
    .channel('agent-briefs-listener')
    .on(
      'postgres_changes',
      {
        event: 'UPDATE',
        schema: 'public',
        table: 'briefs',
        filter: 'status=eq.in_progress',
      },
      (payload) => {
        const brief = payload.new as { id: string; project_id: string; status: string };
        if (brief.status === 'in_progress') {
          enqueue({
            type: 'brief_approved',
            projectId: brief.project_id,
            payload: { briefId: brief.id },
            timestamp: Date.now(),
          });
        }
      }
    )
    .subscribe();

  supabase
    .channel('agent-qa-listener')
    .on(
      'postgres_changes',
      {
        event: 'UPDATE',
        schema: 'public',
        table: 'qa_screenshots',
        filter: 'status=eq.rejected',
      },
      (payload) => {
        const screenshot = payload.new as { id: string; project_id: string; status: string; rejection_notes: string; page_name: string };
        if (screenshot.status === 'rejected') {
          enqueue({
            type: 'qa_rejected',
            projectId: screenshot.project_id,
            payload: {
              screenshotId: screenshot.id,
              pageName: screenshot.page_name,
              rejectionNotes: screenshot.rejection_notes,
            },
            timestamp: Date.now(),
          });
        }
      }
    )
    .subscribe();

  logger.info('Realtime listeners started', 'system');
}

export function startHeartbeat(): NodeJS.Timeout {
  return setInterval(async () => {
    try {
      await logger.info('Agent heartbeat', 'system');
    } catch {
      console.error('Heartbeat failed');
    }
  }, 60_000);
}
