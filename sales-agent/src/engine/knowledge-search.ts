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
  data: { instruction: string; priority: string; category: string }[] | null;
  expiry: number;
} = { data: null, expiry: 0 };

const INSTRUCTIONS_TTL = 5 * 60 * 1000;

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
  supabase: SupabaseClient
): Promise<{ instruction: string; priority: string; category: string }[]> {
  if (instructionsCache.data && Date.now() < instructionsCache.expiry) {
    return instructionsCache.data;
  }

  const { data, error } = await supabase
    .from('sales_agent_instructions')
    .select('instruction, priority, category')
    .eq('is_active', true)
    .order('priority', { ascending: true });

  if (error) {
    log.error('Failed to load instructions', { error: error.message });
    return instructionsCache.data || [];
  }

  instructionsCache.data = data || [];
  instructionsCache.expiry = Date.now() + INSTRUCTIONS_TTL;

  return instructionsCache.data;
}

export function invalidateInstructionsCache(): void {
  instructionsCache.data = null;
  instructionsCache.expiry = 0;
}
