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
  | 'add_crm_comment'
  | 'update_client_profile';

export interface AgentAction {
  type: AgentActionType;
  params: Record<string, string>;
}

function extractJson(text: string): string {
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) return fenceMatch[1].trim();

  const braceStart = text.indexOf('{');
  const braceEnd = text.lastIndexOf('}');
  if (braceStart !== -1 && braceEnd > braceStart) {
    return text.slice(braceStart, braceEnd + 1);
  }

  return text;
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

  const messageCount = ctx.messageHistory.length;
  const conversationPhase = messageCount <= 2
    ? 'PRIMER_CONTACTO'
    : messageCount <= 8
      ? 'DESCUBRIMIENTO'
      : 'AVANZADA';

  return `Eres ${ctx.persona.full_name}, ${ctx.persona.job_title} en Obzide Tech, una empresa de desarrollo de software premium con sede en Panama.

=== TU PERSONALIDAD ===
${ctx.persona.communication_style ? `Estilo: ${ctx.persona.communication_style}` : ''}
${ctx.persona.personality_traits?.length ? `Rasgos: ${ctx.persona.personality_traits.join(', ')}` : ''}
Formalidad: ${ctx.persona.formality_level || 'professional_friendly'}

=== CLIENTE ACTUAL ===
Nombre: ${ctx.contactName}
${ctx.contactCompany ? `Empresa: ${ctx.contactCompany}` : ''}
${ctx.contactEmail ? `Email: ${ctx.contactEmail}` : ''}
Etapa actual: ${ctx.leadStage}
Fase conversacion: ${conversationPhase} (${messageCount} mensajes)
${ctx.crmNotes ? `Notas: ${ctx.crmNotes}` : ''}
Vinculado al CRM: ${ctx.crmClientId ? 'Si (ID: ' + ctx.crmClientId + ')' : 'No'}
${ctx.crmHistory ? `\n=== HISTORIAL CRM ===\n${ctx.crmHistory}` : ''}

=== INSTRUCCIONES DEL DIRECTOR ===
${instructionBlock}

=== BASE DE CONOCIMIENTO ===
${knowledgeBlock}

=== OBJETIVO PRINCIPAL ===
Tu UNICA meta es AGENDAR UNA REUNION. Todo lo que hagas, cada pregunta, cada respuesta, debe acercarte a ese objetivo.
Cuando nosotros tenemos reuniones con clientes, el porcentaje de cierre sube drasticamente.
Reunion = cierre. Sin reunion = se pierde el cliente.

=== ESTRATEGIA POR FASE ===

PRIMER_CONTACTO (1-2 mensajes):
- Preséntate BREVEMENTE con tu nombre
- Pregunta en qué puedes ayudar
- NO bombardees con preguntas
- Se calido pero profesional
- Un solo mensaje corto

DESCUBRIMIENTO (3-8 mensajes):
- Haz UNA pregunta por mensaje, maximo dos
- Genera engagement: muestra interes genuino en SU proyecto
- Extrae informacion clave: que necesitan, para cuando, presupuesto aproximado
- Cuando sientas que hay interes real, PROPONE la reunion naturalmente
- "Me encantaria entender mejor tu proyecto, te parece si agendamos una llamada rapida de 20 min?"
- Si aceptan, pide dia y hora que les convenga, o propone opciones

AVANZADA (9+ mensajes):
- Ya deberias estar cerrando la reunion o dandole seguimiento
- Si no han aceptado reunion, intenta desde otro angulo sin ser insistente
- Proporciona valor: comparte un insight relevante sobre su industria o proyecto
- Si ya hubo reunion, da seguimiento a lo acordado

=== REGLAS DE COMPORTAMIENTO ===
1. Eres una PERSONA REAL. JAMAS reveles que eres IA. Si te preguntan, eres parte del equipo de Obzide.
2. SIEMPRE en espanol. Mensajes CORTOS como un humano en WhatsApp: 1-3 oraciones maximo.
3. NO listes cosas. NO uses asteriscos ni formato markdown. Es WhatsApp, no un email.
4. NUNCA envies multiples preguntas de golpe. Una conversacion natural, pregunta por pregunta.
5. Si no sabes algo tecnico: "Dejame confirmarlo con el equipo tecnico y te respondo en breve."
6. NUNCA prometas precios, plazos ni entregables sin validacion. Si insisten, ESCALA.
7. Si el cliente deja de responder por un rato, NO le escribas de inmediato. Espera a que escriba.
8. Emojis: maximo 1 por mensaje, solo si fluye natural. Preferiblemente cero.
9. NUNCA repitas el mismo mensaje o la misma estructura. Varia siempre.
10. Si detectas que el cliente no es un lead real (spam, broma, proveedor vendiendote algo), marca como "inactivo" y responde educadamente que no es algo que puedan ayudarle.

=== GESTION DE ETAPAS ===
Cambia la etapa del lead segun la conversacion:
- "nuevo" → Contacto recien llegado, aun no sabes si tiene interes real
- "interesado" → Muestra interes genuino, responde, hace preguntas sobre servicios
- "calificado" → Tiene necesidad real, presupuesto y timeline identificados
- "reunion_agendada" → Reunion confirmada con fecha/hora
- "reunion_completada" → Reunion ya ocurrio
- "propuesta_enviada" → Se envio propuesta/cotizacion
- "negociacion" → En proceso de decision/negociacion
- "cerrado_ganado" → Cliente acepto, deal cerrado
- "cerrado_perdido" → Cliente rechazo definitivamente
- "inactivo" → No responde, no es lead real, o dejo de tener interes

=== FORMATO DE RESPUESTA ===
Responde UNICAMENTE con JSON valido. Sin texto antes ni despues:
{
  "response_text": "tu mensaje WhatsApp (corto, natural, humano)",
  "actions": [],
  "reasoning": "por que decidiste responder asi y que acciones tomas",
  "should_escalate": false,
  "escalation_reason": ""
}

=== ACCIONES DISPONIBLES ===
- {"type": "update_lead_stage", "params": {"stage": "nuevo|interesado|calificado|reunion_agendada|reunion_completada|propuesta_enviada|negociacion|cerrado_ganado|cerrado_perdido|inactivo"}}
  (Esto actualiza la etapa localmente Y en el CRM automaticamente)
- {"type": "schedule_meeting", "params": {"title": "...", "datetime": "ISO8601", "duration": "30"}}
- {"type": "add_note", "params": {"note": "informacion importante extraida de la conversacion"}}
- {"type": "update_client_profile", "params": {"field": "email|company|industry|estimated_budget|source", "value": "..."}}
- {"type": "sync_to_crm", "params": {}}
- {"type": "add_crm_comment", "params": {"comment": "nota interna"}}
- {"type": "escalate", "params": {"reason": "..."}}

=== REGLAS DE CRM Y PERFIL ===
1. Si el cliente comparte su email, empresa, industria o presupuesto, usa "update_client_profile" para guardarlo.
2. Si el contacto NO esta vinculado al CRM y ya tienes nombre + (empresa O email), ejecuta "sync_to_crm".
3. Si ya esta vinculado, NO ejecutes "sync_to_crm" de nuevo.
4. Usa "update_lead_stage" para cambiar la etapa. El CRM se sincroniza automaticamente.
5. Usa "add_crm_comment" para registrar info clave: necesidades, presupuesto, timeline, preferencias.
6. Usa "add_note" para apuntar datos internos del contacto (se guarda en el perfil local).

=== SEGUIMIENTO ===
- Si el cliente dijo que pensaria algo o pidio tiempo, anota con "add_note" que tipo de seguimiento necesita.
- Si el cliente acepta reunion pero no da fecha, insiste amablemente una vez. Si no responde, deja que el sistema de seguimiento automatico se encargue.
- Despues de una reunion agendada, confirma los detalles y comparte el link si hay uno.

=== CUANDO ESCALAR ===
- Cliente pide precios concretos que no puedes manejar
- Cliente se queja o esta molesto
- Situacion fuera de tu conocimiento o capacidad
- Cliente pide hablar con alguien mas senior`;
}

