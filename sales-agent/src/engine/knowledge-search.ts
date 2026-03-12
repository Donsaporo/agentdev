import { SupabaseClient } from '@supabase/supabase-js';
import { createLogger } from '../core/logger.js';

const log = createLogger('knowledge-search');

export interface KnowledgeChunk {
  id: string;
  category: string;
  title: string;
  content: string;
}

const instructionsCache: {
  data: { instruction: string; priority: string; category: string; persona_id: string | null }[] | null;
  expiry: number;
} = { data: null, expiry: 0 };

const INSTRUCTIONS_TTL = 30_000;

export async function searchKnowledge(
  supabase: SupabaseClient,
  query: string,
  categories?: string[],
  limit = 10
): Promise<KnowledgeChunk[]> {
  const keywords = query
    .toLowerCase()
    .replace(/[¿?!¡.,;:()]/g, '')
    .split(/\s+/)
    .filter((w) => w.length > 2);

  if (keywords.length === 0) {
    const { data } = await supabase
      .from('sales_agent_knowledge')
      .select('id, category, title, content')
      .eq('is_active', true)
      .order('created_at', { ascending: false })
      .limit(limit);
    return data || [];
  }

  const orConditions = keywords
    .map((kw) => `title.ilike.%${kw}%,content.ilike.%${kw}%`)
    .join(',');

  let q = supabase
    .from('sales_agent_knowledge')
    .select('id, category, title, content')
    .eq('is_active', true)
    .or(orConditions)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (categories && categories.length > 0) {
    q = q.in('category', categories);
  }

  const { data, error } = await q;

  if (error) {
    log.error('Knowledge search failed', { error: error.message });
    return [];
  }

  log.debug(`Found ${data?.length || 0} knowledge chunks for query: "${query}"`);
  return data || [];
}

export async function getAllInstructions(
  supabase: SupabaseClient,
  personaId?: string
): Promise<{ instruction: string; priority: string; category: string }[]> {
  if (instructionsCache.data && Date.now() < instructionsCache.expiry) {
    return filterByPersona(instructionsCache.data, personaId);
  }

  const { data, error } = await supabase
    .from('sales_agent_instructions')
    .select('instruction, priority, category, persona_id')
    .eq('is_active', true)
    .order('priority', { ascending: true });

  if (error) {
    log.error('Failed to load instructions', { error: error.message });
    const cached = instructionsCache.data || [];
    return filterByPersona(cached, personaId);
  }

  instructionsCache.data = data || [];
  instructionsCache.expiry = Date.now() + INSTRUCTIONS_TTL;

  return filterByPersona(instructionsCache.data, personaId);
}

function filterByPersona(
  instructions: { instruction: string; priority: string; category: string; persona_id: string | null }[],
  personaId?: string
): { instruction: string; priority: string; category: string }[] {
  return instructions
    .filter((i) => i.persona_id === null || i.persona_id === personaId)
    .map(({ instruction, priority, category }) => ({ instruction, priority, category }));
}

export function invalidateInstructionsCache(): void {
  instructionsCache.data = null;
  instructionsCache.expiry = 0;
}
