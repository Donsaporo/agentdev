import { SupabaseClient } from '@supabase/supabase-js';
import { createLogger } from '../core/logger.js';
import { Persona } from './persona-engine.js';
import { searchKnowledge, getAllInstructions } from './knowledge-search.js';
import { getClientHistory, getCrmClientData, getMeetingNotesFromCrm, CrmMeetingNote } from '../services/crm.js';
import { getContactInsights, getConversationSummaries } from '../services/conversation-summarizer.js';
import { loadPostVentaData, getClientQuotations } from '../services/crm-postventa.js';
import { formatPostVentaContext, formatPreVentaQuotations } from '../services/crm-postventa-formatter.js';

const log = createLogger('context-builder');

export interface ClientInsight {
  category: string;
  content: string;
  confidence: string;
  created_at: string;
}

export interface ConversationSummary {
  summary: string;
  key_topics: string[];
  message_count: number;
  created_at: string;
  conversation_id: string;
}

export interface UpcomingMeeting {
  title: string;
  start_time: string;
  end_time: string;
  meeting_type: string;
  meet_link: string | null;
}

export interface ConversationContext {
  persona: Persona;
  contactName: string;
  contactPhone: string;
  contactEmail: string;
  contactCompany: string;
  leadStage: string;
  conversationCategory: string;
  windowStatus: 'open' | 'closing_soon' | 'closed';
  windowExpiresAt: string | null;
  messageHistory: { role: string; content: string; timestamp: string; messageType?: string; hasMedia?: boolean }[];
  knowledge: { title: string; content: string }[];
  instructions: { instruction: string; priority: string }[];
  crmNotes: string;
  crmClientId: string | null;
  crmHistory: string;
  insights: ClientInsight[];
  conversationSummaries: ConversationSummary[];
  meetingHistory: MeetingHistoryEntry[];
  upcomingMeetings: UpcomingMeeting[];
  postVentaContext: string;
  isPostVenta: boolean;
}

export interface MeetingHistoryEntry {
  title: string;
  date: string;
  summary: string;
  key_points: string[];
  decisions: string[];
  action_items: string[];
  source: 'local' | 'crm';
}