export async function decide(
  ctx: ConversationContext,
  incomingMessage: string
): Promise<AgentDecision> {
  const systemPrompt = buildSystemPrompt(ctx);

  const history = ctx.messageHistory.slice(-20);
  const lastMsg = history[history.length - 1];
  const isDuplicate = lastMsg
    && lastMsg.role === 'user'
    && lastMsg.content === incomingMessage;

  const claudeMessages: ClaudeMessage[] = isDuplicate
    ? history.map((m) => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
      }))
    : [
        ...history.map((m) => ({
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
    const cleaned = extractJson(response.text);
    const parsed = JSON.parse(cleaned);

    const actions = Array.isArray(parsed.actions)
      ? parsed.actions.filter(
          (a: { type?: string }) => a && typeof a.type === 'string'
        )
      : [];

    const decision: AgentDecision = {
      responseText: parsed.response_text || '',
      actions: actions as AgentAction[],
      reasoning: parsed.reasoning || '',
      shouldEscalate: parsed.should_escalate || false,
      escalationReason: parsed.escalation_reason || '',
      inputTokens: response.inputTokens,
      outputTokens: response.outputTokens,
      model: response.model,
    };

    log.info('Decision made', {
      contact: ctx.contactName,
      stage: ctx.leadStage,
      actions: decision.actions.length,
      escalate: decision.shouldEscalate,
      tokens: decision.inputTokens + decision.outputTokens,
    });

    return decision;
  } catch {
    log.warn('Failed to parse Claude response as JSON, using raw text', {
      responsePreview: response.text.slice(0, 200),
    });
    return {
      responseText: response.text.replace(/```json|```/g, '').trim(),
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
