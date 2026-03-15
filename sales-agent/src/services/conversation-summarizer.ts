import { SupabaseClient } from '@supabase/supabase-js';
import { createLogger } from '../core/logger.js';
import { callClaude } from './claude.js';
import { addCrmClientInsight } from './crm-postventa.js';

const log = createLogger('conversation-summarizer');

const SUMMARY_THRESHOLD = 25;
const OVERLAP_MESSAGES = 5;

interface MessageRow {
  direction: string;
  content: string;
  message_type: string;
  created_at: string;
  sender_name: string | null;
}

interface SummaryResult {
  summary: string;
  keyTopics: string[];
  insights: Array<{
    category: string;
    content: string;
    confidence: string;
  }>;
}

export async function shouldSummarize(
  supabase: SupabaseClient,
  conversationId: string
): Promise<boolean> {
  const { data: lastSummary } = await supabase
    .from('conversation_summaries')
    .select('message_range_end, message_count')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  const sinceDate = lastSummary?.message_range_end || '1970-01-01T00:00:00Z';

  const { count } = await supabase
    .from('whatsapp_messages')
    .select('id', { count: 'exact', head: true })
    .eq('conversation_id', conversationId)
    .gt('created_at', sinceDate);

  return (count || 0) >= SUMMARY_THRESHOLD;
}

export async function summarizeConversation(
  supabase: SupabaseClient,
  conversationId: string,
  contactId: string
): Promise<void> {
  const { data: lastSummary } = await supabase
    .from('conversation_summaries')
    .select('message_range_end')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  const sinceDate = lastSummary?.message_range_end || '1970-01-01T00:00:00Z';

  const { data: messages } = await supabase
    .from('whatsapp_messages')
    .select('direction, content, message_type, created_at, sender_name')
    .eq('conversation_id', conversationId)
    .gt('created_at', sinceDate)
    .order('created_at', { ascending: true });

  if (!messages || messages.length < SUMMARY_THRESHOLD) return;

  const toSummarize = messages.slice(0, -OVERLAP_MESSAGES);
  if (toSummarize.length < 10) return;

  const { data: existingInsights } = await supabase
    .from('client_insights')
    .select('category, content')
    .eq('contact_id', contactId)
    .eq('is_active', true);

  const result = await generateSummary(toSummarize, existingInsights || []);

  await supabase.from('conversation_summaries').insert({
    conversation_id: conversationId,
    contact_id: contactId,
    summary: result.summary,
    message_range_start: toSummarize[0].created_at,
    message_range_end: toSummarize[toSummarize.length - 1].created_at,
    message_count: toSummarize.length,
    key_topics: result.keyTopics,
  });

  if (result.insights.length > 0) {
    await saveInsights(supabase, contactId, conversationId, result.insights);
  }

  log.info('Conversation summarized', {
    conversationId,
    messageCount: toSummarize.length,
    topics: result.keyTopics.length,
    newInsights: result.insights.length,
  });
}

