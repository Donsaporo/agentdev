import { createLogger } from '../core/logger.js';
import { callClaude, ClaudeMessage } from '../services/claude.js';
import { ConversationContext } from './context-builder.js';

const log = createLogger('decision-engine');

export interface AgentDecision {
  responseText: string;
  actions: AgentAction[];
  reasoning: string;
  shouldEscalate: boolean;
  escalationReason: string;
  inputTokens: number;
  outputTokens: number;
  model: string;
}

export interface AgentAction {
  type: 'update_lead_stage' | 'schedule_meeting' | 'create_crm_lead' | 'escalate' | 'add_note';
  params: Record<string, string>;
}

function buildSystemPrompt(ctx: ConversationContext): string {
  const instructionBlock =
    ctx.instructions.length > 0
      ? ctx.instructions
          .map((i) => `[${i.priority.toUpperCase()}] ${i.instruction}`)
          .join('\n')
      : 'No hay instrucciones especificas configuradas.';

  const knowledgeBlock =
    ctx.knowledge.length > 0
      ? ctx.knowledge.map((k) => `## ${k.title}\n${k.content}`).join('\n\n')
      : 'No hay informacion de conocimiento cargada aun.';

  return `Eres ${ctx.persona.full_name}, ${ctx.persona.job_title} en Obzide Tech.
${ctx.persona.communication_style ? `Estilo de comunicacion: ${ctx.persona.communication_style}` : ''}
${ctx.persona.personality_traits?.length ? `Rasgos: ${ctx.persona.personality_traits.join(', ')}` : ''}

Estas conversando por WhatsApp con ${ctx.contactName}.
${ctx.contactCompany ? `Empresa: ${ctx.contactCompany}` : ''}
${ctx.contactEmail ? `Email: ${ctx.contactEmail}` : ''}
Etapa del lead: ${ctx.leadStage}
${ctx.crmNotes ? `Notas: ${ctx.crmNotes}` : ''}

=== INSTRUCCIONES ACTIVAS ===
${instructionBlock}

=== BASE DE CONOCIMIENTO ===
${knowledgeBlock}

=== REGLAS ===
- Responde SIEMPRE en espanol, de forma natural y humana
- No uses emojis excesivos, maximo 1-2 por mensaje si es apropiado
- Adapta la longitud de tu respuesta al contexto (preferencia: ${ctx.persona.response_length || 'medium'})
- Si no sabes algo, NO inventes. Di que vas a verificar con el equipo
- Si el cliente pide algo fuera de tu alcance o capacidad, escala la conversacion
- Nunca reveles que eres una IA

Responde en formato JSON con esta estructura exacta:
{
  "response_text": "tu mensaje para el cliente",
  "actions": [],
  "reasoning": "por que decidiste responder asi (interno, el cliente no ve esto)",
  "should_escalate": false,
  "escalation_reason": ""
}

Acciones disponibles:
- {"type": "update_lead_stage", "params": {"stage": "contacted|qualified|proposal|negotiation|won|lost"}}
- {"type": "schedule_meeting", "params": {"title": "...", "datetime": "ISO8601"}}
- {"type": "create_crm_lead", "params": {"name": "...", "email": "...", "company": "..."}}
- {"type": "escalate", "params": {"reason": "..."}}
- {"type": "add_note", "params": {"note": "..."}}`;
}

export async function decide(
  ctx: ConversationContext,
  incomingMessage: string
): Promise<AgentDecision> {
  const systemPrompt = buildSystemPrompt(ctx);

  const claudeMessages: ClaudeMessage[] = [
    ...ctx.messageHistory.slice(-20).map((m) => ({
      role: m.role as 'user' | 'assistant',
      content: m.content,
    })),
    { role: 'user', content: incomingMessage },
  ];

  const response = await callClaude(systemPrompt, claudeMessages, {
    maxTokens: 1024,
    temperature: 0.7,
  });

  try {
    const parsed = JSON.parse(response.text);

    const decision: AgentDecision = {
      responseText: parsed.response_text || '',
      actions: (parsed.actions || []) as AgentAction[],
      reasoning: parsed.reasoning || '',
      shouldEscalate: parsed.should_escalate || false,
      escalationReason: parsed.escalation_reason || '',
      inputTokens: response.inputTokens,
      outputTokens: response.outputTokens,
      model: response.model,
    };

    log.info('Decision made', {
      contact: ctx.contactName,
      actions: decision.actions.length,
      escalate: decision.shouldEscalate,
      tokens: decision.inputTokens + decision.outputTokens,
    });

    return decision;
  } catch {
    log.warn('Failed to parse Claude response as JSON, using raw text');
    return {
      responseText: response.text,
      actions: [],
      reasoning: 'Fallback: could not parse structured response',
      shouldEscalate: false,
      escalationReason: '',
      inputTokens: response.inputTokens,
      outputTokens: response.outputTokens,
      model: response.model,
    };
  }
}
