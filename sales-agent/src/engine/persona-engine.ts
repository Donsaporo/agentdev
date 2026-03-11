import { SupabaseClient } from '@supabase/supabase-js';
import { createLogger } from '../core/logger.js';

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

export async function assignPersona(
  supabase: SupabaseClient,
  conversationId: string
): Promise<Persona> {
  const personas = await loadPersonas(supabase);
  if (personas.length === 0) throw new Error('No active personas available');

  const selected = personas[Math.floor(Math.random() * personas.length)];

  await supabase.from('sales_agent_assignments').upsert(
    {
      conversation_id: conversationId,
      persona_id: selected.id,
      mode: 'ai',
    },
    { onConflict: 'conversation_id' }
  );

  await supabase
    .from('whatsapp_conversations')
    .update({ agent_persona_id: selected.id })
    .eq('id', conversationId);

  log.info(`Assigned persona ${selected.full_name} to conversation ${conversationId}`);
  return selected;
}

export async function getOrAssignPersona(
  supabase: SupabaseClient,
  conversationId: string
): Promise<Persona> {
  const existing = await getAssignedPersona(supabase, conversationId);
  if (existing) return existing;
  return assignPersona(supabase, conversationId);
}
