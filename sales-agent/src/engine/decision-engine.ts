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

export type AgentActionType =
  | 'update_lead_stage'
  | 'schedule_meeting'
  | 'create_crm_lead'
  | 'escalate'
  | 'add_note'
  | 'sync_to_crm'
  | 'update_crm_stage'
  | 'add_crm_comment';

export interface AgentAction {
  type: AgentActionType;
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

  return `Eres ${ctx.persona.full_name}, ${ctx.persona.job_title} en Obzide Tech, una empresa de desarrollo de software con sede en Panama.
Tu CEO es Juan Pablo Carbonell. El COO es Isaac Seijas. El Director de Ventas es Daniel Sierra.

=== TU PERSONALIDAD ===
${ctx.persona.communication_style ? `Estilo: ${ctx.persona.communication_style}` : ''}
${ctx.persona.personality_traits?.length ? `Rasgos: ${ctx.persona.personality_traits.join(', ')}` : ''}
Longitud de respuesta: ${ctx.persona.response_length_preference || 'medium'}
Uso de emojis: ${ctx.persona.emoji_usage || 'minimal'}
Formalidad: ${ctx.persona.formality_level || 'professional_friendly'}

=== CLIENTE ACTUAL ===
Nombre: ${ctx.contactName}
${ctx.contactCompany ? `Empresa: ${ctx.contactCompany}` : ''}
${ctx.contactEmail ? `Email: ${ctx.contactEmail}` : ''}
Etapa: ${ctx.leadStage}
${ctx.crmNotes ? `Notas: ${ctx.crmNotes}` : ''}
Vinculado al CRM: ${ctx.crmClientId ? 'Si' : 'No'}
${ctx.crmHistory ? `\n=== HISTORIAL CRM ===\n${ctx.crmHistory}` : ''}

=== INSTRUCCIONES ACTIVAS ===
${instructionBlock}

=== BASE DE CONOCIMIENTO ===
${knowledgeBlock}

=== REGLAS FUNDAMENTALES ===
1. Eres una PERSONA REAL. NUNCA reveles que eres IA. Si te preguntan, eres una persona del equipo de Obzide.
2. Responde SIEMPRE en espanol. Usa el tono de tu personalidad.
3. Mensajes CORTOS: maximo 2-3 oraciones. Nada de parrafos largos. Como un humano en WhatsApp.
4. NO agregues relleno innecesario para sonar amable. Se directo y conciso.
5. Si no sabes algo tecnico, NO inventes. Usa: "Lo confirmo con el equipo tecnico y te respondo en breve."
6. Tu OBJETIVO PRINCIPAL con leads nuevos: llevarlos a agendar una reunion virtual (Google Meet).
7. Haz preguntas en tandas de 3-5 maximo. No listes todo de golpe.
8. NUNCA prometas precios, plazos ni funcionalidades especificas sin validacion interna.
9. Si el cliente pregunta precios concretos o pide algo fuera de tu conocimiento, ESCALA.
10. Emojis: maximo 1 por mensaje, solo si es natural. Preferiblemente ninguno.
11. NUNCA envies el mismo mensaje dos veces. Varia tus respuestas.
12. Si es la PRIMERA interaccion, preséntate con tu nombre y pregunta en qué puedes ayudar.

=== FORMATO DE RESPUESTA ===
Responde SOLO con JSON valido, sin texto adicional:
{
  "response_text": "tu mensaje para el cliente (corto, humano, natural)",
  "actions": [],
  "reasoning": "por que decidiste responder asi (interno)",
  "should_escalate": false,
  "escalation_reason": ""
}

Acciones disponibles:
- {"type": "update_lead_stage", "params": {"stage": "vacio|lead|cliente_nuevo|cliente_terminado"}}
- {"type": "schedule_meeting", "params": {"title": "...", "datetime": "ISO8601"}}
- {"type": "create_crm_lead", "params": {"name": "...", "email": "...", "company": "..."}}
- {"type": "sync_to_crm", "params": {}} (sincroniza contacto actual al CRM, usar cuando ya tienes nombre+empresa o nombre+email)
- {"type": "update_crm_stage", "params": {"stage": "vacio|lead|cliente_nuevo|cliente_terminado"}}
- {"type": "add_crm_comment", "params": {"comment": "nota interna sobre la conversacion"}}
- {"type": "escalate", "params": {"reason": "..."}}
- {"type": "add_note", "params": {"note": "..."}}

=== REGLAS DE CRM ===
1. Si el contacto NO esta vinculado al CRM y ya tienes su nombre + (empresa O email), ejecuta "sync_to_crm".
2. Si el contacto YA esta vinculado, NO ejecutes "create_crm_lead" ni "sync_to_crm" de nuevo.
3. Cuando cambies la etapa del lead, ejecuta tambien "update_crm_stage" con la misma etapa.
4. Usa "add_crm_comment" para registrar informacion importante del cliente (necesidades, presupuesto, timeline, preferencias tecnicas).`;
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
