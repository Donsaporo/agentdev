import { SupabaseClient } from '@supabase/supabase-js';
import { createLogger } from '../core/logger.js';
import { getSalespersonId } from '../services/crm.js';

const log = createLogger('persona-engine');

export interface Persona {
  id: string;
  first_name: string;
  last_name: string;
  full_name: string;
  job_title: string;
  personality_traits: string[];
  communication_style: string;
  greeting_template: string;
  farewell_template: string;
  response_length_preference: string;
  emoji_usage: string;
  formality_level: string;
  team_member_id: string | null;
}

let cachedPersonas: Persona[] = [];
let cacheExpiry = 0;

export async function loadPersonas(supabase: SupabaseClient): Promise<Persona[]> {
  if (cachedPersonas.length > 0 && Date.now() < cacheExpiry) {
    return cachedPersonas;
  }

  const { data, error } = await supabase
    .from('sales_agent_personas')
    .select('*')
    .eq('is_active', true);

  if (error) {
    log.error('Failed to load personas', { error: error.message });
    return cachedPersonas;
  }

  cachedPersonas = data || [];
  cacheExpiry = Date.now() + 5 * 60_000;
  log.info(`Loaded ${cachedPersonas.length} active personas`);
  return cachedPersonas;
}

export async function getAssignedPersona(
  supabase: SupabaseClient,
  conversationId: string
): Promise<Persona | null> {
  const { data: assignment } = await supabase
    .from('sales_agent_assignments')
    .select('persona_id')
    .eq('conversation_id', conversationId)
    .maybeSingle();

  if (assignment?.persona_id) {
    const personas = await loadPersonas(supabase);
    return personas.find((p) => p.id === assignment.persona_id) || null;
  }

  return null;
}

async function findContactPersona(
  supabase: SupabaseClient,
  contactId: string
): Promise<Persona | null> {
  const { data: previousAssignment } = await supabase
    .from('sales_agent_assignments')
    .select('persona_id, conversation_id')
    .eq('contact_id', contactId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (previousAssignment?.persona_id) {
    const personas = await loadPersonas(supabase);
    const found = personas.find((p) => p.id === previousAssignment.persona_id);
    if (found) {
      log.info('Found existing persona for contact', {
        contactId,
        persona: found.full_name,
        fromConversation: previousAssignment.conversation_id,
      });
      return found;
    }
  }

  return null;
}

export async function assignPersona(
  supabase: SupabaseClient,
  conversationId: string,
  contactId?: string
): Promise<Persona> {
  const personas = await loadPersonas(supabase);
  if (personas.length === 0) throw new Error('No active personas available');

  let selected: Persona | null = null;

  if (contactId) {
    selected = await findContactPersona(supabase, contactId);
  }

  if (!selected) {
    selected = personas[Math.floor(Math.random() * personas.length)];
  }

  await supabase.from('sales_agent_assignments').upsert(
    {
      conversation_id: conversationId,
      contact_id: contactId || null,
      persona_id: selected.id,
      mode: 'ai',
    },
    { onConflict: 'conversation_id' }
  );

  await supabase
    .from('whatsapp_conversations')
    .update({ agent_persona_id: selected.id })
    .eq('id', conversationId);

  if (contactId) {
    const updates: Record<string, unknown> = {};
    if (selected.team_member_id) {
      updates.assigned_team_member = selected.team_member_id;
    }
    if (Object.keys(updates).length > 0) {
      await supabase
        .from('whatsapp_contacts')
        .update(updates)
        .eq('id', contactId);
    }
  }

  log.info(`Assigned persona ${selected.full_name} to conversation ${conversationId}`);
  return selected;
}

export async function getOrAssignPersona(
  supabase: SupabaseClient,
  conversationId: string,
  contactId?: string
): Promise<Persona> {
  const existing = await getAssignedPersona(supabase, conversationId);
  if (existing) return existing;
  return assignPersona(supabase, conversationId, contactId);
}
