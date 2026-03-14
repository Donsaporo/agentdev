import { SupabaseClient } from '@supabase/supabase-js';
import { createLogger } from '../core/logger.js';
import { Persona } from './persona-engine.js';
import { searchKnowledge, getAllInstructions } from './knowledge-search.js';
import { getClientHistory, getCrmClientData } from '../services/crm.js';

const log = createLogger('context-builder');

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
}

export async function buildContext(
  supabase: SupabaseClient,
  conversationId: string,
  contactId: string,
  incomingMessage: string,
  persona: Persona
): Promise<ConversationContext> {
  const [contact, conversation, messages, knowledge, instructions] = await Promise.all([
    loadContact(supabase, contactId),
    loadConversation(supabase, conversationId),
    loadRecentMessages(supabase, conversationId),
    searchKnowledge(supabase, incomingMessage),
    getAllInstructions(supabase, persona.id),
  ]);

  const crmClientId = contact?.crm_client_id || null;
  let crmHistory = '';

  if (crmClientId) {
    try {
      const [clientData, history] = await Promise.all([
        getCrmClientData(crmClientId),
        getClientHistory(crmClientId),
      ]);

      const parts: string[] = [];

      if (clientData) {
        const cd = clientData as Record<string, unknown>;
        if (cd.lead_stage) parts.push(`Etapa CRM: ${cd.lead_stage}`);
        if (cd.estimated_value) parts.push(`Valor estimado: $${cd.estimated_value}`);
        if (cd.next_action) parts.push(`Proxima accion: ${cd.next_action}`);
        if (cd.next_action_date) parts.push(`Fecha proxima accion: ${cd.next_action_date}`);
      }

      if (history.meetings.length > 0) {
        parts.push('Reuniones:');
        for (const m of history.meetings) {
          parts.push(`  - ${m.title} (${m.start_time}) [${m.status}]`);
        }
      }

      if (history.timeline.length > 0) {
        parts.push('Actividad reciente:');
        for (const t of history.timeline.slice(0, 5)) {
          parts.push(`  - [${t.event_type}] ${t.title}`);
        }
      }

      if (history.comments.length > 0) {
        parts.push('Notas internas:');
        for (const c of history.comments.slice(0, 3)) {
          parts.push(`  - ${c.comment}`);
        }
      }

      crmHistory = parts.join('\n');
    } catch (err) {
      log.warn('Failed to load CRM history', { crmClientId, error: err instanceof Error ? err.message : String(err) });
    }
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
  };

  log.debug('Context built', {
    contact: context.contactName,
    messageCount: context.messageHistory.length,
    knowledgeChunks: context.knowledge.length,
    instructionCount: context.instructions.length,
    hasCrm: !!crmClientId,
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
