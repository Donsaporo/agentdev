import { getSupabase } from './supabase.js';
import { logger } from './logger.js';
import type { QueueEvent } from './types.js';
import type { RealtimeChannel } from '@supabase/supabase-js';

type EventHandler = (event: QueueEvent) => Promise<void>;

const briefQueue: QueueEvent[] = [];
const fastQueue: QueueEvent[] = [];
let briefProcessing = false;
let fastProcessing = false;
let handler: EventHandler | null = null;
let channels: RealtimeChannel[] = [];

const activeBriefs = new Set<string>();
const briefRetryCount = new Map<string, number>();
const MAX_BRIEF_RETRIES = 2;

const channelReconnectState: Map<string, { timer: NodeJS.Timeout | null; attempt: number }> = new Map();
let lastBriefsEventTime = new Date().toISOString();
let lastMessagesEventTime = new Date().toISOString();
let lastQAEventTime = new Date().toISOString();

export function setEventHandler(fn: EventHandler): void {
  handler = fn;
}

async function processBriefQueue(): Promise<void> {
  if (briefProcessing || !handler) return;
  briefProcessing = true;

  while (briefQueue.length > 0) {
    const event = briefQueue.shift()!;
    const briefId = event.payload.briefId as string;
    activeBriefs.add(briefId);

    try {
      await handler(event);
    } catch (err) {
      briefRetryCount.set(briefId, (briefRetryCount.get(briefId) || 0) + 1);
      await logger.error(
        `Brief handler failed: ${err instanceof Error ? err.message : String(err)}`,
        'system',
        event.projectId,
        { eventType: event.type }
      );
    } finally {
      activeBriefs.delete(briefId);
    }
  }

  briefProcessing = false;
}

async function processFastQueue(): Promise<void> {
  if (fastProcessing || !handler) return;
  fastProcessing = true;

  while (fastQueue.length > 0) {
    const event = fastQueue.shift()!;

    try {
      await handler(event);
    } catch (err) {
      await logger.error(
        `Fast event handler failed: ${err instanceof Error ? err.message : String(err)}`,
        'system',
        event.projectId,
        { eventType: event.type }
      );
    }
  }

  fastProcessing = false;
}

function enqueue(event: QueueEvent): void {
  if (event.type === 'brief_approved') {
    const briefId = event.payload.briefId as string;

    if (activeBriefs.has(briefId)) {
      logger.warn(`Brief ${briefId} already being processed, skipping duplicate`, 'system');
      return;
    }

    if (briefQueue.some(e => e.payload.briefId === briefId)) {
      logger.warn(`Brief ${briefId} already queued, skipping duplicate`, 'system');
      return;
    }

    const retries = briefRetryCount.get(briefId) || 0;
    if (retries >= MAX_BRIEF_RETRIES) {
      logger.warn(`Brief ${briefId} exceeded max retries (${MAX_BRIEF_RETRIES}), marking as permanently failed`, 'system');
      const supabase = getSupabase();
      (async () => {
        try {
          await supabase.from('briefs').update({ status: 'failed' }).eq('id', briefId);
          const { data: brief } = await supabase.from('briefs').select('project_id').eq('id', briefId).maybeSingle();
          if (brief?.project_id) {
            await supabase.from('projects').update({
              agent_status: 'idle',
              last_error_message: `Brief processing failed after ${MAX_BRIEF_RETRIES} retries. Please review the brief and resubmit.`,
            }).eq('id', brief.project_id);
          }
        } catch (err) {
          logger.error(`Failed to mark brief ${briefId} as permanently failed: ${err instanceof Error ? err.message : String(err)}`, 'system');
        }
      })();
      return;
    }

    briefQueue.push(event);
    processBriefQueue();
  } else {
    fastQueue.push(event);
    processFastQueue();
  }
}

function scheduleChannelReconnect(channelName: string, createFn: () => RealtimeChannel): void {
  let state = channelReconnectState.get(channelName);
  if (!state) {
    state = { timer: null, attempt: 0 };
    channelReconnectState.set(channelName, state);
  }
  if (state.timer) return;

  state.attempt++;
  const delay = Math.min(1000 * Math.pow(2, state.attempt), 60_000);
  console.log(`[${channelName}] Reconnecting in ${delay}ms (attempt ${state.attempt})`);

  state.timer = setTimeout(() => {
    state!.timer = null;
    const supabase = getSupabase();
    const oldChannel = channels.find((ch) => (ch as any).topic === `realtime:${channelName}`);
    if (oldChannel) {
      supabase.removeChannel(oldChannel);
      channels = channels.filter((ch) => ch !== oldChannel);
    }
    const newChannel = createFn();
    channels.push(newChannel);
  }, delay);
}