export async function buildContext(
  supabase: SupabaseClient,
  conversationId: string,
  contactId: string,
  incomingMessage: string,
  persona: Persona
): Promise<ConversationContext> {
  const [contact, conversation, messages, knowledge, instructions, insights, summaries] = await Promise.all([
    loadContact(supabase, contactId),
    loadConversation(supabase, conversationId),
    loadRecentMessages(supabase, conversationId),
    searchKnowledge(supabase, incomingMessage),
    getAllInstructions(supabase, persona.id),
    getContactInsights(supabase, contactId),
    getConversationSummaries(supabase, contactId, conversationId),
  ]);

  const crmClientId = contact?.crm_client_id || null;
  let crmHistory = '';
  let meetingHistory: MeetingHistoryEntry[] = [];
  let postVentaContext = '';

  const leadStage = contact?.lead_stage || 'nuevo';
  const convCategory = conversation?.category || 'new_lead';
  const isPostVenta = convCategory === 'support'
    || convCategory === 'active_client'
    || leadStage === 'ganado';

  const [localMeetings, upcomingMeetings] = await Promise.all([
    loadCompletedMeetings(supabase, contactId),
    loadUpcomingMeetings(supabase, contactId),
  ]);

  if (crmClientId) {
    try {
      const crmPromises: Promise<unknown>[] = [
        getCrmClientData(crmClientId),
        getClientHistory(crmClientId),
        getMeetingNotesFromCrm(crmClientId),
      ];

      if (isPostVenta) {
        crmPromises.push(loadPostVentaData(crmClientId));
      } else {
        crmPromises.push(getClientQuotations(crmClientId));
      }

      const [clientData, history, crmMeetingNotes, extendedData] = await Promise.all(crmPromises) as [
        Record<string, unknown> | null,
        Awaited<ReturnType<typeof getClientHistory>>,
        CrmMeetingNote[],
        unknown,
      ];

      const parts: string[] = [];

      if (clientData) {
        const cd = clientData;
        if (cd.lead_stage) parts.push(`Etapa CRM: ${cd.lead_stage}`);
        if (cd.estimated_value) parts.push(`Valor estimado: $${cd.estimated_value}`);
        if (cd.next_action) parts.push(`Proxima accion: ${cd.next_action}`);
        if (cd.next_action_date) parts.push(`Fecha proxima accion: ${cd.next_action_date}`);
        if (cd.notes) parts.push(`Notas del cliente: ${(cd.notes as string).slice(0, 300)}`);
      }

      if (history.meetings.length > 0) {
        parts.push('Reuniones:');
        for (const m of history.meetings) {
          parts.push(`  - ${m.title} (${m.start_time}) [${m.status}]`);
        }
      }

      if (history.timeline.length > 0) {
        parts.push('Actividad reciente:');
        for (const t of history.timeline.slice(0, 7)) {
          const desc = t.description ? `: ${t.description.slice(0, 100)}` : '';
          parts.push(`  - [${t.event_type}] ${t.title}${desc}`);
        }
      }

      if (history.comments.length > 0) {
        parts.push('Notas internas:');
        for (const c of history.comments.slice(0, 5)) {
          parts.push(`  - ${c.comment}`);
        }
      }

      crmHistory = parts.join('\n');

      if (isPostVenta) {
        const pvData = extendedData as Awaited<ReturnType<typeof loadPostVentaData>>;
        postVentaContext = formatPostVentaContext(pvData);
      } else {
        const quotations = extendedData as Awaited<ReturnType<typeof getClientQuotations>>;
        postVentaContext = formatPreVentaQuotations({ quotations });
      }

      const crmEntries: MeetingHistoryEntry[] = crmMeetingNotes
        .filter((n: CrmMeetingNote) => n.executive_summary)
        .map((n: CrmMeetingNote) => ({
          title: n.title,
          date: n.start_time,
          summary: n.executive_summary,
          key_points: n.key_points,
          decisions: n.decisions,
          action_items: n.action_items.map((a) => `${a.description} (${a.assigned_to}) [${a.status}]`),
          source: 'crm' as const,
        }));

      meetingHistory = [...localMeetings, ...crmEntries];

      const seenTitles = new Set<string>();
      meetingHistory = meetingHistory.filter((m) => {
        const key = `${m.title}-${m.date}`;
        if (seenTitles.has(key)) return false;
        seenTitles.add(key);
        return true;
      });

      meetingHistory.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
      meetingHistory = meetingHistory.slice(0, 5);
    } catch (err) {
      log.warn('Failed to load CRM history', { crmClientId, error: err instanceof Error ? err.message : String(err) });
      meetingHistory = localMeetings;
    }
  } else {
    meetingHistory = localMeetings;
  }

  const context: ConversationContext = {
    persona,
    contactName: contact?.display_name || contact?.profile_name || contact?.phone_number || 'Desconocido',
    contactPhone: contact?.phone_number || '',
    contactEmail: contact?.email || '',
    contactCompany: contact?.company || '',
    leadStage: contact?.lead_stage || 'nuevo',
    conversationCategory: conversation?.category || 'new_lead',
    windowStatus: conversation?.window_status || 'closed',
    windowExpiresAt: conversation?.window_expires_at || null,
    messageHistory: messages.map((m) => {
      let content = m.content || `[${m.message_type}]`;

      const replyToId = (m.metadata as Record<string, unknown>)?.reply_to_wa_message_id as string | undefined;
      if (replyToId) {
        const replyTarget = messages.find((r) => r.wa_message_id === replyToId);
        if (replyTarget) {
          const preview = (replyTarget.content || '').slice(0, 80);
          content = `[En respuesta a: "${preview}"]\n${content}`;
        }
      }

      return {
        role: m.direction === 'inbound' ? 'user' : 'assistant',
        content,
        timestamp: m.created_at,
        messageType: m.message_type,
        hasMedia: !!m.media_url,
      };
    }),
    knowledge: knowledge.map((k) => ({ title: k.title, content: k.content })),
    instructions: instructions.map((i) => ({ instruction: i.instruction, priority: i.priority })),
    crmNotes: contact?.notes || '',
    crmClientId,
    crmHistory,
    insights,
    conversationSummaries: summaries,
    meetingHistory,
    upcomingMeetings,
    postVentaContext,
    isPostVenta,
  };

  log.debug('Context built', {
    contact: context.contactName,
    messageCount: context.messageHistory.length,
    knowledgeChunks: context.knowledge.length,
    instructionCount: context.instructions.length,
    hasCrm: !!crmClientId,
    isPostVenta,
    hasPostVentaData: postVentaContext.length > 0,
    insightCount: insights.length,
    summaryCount: summaries.length,
  });

  return context;
}

