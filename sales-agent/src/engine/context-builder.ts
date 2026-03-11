import { SupabaseClient } from '@supabase/supabase-js';
import { createLogger } from '../core/logger.js';
import { Persona } from './persona-engine.js';
import { searchKnowledge, getAllInstructions } from './knowledge-search.js';

const log = createLogger('context-builder');

export interface ConversationContext {
  persona: Persona;
  contactName: string;
  contactPhone: string;
  contactEmail: string;
  contactCompany: string;
  leadStage: string;
  conversationCategory: string;
  messageHistory: { role: string; content: string; timestamp: string }[];
  knowledge: { title: string; content: string }[];
  instructions: { instruction: string; priority: string }[];
  crmNotes: string;
}

export async function buildContext(
  supabase: SupabaseClient,
  conversationId: string,
  contactId: string,
  incomingMessage: string,
  persona: Persona
): Promise<ConversationContext> {
  const [contact, messages, knowledge, instructions] = await Promise.all([
    loadContact(supabase, contactId),
    loadRecentMessages(supabase, conversationId),
    searchKnowledge(supabase, incomingMessage),
    getAllInstructions(supabase),
  ]);

  const context: ConversationContext = {
    persona,
    contactName: contact?.display_name || contact?.profile_name || contact?.phone_number || 'Desconocido',
    contactPhone: contact?.phone_number || '',
    contactEmail: contact?.email || '',
    contactCompany: contact?.company || '',
    leadStage: contact?.lead_stage || 'vacio',
    conversationCategory: 'new_lead',
    messageHistory: messages.map((m) => ({
      role: m.direction === 'inbound' ? 'user' : 'assistant',
      content: m.content || `[${m.message_type}]`,
      timestamp: m.created_at,
    })),
    knowledge: knowledge.map((k) => ({ title: k.title, content: k.content })),
    instructions: instructions.map((i) => ({ instruction: i.instruction, priority: i.priority })),
    crmNotes: contact?.notes || '',
  };

  log.debug('Context built', {
    contact: context.contactName,
    messageCount: context.messageHistory.length,
    knowledgeChunks: context.knowledge.length,
    instructionCount: context.instructions.length,
  });

  return context;
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
    .select('direction, content, message_type, created_at')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: true })
    .limit(limit);
  return data || [];
}