async function generateSummary(
  messages: MessageRow[],
  existingInsights: Array<{ category: string; content: string }>
): Promise<SummaryResult> {
  const transcript = messages.map((m) => {
    const speaker = m.direction === 'inbound' ? 'CLIENTE' : 'AGENTE';
    const content = m.content || `[${m.message_type}]`;
    return `[${speaker}] ${content}`;
  }).join('\n');

  const existingBlock = existingInsights.length > 0
    ? `\nInsights ya registrados (NO los repitas si ya existen):\n${existingInsights.map(i => `- [${i.category}] ${i.content}`).join('\n')}`
    : '';

  const systemPrompt = `Eres un analista de conversaciones de ventas. Tu trabajo es resumir conversaciones y extraer insights estructurados.

Analiza la siguiente conversacion entre un agente de ventas y un cliente potencial.${existingBlock}

Responde UNICAMENTE con JSON valido:
{
  "summary": "Resumen conciso de la conversacion en 2-4 oraciones. Incluye: que necesita el cliente, que se discutio, y en que quedo la conversacion.",
  "key_topics": ["tema1", "tema2"],
  "insights": [
    {
      "category": "need|objection|preference|budget|timeline|decision_maker|competitor|pain_point|positive_signal|personal_detail",
      "content": "descripcion concisa del insight",
      "confidence": "high|medium|low"
    }
  ]
}

Categorias de insights:
- need: Necesidad o requerimiento del cliente (ej: "Necesita tienda online con pasarela de pago")
- objection: Objecion o resistencia (ej: "Le preocupa el costo")
- preference: Preferencia especifica (ej: "Prefiere reuniones virtuales")
- budget: Informacion de presupuesto (ej: "Presupuesto aprox $3000-5000")
- timeline: Plazos o urgencia (ej: "Lo necesita para marzo 2026")
- decision_maker: Info sobre quien decide (ej: "Debe consultarlo con su socio")
- competitor: Menciones de competencia (ej: "Tiene cotizacion de otra empresa")
- pain_point: Punto de dolor (ej: "Su sitio actual es muy lento y pierde clientes")
- positive_signal: Senal positiva de compra (ej: "Pregunto por formas de pago")
- personal_detail: Dato personal relevante (ej: "Tiene un restaurante en Casco Viejo")

NO incluyas insights que ya existen en la lista proporcionada.
Solo incluye insights con evidencia clara en la conversacion.`;

  const response = await callClaude(systemPrompt, [
    { role: 'user', content: transcript },
  ], { maxTokens: 1024, temperature: 0.3 });

  try {
    const fenceMatch = response.text.match(/```(?:json)?\s*([\s\S]*?)```/);
    const jsonStr = fenceMatch ? fenceMatch[1].trim() : response.text.trim();
    const braceStart = jsonStr.indexOf('{');
    const braceEnd = jsonStr.lastIndexOf('}');
    const cleaned = braceStart !== -1 ? jsonStr.slice(braceStart, braceEnd + 1) : jsonStr;

    const parsed = JSON.parse(cleaned);

    const validCategories = [
      'need', 'objection', 'preference', 'budget', 'timeline',
      'decision_maker', 'competitor', 'pain_point', 'positive_signal', 'personal_detail',
    ];

    const insights = Array.isArray(parsed.insights)
      ? parsed.insights.filter((i: { category?: string; content?: string }) =>
          i.category && validCategories.includes(i.category) && i.content
        )
      : [];

    return {
      summary: parsed.summary || '',
      keyTopics: Array.isArray(parsed.key_topics) ? parsed.key_topics : [],
      insights,
    };
  } catch {
    log.warn('Failed to parse summary response', { preview: response.text.slice(0, 200) });
    return {
      summary: response.text.slice(0, 500),
      keyTopics: [],
      insights: [],
    };
  }
}

async function saveInsights(
  supabase: SupabaseClient,
  contactId: string,
  conversationId: string,
  insights: Array<{ category: string; content: string; confidence: string }>
): Promise<void> {
  const rows = insights.map((i) => ({
    contact_id: contactId,
    category: i.category,
    content: i.content,
    source_conversation_id: conversationId,
    confidence: i.confidence || 'medium',
    is_active: true,
  }));

  const { error } = await supabase.from('client_insights').insert(rows);
  if (error) {
    log.error('Failed to save insights', { error: error.message, count: rows.length });
  }

  const { data: contact } = await supabase
    .from('whatsapp_contacts')
    .select('crm_client_id')
    .eq('id', contactId)
    .maybeSingle();

  if (contact?.crm_client_id) {
    const confidenceMap: Record<string, number> = { high: 0.9, medium: 0.7, low: 0.4 };
    for (const insight of insights) {
      addCrmClientInsight(contact.crm_client_id, {
        sourceType: 'whatsapp',
        insightType: insight.category,
        title: insight.category.replace(/_/g, ' '),
        content: insight.content,
        confidence: confidenceMap[insight.confidence] || 0.7,
      }).catch(() => {});
    }
  }
}

export async function saveInsight(
  supabase: SupabaseClient,
  contactId: string,
  conversationId: string,
  category: string,
  content: string,
  confidence = 'high'
): Promise<void> {
  const { error } = await supabase.from('client_insights').insert({
    contact_id: contactId,
    category,
    content,
    source_conversation_id: conversationId,
    confidence,
    is_active: true,
  });

  if (error) {
    log.error('Failed to save single insight', { error: error.message });
  }
}

export async function getContactInsights(
  supabase: SupabaseClient,
  contactId: string
): Promise<Array<{ category: string; content: string; confidence: string; created_at: string }>> {
  const { data } = await supabase
    .from('client_insights')
    .select('category, content, confidence, created_at')
    .eq('contact_id', contactId)
    .eq('is_active', true)
    .order('created_at', { ascending: false });

  return data || [];
}

export async function getConversationSummaries(
  supabase: SupabaseClient,
  contactId: string,
  conversationId?: string
): Promise<Array<{ summary: string; key_topics: string[]; message_count: number; created_at: string; conversation_id: string }>> {
  let query = supabase
    .from('conversation_summaries')
    .select('summary, key_topics, message_count, created_at, conversation_id')
    .eq('contact_id', contactId)
    .order('created_at', { ascending: false })
    .limit(10);

  if (conversationId) {
    query = supabase
      .from('conversation_summaries')
      .select('summary, key_topics, message_count, created_at, conversation_id')
      .eq('contact_id', contactId)
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: false })
      .limit(10);
  }

  const { data } = await query;
  return data || [];
}