async function loadConversation(supabase: SupabaseClient, conversationId: string) {
  const { data } = await supabase
    .from('whatsapp_conversations')
    .select('category, window_status, window_expires_at')
    .eq('id', conversationId)
    .maybeSingle();
  return data;
}

async function loadContact(supabase: SupabaseClient, contactId: string) {
  const { data } = await supabase
    .from('whatsapp_contacts')
    .select('*')
    .eq('id', contactId)
    .maybeSingle();
  return data;
}

async function loadRecentMessages(supabase: SupabaseClient, conversationId: string, limit = 30) {
  const { data } = await supabase
    .from('whatsapp_messages')
    .select('direction, content, message_type, media_url, media_mime_type, created_at, wa_message_id, metadata')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: true })
    .limit(limit);
  return data || [];
}

async function loadCompletedMeetings(supabase: SupabaseClient, contactId: string): Promise<MeetingHistoryEntry[]> {
  try {
    const { data: meetings } = await supabase
      .from('sales_meetings')
      .select('id, title, start_time, summary, transcript')
      .eq('contact_id', contactId)
      .eq('status', 'completed')
      .order('start_time', { ascending: false })
      .limit(3);

    if (!meetings || meetings.length === 0) return [];

    const meetingIds = meetings.map((m) => m.id);
    const { data: transcripts } = await supabase
      .from('sales_meeting_transcripts')
      .select('conversation_id, summary, action_items, client_commitments, next_steps, metadata')
      .in('conversation_id', meetingIds);

    const transcriptMap = new Map<string, Record<string, unknown>>();
    for (const t of transcripts || []) {
      transcriptMap.set(t.conversation_id, t);
    }

    return meetings
      .filter((m) => m.summary || transcriptMap.has(m.id))
      .map((m) => {
        const t = transcriptMap.get(m.id) as Record<string, unknown> | undefined;
        const metadata = (t?.metadata || {}) as Record<string, string[]>;
        return {
          title: m.title,
          date: m.start_time,
          summary: (t?.summary as string) || m.summary || '',
          key_points: metadata.key_points || [],
          decisions: metadata.decisions || [],
          action_items: ((t?.action_items || []) as Array<{ description: string }>).map((a) => a.description),
          source: 'local' as const,
        };
      });
  } catch (err) {
    log.warn('Failed to load local meetings', { contactId, error: err instanceof Error ? err.message : String(err) });
    return [];
  }
}

async function loadUpcomingMeetings(supabase: SupabaseClient, contactId: string): Promise<UpcomingMeeting[]> {
  try {
    const { data } = await supabase
      .from('sales_meetings')
      .select('title, start_time, end_time, meet_link, status')
      .eq('contact_id', contactId)
      .eq('status', 'scheduled')
      .gt('start_time', new Date().toISOString())
      .order('start_time', { ascending: true })
      .limit(5);

    if (!data || data.length === 0) return [];

    return data.map((m) => ({
      title: m.title,
      start_time: m.start_time,
      end_time: m.end_time,
      meeting_type: m.meet_link ? 'virtual' : 'presencial',
      meet_link: m.meet_link || null,
    }));
  } catch (err) {
    log.warn('Failed to load upcoming meetings', { contactId, error: err instanceof Error ? err.message : String(err) });
    return [];
  }
}