function resetReconnectState(channelName: string): void {
  const state = channelReconnectState.get(channelName);
  if (state) {
    state.attempt = 0;
  }
}

function stopAllChannels(): void {
  const supabase = getSupabase();
  for (const ch of channels) {
    supabase.removeChannel(ch);
  }
  channels = [];
  for (const [, state] of channelReconnectState) {
    if (state.timer) clearTimeout(state.timer);
    state.timer = null;
    state.attempt = 0;
  }
}

async function replayMissedBriefs(): Promise<void> {
  try {
    const supabase = getSupabase();
    const { data: missed } = await supabase
      .from('briefs')
      .select('id, project_id, status, updated_at')
      .eq('status', 'in_progress')
      .gt('updated_at', lastBriefsEventTime);

    if (missed && missed.length > 0) {
      logger.info(`Replaying ${missed.length} missed brief event(s)`, 'system');
      for (const brief of missed) {
        enqueue({
          type: 'brief_approved',
          projectId: brief.project_id,
          payload: { briefId: brief.id },
          timestamp: Date.now(),
        });
      }
    }
    lastBriefsEventTime = new Date().toISOString();
  } catch (err) {
    logger.warn(`Brief replay failed: ${err instanceof Error ? err.message : String(err)}`, 'system');
  }
}

