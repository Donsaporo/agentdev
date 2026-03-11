import { SupabaseClient } from '@supabase/supabase-js';
import { createLogger } from '../core/logger.js';

const log = createLogger('knowledge-search');

export interface KnowledgeChunk {
  id: string;
  category: string;
  title: string;
  content: string;
}

export async function searchKnowledge(
  supabase: SupabaseClient,
  query: string,
  categories?: string[],
  limit = 10
): Promise<KnowledgeChunk[]> {
  let q = supabase
    .from('sales_agent_knowledge')
    .select('id, category, title, content')
    .eq('is_active', true)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (categories && categories.length > 0) {
    q = q.in('category', categories);
  }

  const keywords = query
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 3);

  if (keywords.length > 0) {
    const pattern = keywords.join('|');
    q = q.or(`title.ilike.%${pattern}%,content.ilike.%${pattern}%`);
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
  const { data, error } = await supabase
    .from('sales_agent_instructions')
    .select('instruction, priority, category')
    .eq('is_active', true)
    .order('priority', { ascending: true });

  if (error) {
    log.error('Failed to load instructions', { error: error.message });
    return [];
  }

  return data || [];
}