async function replayMissedMessages(): Promise<void> {
  try {
    const supabase = getSupabase();
    const { data: missed } = await supabase
      .from('agent_messages')
      .select('id, conversation_id, role, content, created_at')
      .eq('role', 'user')
      .gt('created_at', lastMessagesEventTime)
      .order('created_at', { ascending: true });

    if (missed && missed.length > 0) {
      logger.info(`Replaying ${missed.length} missed chat message(s)`, 'system');
      for (const msg of missed) {
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
    }
    lastMessagesEventTime = new Date().toISOString();
  } catch (err) {
    logger.warn(`Message replay failed: ${err instanceof Error ? err.message : String(err)}`, 'system');
  }
}

async function replayMissedQA(): Promise<void> {
  try {
    const supabase = getSupabase();
    const { data: missed } = await supabase
      .from('qa_screenshots')
      .select('id, project_id, status, rejection_notes, page_name, updated_at')
      .eq('status', 'rejected')
      .gt('updated_at', lastQAEventTime);

    if (missed && missed.length > 0) {
      logger.info(`Replaying ${missed.length} missed QA rejection(s)`, 'system');
      for (const ss of missed) {
        enqueue({
          type: 'qa_rejected',
          projectId: ss.project_id,
          payload: {
            screenshotId: ss.id,
            pageName: ss.page_name,
            rejectionNotes: ss.rejection_notes,
          },
          timestamp: Date.now(),
        });
      }
    }
    lastQAEventTime = new Date().toISOString();
  } catch (err) {
    logger.warn(`QA replay failed: ${err instanceof Error ? err.message : String(err)}`, 'system');
  }
}

function createMessagesChannel(): RealtimeChannel {
  const supabase = getSupabase();
  const channelName = 'agent-messages';
  return supabase
    .channel(channelName)
    .on(
      'postgres_changes',
      {
        event: 'INSERT',
        schema: 'public',
        table: 'agent_messages',
      },
      async (payload) => {
        lastMessagesEventTime = new Date().toISOString();
        const msg = payload.new as { id: string; conversation_id: string; role: string; content: string };
        if (msg.role !== 'user') return;

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
    .subscribe((status) => {
      console.log(`[${channelName}] Status: ${status}`);
      if (status === 'SUBSCRIBED') {
        const wasReconnect = (channelReconnectState.get(channelName)?.attempt || 0) > 0;
        resetReconnectState(channelName);
        if (wasReconnect) {
          replayMissedMessages();
        }
        logger.info('Messages channel subscribed', 'system');
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
        logger.warn(`Messages channel ${status}`, 'system');
        scheduleChannelReconnect(channelName, createMessagesChannel);
      }
    });
}

function createBriefsChannel(): RealtimeChannel {
  const supabase = getSupabase();
  const channelName = 'agent-briefs';
  return supabase
    .channel(channelName)
    .on(
      'postgres_changes',
      {
        event: 'UPDATE',
        schema: 'public',
        table: 'briefs',
      },
      (payload) => {
        lastBriefsEventTime = new Date().toISOString();
        const brief = payload.new as { id: string; project_id: string; status: string };
        const oldBrief = payload.old as { status?: string } | undefined;
        const previousStatus = oldBrief?.status;

        if (brief.status === 'in_progress' && previousStatus !== 'in_progress') {
          enqueue({
            type: 'brief_approved',
            projectId: brief.project_id,
            payload: { briefId: brief.id },
            timestamp: Date.now(),
          });
        }
      }
    )
    .subscribe((status) => {
      console.log(`[${channelName}] Status: ${status}`);
      if (status === 'SUBSCRIBED') {
        const wasReconnect = (channelReconnectState.get(channelName)?.attempt || 0) > 0;
        resetReconnectState(channelName);
        if (wasReconnect) {
          replayMissedBriefs();
        }
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
        logger.warn(`Briefs channel ${status}`, 'system');
        scheduleChannelReconnect(channelName, createBriefsChannel);
      }
    });
}

function createQAChannel(): RealtimeChannel {
  const supabase = getSupabase();
  const channelName = 'agent-qa';
  return supabase
    .channel(channelName)
    .on(
      'postgres_changes',
      {
        event: 'UPDATE',
        schema: 'public',
        table: 'qa_screenshots',
      },
      (payload) => {
        lastQAEventTime = new Date().toISOString();
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
    .subscribe((status) => {
      console.log(`[${channelName}] Status: ${status}`);
      if (status === 'SUBSCRIBED') {
        const wasReconnect = (channelReconnectState.get(channelName)?.attempt || 0) > 0;
        resetReconnectState(channelName);
        if (wasReconnect) {
          replayMissedQA();
        }
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
        logger.warn(`QA channel ${status}`, 'system');
        scheduleChannelReconnect(channelName, createQAChannel);
      }
    });
}

export function startListening(): void {
  stopAllChannels();
  channels = [
    createMessagesChannel(),
    createBriefsChannel(),
    createQAChannel(),
  ];
  logger.info('Realtime listeners started', 'system');
}

function getChannelHealth(): { healthy: number; unhealthy: number; names: string[] } {
  let healthy = 0;
  let unhealthy = 0;
  const unhealthyNames: string[] = [];
  for (const ch of channels) {
    const state = (ch as unknown as { state?: string }).state;
    if (state === 'joined' || state === 'SUBSCRIBED') {
      healthy++;
    } else {
      unhealthy++;
      const topic = (ch as unknown as { topic?: string }).topic || 'unknown';
      unhealthyNames.push(`${topic}(${state || 'unknown'})`);
    }
  }
  return { healthy, unhealthy, names: unhealthyNames };
}

async function updateHeartbeat(): Promise<void> {
  const supabase = getSupabase();
  const health = getChannelHealth();
  await supabase.from('agent_heartbeat').upsert({
    id: 1,
    last_seen: new Date().toISOString(),
    status: 'online',
    version: '1.0.0',
  });
  if (health.unhealthy > 0) {
    await logger.warn(`Unhealthy channels: ${health.names.join(', ')}`, 'system');
  }
}

export function startHeartbeat(): NodeJS.Timeout {
  updateHeartbeat().catch(() => console.error('Initial heartbeat failed'));

  return setInterval(async () => {
    try {
      await updateHeartbeat();
    } catch (err) {
      console.error('Heartbeat failed:', err instanceof Error ? err.message : String(err));
    }
  }, 60_000);
}

export function clearBriefRetries(): void {
  activeBriefs.clear();
  briefRetryCount.clear();
}

export async function markOffline(): Promise<void> {
  try {
    stopAllChannels();
    const supabase = getSupabase();
    await supabase.from('agent_heartbeat').update({ status: 'offline' }).eq('id', 1);
  } catch (err) {
    console.error(`[markOffline] Failed to mark agent offline: ${err instanceof Error ? err.message : String(err)}`);
  }
}
