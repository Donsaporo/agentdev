import { SupabaseClient } from '@supabase/supabase-js';
import { createLogger } from '../core/logger.js';
import { callAISecondary } from '../services/ai.js';
import { sendTextMessage } from '../services/whatsapp.js';
import { getOrAssignPersona } from './persona-engine.js';
import { scheduleMeetingViaCrm } from '../services/calendar.js';

const log = createLogger('director-agent');

const CONFIRMATION_WORDS = ['si', 'sí', 'ok', 'dale', 'listo', 'confirmo', 'perfecto', 'hazlo', 'envía', 'envia', 'envialo', 'yes', 'adelante', 'va'];
const REJECTION_WORDS = ['no', 'cancela', 'cancelar', 'cambiar', 'cambia', 'detener', 'para', 'espera'];

interface DirectorAgentParams {
  supabase: SupabaseClient;
  directorWaId: string;
  content: string;
  conversationId: string;
  contactId: string;
}

async function reply(directorWaId: string, text: string) {
  await sendTextMessage(directorWaId, text).catch((err) => {
    log.error('Failed to reply to director', { error: err instanceof Error ? err.message : String(err) });
  });
}

async function loadConversationContext(supabase: SupabaseClient): Promise<string> {
  const { data: conversations } = await supabase
    .from('whatsapp_conversations')
    .select(`
      id, status, category, agent_mode, last_message_at, unread_count, needs_director_attention, window_status,
      contact:whatsapp_contacts(id, wa_id, phone_number, display_name, company, lead_stage, email, profile_name, crm_client_id),
      persona:sales_agent_personas(full_name)
    `)
    .eq('status', 'active')
    .order('last_message_at', { ascending: false })
    .limit(30);

  if (!conversations || conversations.length === 0) return 'No hay conversaciones activas.';

  const lines: string[] = [];
  for (const conv of conversations) {
    const rawContact = conv.contact as unknown;
    const contact = (Array.isArray(rawContact) ? rawContact[0] : rawContact) as Record<string, string> | null;
    if (!contact) continue;

    const rawPersona = conv.persona as unknown;
    const persona = (Array.isArray(rawPersona) ? rawPersona[0] : rawPersona) as Record<string, string> | null;

    const name = contact.display_name || contact.profile_name || contact.phone_number || '?';
    const mode = conv.agent_mode === 'ai' ? 'IA' : 'Manual';
    const stage = contact.lead_stage || 'nuevo';
    const company = contact.company ? ` (${contact.company})` : '';
    const unread = (conv.unread_count as unknown as number) > 0 ? ` [${conv.unread_count} sin leer]` : '';
    const attention = conv.needs_director_attention ? ' ⚠ATENCION' : '';
    const personaName = persona?.full_name || '';
    const window = conv.window_status === 'closed' ? ' [ventana cerrada]' : '';

    lines.push(`- ${name}${company} | ${stage} | ${mode} | ${personaName}${unread}${attention}${window}`);
  }

  return lines.join('\n');
}

function tokenMatch(haystack: string, query: string): boolean {
  const normalizedFull = query.toLowerCase().replace(/[+\-\s()&.,]/g, '');
  if (haystack.includes(normalizedFull)) return true;

  const tokens = query.toLowerCase().replace(/[&.,]/g, ' ').split(/\s+/).filter((t) => t.length >= 2);
  if (tokens.length === 0) return false;

  return tokens.every((token) => haystack.includes(token));
}

async function searchContact(
  supabase: SupabaseClient,
  query: string
): Promise<{ contact: Record<string, string>; conversationId: string; personaName: string } | null> {
  const normalizedPhone = query.replace(/[+\-\s()]/g, '');

  const { data: conversations } = await supabase
    .from('whatsapp_conversations')
    .select(`
      id, agent_mode,
      contact:whatsapp_contacts(id, wa_id, phone_number, display_name, company, lead_stage, email, profile_name, crm_client_id),
      persona:sales_agent_personas(full_name)
    `)
    .eq('status', 'active')
    .order('last_message_at', { ascending: false })
    .limit(100);

  if (!conversations) return null;

  for (const conv of conversations) {
    const rawContact = conv.contact as unknown;
    const contact = (Array.isArray(rawContact) ? rawContact[0] : rawContact) as Record<string, string> | null;
    if (!contact) continue;

    const name = (contact.display_name || contact.profile_name || '').toLowerCase();
    const company = (contact.company || '').toLowerCase();
    const phone = (contact.phone_number || '').replace(/[+\-\s()]/g, '');
    const waId = (contact.wa_id || '').replace(/[+\-\s()]/g, '');

    const isMatch =
      tokenMatch(name, query) ||
      tokenMatch(company, query) ||
      (name + ' ' + company).includes(query.toLowerCase().replace(/[&.,]/g, '').trim()) ||
      phone.includes(normalizedPhone) ||
      waId.includes(normalizedPhone) ||
      normalizedPhone.includes(phone.slice(-7));

    if (isMatch) {
      const rawPersona = conv.persona as unknown;
      const persona = (Array.isArray(rawPersona) ? rawPersona[0] : rawPersona) as Record<string, string> | null;
      return {
        contact,
        conversationId: conv.id as string,
        personaName: persona?.full_name || '',
      };
    }
  }

  return null;
}

async function getRecentMessages(supabase: SupabaseClient, conversationId: string, limit = 5): Promise<string[]> {
  const { data } = await supabase
    .from('whatsapp_messages')
    .select('direction, content, sender_name, created_at')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: false })
    .limit(limit);

  return (data || []).reverse().map((m) => {
    const who = m.direction === 'inbound' ? 'Cliente' : (m.sender_name || 'Agente');
    return `${who}: ${(m.content || '').slice(0, 200)}`;
  });
}

async function getPendingAction(supabase: SupabaseClient, directorPhone: string) {
  const { data } = await supabase
    .from('director_pending_actions')
    .select('*')
    .eq('director_phone', directorPhone)
    .eq('status', 'pending_confirmation')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  return data;
}

async function expirePendingActions(supabase: SupabaseClient, directorPhone: string) {
  await supabase
    .from('director_pending_actions')
    .update({ status: 'expired', resolved_at: new Date().toISOString() })
    .eq('director_phone', directorPhone)
    .eq('status', 'pending_confirmation');
}

async function createPendingAction(
  supabase: SupabaseClient,
  directorPhone: string,
  actionType: string,
  payload: Record<string, unknown>,
  confirmationMessage: string,
  targetContactId?: string,
  targetConversationId?: string
) {
  await expirePendingActions(supabase, directorPhone);

  await supabase.from('director_pending_actions').insert({
    director_phone: directorPhone,
    action_type: actionType,
    target_contact_id: targetContactId || null,
    target_conversation_id: targetConversationId || null,
    action_payload: payload,
    confirmation_message: confirmationMessage,
    status: 'pending_confirmation',
  });
}

async function executePendingAction(supabase: SupabaseClient, action: Record<string, unknown>, directorWaId: string) {
  const actionType = action.action_type as string;
  const payload = action.action_payload as Record<string, unknown>;
  const contactId = action.target_contact_id as string | null;
  const conversationId = action.target_conversation_id as string | null;

  try {
    switch (actionType) {
      case 'send_message': {
        const targetWaId = payload.target_wa_id as string;
        const message = payload.message as string;
        const result = await sendTextMessage(targetWaId, message);

        if (conversationId && contactId) {
          await supabase.from('whatsapp_messages').insert({
            conversation_id: conversationId,
            contact_id: contactId,
            wa_message_id: result.messageId || '',
            direction: 'outbound',
            message_type: 'text',
            content: message,
            status: 'sent',
            sender_name: payload.persona_name as string || '',
            metadata: { sent_by: 'director_agent', original_instruction: payload.original_instruction },
          });

          await supabase
            .from('whatsapp_conversations')
            .update({
              last_message_at: new Date().toISOString(),
              last_message_preview: message.slice(0, 100),
            })
            .eq('id', conversationId);
        }

        await reply(directorWaId, `Enviado a ${payload.contact_name}: "${message}"`);
        break;
      }

      case 'update_stage': {
        if (contactId) {
          await supabase
            .from('whatsapp_contacts')
            .update({ lead_stage: payload.new_stage as string })
            .eq('id', contactId);
          await reply(directorWaId, `Etapa de ${payload.contact_name} actualizada a "${payload.new_stage}".`);
        }
        break;
      }

      case 'pause_ai': {
        if (conversationId) {
          await supabase
            .from('whatsapp_conversations')
            .update({ agent_mode: 'manual' })
            .eq('id', conversationId);
          await reply(directorWaId, `IA pausada para ${payload.contact_name}.`);
        }
        break;
      }

      case 'resume_ai': {
        if (conversationId) {
          await supabase
            .from('whatsapp_conversations')
            .update({ agent_mode: 'ai' })
            .eq('id', conversationId);
          await reply(directorWaId, `IA reactivada para ${payload.contact_name}.`);
        }
        break;
      }

      case 'schedule_meeting_request': {
        const targetWaId = payload.target_wa_id as string;
        const message = payload.message as string;
        await sendTextMessage(targetWaId, message);

        if (conversationId && contactId) {
          await supabase.from('whatsapp_messages').insert({
            conversation_id: conversationId,
            contact_id: contactId,
            wa_message_id: '',
            direction: 'outbound',
            message_type: 'text',
            content: message,
            status: 'sent',
            sender_name: payload.persona_name as string || '',
            metadata: { sent_by: 'director_agent', purpose: 'meeting_scheduling' },
          });

          await supabase
            .from('whatsapp_conversations')
            .update({
              last_message_at: new Date().toISOString(),
              last_message_preview: message.slice(0, 100),
            })
            .eq('id', conversationId);
        }

        await reply(directorWaId, `Le pregunte a ${payload.contact_name} su disponibilidad. Cuando responda, el agente de IA continuara el flujo de agendamiento automaticamente.`);
        break;
      }

      case 'schedule_meeting_direct': {
        const phone = payload.target_wa_id as string;
        const meetingDate = payload.date as string;
        const startTime = payload.start_time as string;
        const endTime = payload.end_time as string || '';
        const meetingType = (payload.meeting_type as string) || 'virtual';
        const title = (payload.title as string) || `Reunion Obzide - ${payload.contact_name}`;

        const computedEnd = endTime || (() => {
          const [h, m] = startTime.split(':').map(Number);
          const endMin = m + 30;
          return `${String(h + Math.floor(endMin / 60)).padStart(2, '0')}:${String(endMin % 60).padStart(2, '0')}`;
        })();

        const crmResult = await scheduleMeetingViaCrm({
          phoneNumber: phone,
          title,
          date: meetingDate,
          startTime,
          endTime: computedEnd,
          meetingType,
        });

        if (!crmResult.success) {
          let failMsg = `No pude agendar la reunion: ${crmResult.message || crmResult.reason || 'Error desconocido'}`;
          if (crmResult.conflicts && crmResult.conflicts.length > 0) {
            const conflictLines = crmResult.conflicts.map((c) => `- ${c.label}: ${c.time_range}`);
            failMsg += `\n\nConflictos:\n${conflictLines.join('\n')}`;
          }
          await reply(directorWaId, failMsg);
        } else {
          if (conversationId) {
            await supabase.from('sales_meetings').insert({
              conversation_id: conversationId,
              contact_id: contactId || null,
              google_event_id: crmResult.googleEventId || null,
              title,
              start_time: new Date(`${meetingDate}T${startTime}:00-05:00`).toISOString(),
              end_time: new Date(`${meetingDate}T${computedEnd}:00-05:00`).toISOString(),
              meet_link: crmResult.meetLink || null,
              status: 'scheduled',
            });
          }

          const typeLabel = meetingType === 'presencial' ? 'Presencial - PH Plaza Real' : `Virtual${crmResult.meetLink ? ': ' + crmResult.meetLink : ''}`;
          await reply(directorWaId, `Reunion agendada:\n${title}\n${meetingDate} ${startTime}-${computedEnd}\n${typeLabel}`);
        }
        break;
      }

      default:
        await reply(directorWaId, 'Accion ejecutada.');
    }

    await supabase
      .from('director_pending_actions')
      .update({ status: 'confirmed', resolved_at: new Date().toISOString() })
      .eq('id', action.id as string);

  } catch (err) {
    log.error('Failed to execute director action', { actionType, error: err instanceof Error ? err.message : String(err) });
    await reply(directorWaId, `Error al ejecutar la accion: ${err instanceof Error ? err.message : 'Error desconocido'}`);
    await supabase
      .from('director_pending_actions')
      .update({ status: 'failed', resolved_at: new Date().toISOString() })
      .eq('id', action.id as string);
  }
}

function isConfirmation(text: string): boolean {
  const lower = text.toLowerCase().trim();
  return CONFIRMATION_WORDS.some((w) => lower === w || lower.startsWith(w + ' ') || lower.startsWith(w + ','));
}

function isRejection(text: string): boolean {
  const lower = text.toLowerCase().trim();
  return REJECTION_WORDS.some((w) => lower === w || lower.startsWith(w + ' ') || lower.startsWith(w + ','));
}

async function getDirectorHistory(supabase: SupabaseClient, directorWaId: string): Promise<string[]> {
  const { data: contact } = await supabase
    .from('whatsapp_contacts')
    .select('id')
    .eq('wa_id', directorWaId)
    .maybeSingle();

  if (!contact) return [];

  const { data: conversation } = await supabase
    .from('whatsapp_conversations')
    .select('id')
    .eq('contact_id', contact.id)
    .eq('status', 'active')
    .maybeSingle();

  if (!conversation) return [];

  const { data: messages } = await supabase
    .from('whatsapp_messages')
    .select('direction, content, created_at')
    .eq('conversation_id', conversation.id)
    .order('created_at', { ascending: false })
    .limit(10);

  return (messages || []).reverse().map((m) => {
    const who = m.direction === 'inbound' ? 'Director' : 'Sistema';
    return `${who}: ${(m.content || '').slice(0, 300)}`;
  });
}

export async function handleDirectorConversation(params: DirectorAgentParams): Promise<void> {
  const { supabase, directorWaId, content } = params;

  const pendingAction = await getPendingAction(supabase, directorWaId);

  if (pendingAction) {
    if (isConfirmation(content)) {
      await executePendingAction(supabase, pendingAction, directorWaId);
      return;
    }

    if (isRejection(content)) {
      await expirePendingActions(supabase, directorWaId);
      await reply(directorWaId, 'Cancelado. Dime que necesitas.');
      return;
    }

    await expirePendingActions(supabase, directorWaId);
  }

  try {
    const [conversationContext, directorHistory] = await Promise.all([
      loadConversationContext(supabase),
      getDirectorHistory(supabase, directorWaId),
    ]);

    const systemPrompt = `Eres el Centro de Comando de los agentes de ventas de Obzide Tech. El director de ventas te habla por WhatsApp y tu le ayudas a gestionar su equipo de agentes IA.

CONVERSACIONES ACTIVAS:
${conversationContext}

CAPACIDADES:
1. CONSULTAS (sin confirmacion): resumenes, estado de clientes, metricas, buscar info
2. ACCIONES (requieren confirmacion):
   - send_message: Enviar mensaje a un cliente como la persona asignada
   - schedule_meeting_request: Pedirle al cliente cuando le queda bien para una reunion (el agente de IA continuara el flujo). Usa esto cuando NO se tiene fecha/hora especifica.
   - schedule_meeting_direct: Agendar una reunion directamente en el calendario sin preguntarle al cliente. Usa esto cuando el director da una fecha, hora y cliente especificos (ej: "agenda reunion con Juan el martes a las 10").
   - update_stage: Cambiar la etapa de un lead
   - pause_ai: Pausar IA en una conversacion
   - resume_ai: Reactivar IA

FORMATO DE RESPUESTA:
Responde SOLO con JSON valido:
{
  "response_text": "tu mensaje al director (WhatsApp, corto y directo)",
  "action": null | {
    "type": "send_message|schedule_meeting_request|schedule_meeting_direct|update_stage|pause_ai|resume_ai",
    "contact_query": "nombre/telefono para buscar al contacto",
    "params": {}
  }
}

REGLAS:
- Responde en espanol, casual pero profesional
- Si el director pide enviar un mensaje, pon el mensaje en params.message y pide confirmacion en response_text
- Si pide agendar reunion, genera un mensaje natural preguntandole al cliente su disponibilidad (como la persona asignada) en params.message
- Para consultas puras (resumenes, estado, preguntas), action es null
- response_text es lo que VE el director en WhatsApp
- Cuando propongas una accion, describe EXACTAMENTE lo que haras en response_text y termina con "Confirmas?"
- Los mensajes a clientes deben ser CORTOS, naturales, como WhatsApp humano
- Adapta el tono del mensaje al estilo de la persona asignada al contacto
- Para agendar reunion SIN fecha/hora especifica: usa schedule_meeting_request para preguntarle al cliente cuando le queda bien.
- Para agendar reunion CON fecha/hora especifica del director: usa schedule_meeting_direct con params { date: "YYYY-MM-DD", start_time: "HH:MM", end_time: "HH:MM", title: "...", meeting_type: "virtual|presencial" }. Esto agenda directamente sin preguntarle al cliente.

ETAPAS VALIDAS: nuevo, en_proceso, demo_solicitada, cotizacion_enviada, por_cerrar, ganado, perdido`;

    const messages: { role: 'user' | 'assistant'; content: string }[] = [];

    for (const line of directorHistory.slice(-6)) {
      if (line.startsWith('Director: ')) {
        messages.push({ role: 'user', content: line.replace('Director: ', '') });
      } else if (line.startsWith('Sistema: ')) {
        messages.push({ role: 'assistant', content: line.replace('Sistema: ', '') });
      }
    }

    messages.push({ role: 'user', content });

    const response = await callAISecondary(systemPrompt, messages, {
      maxTokens: 800,
      temperature: 0.4,
    });

    let parsed: { response_text: string; action?: { type: string; contact_query: string; params: Record<string, unknown> } | null };

    try {
      const jsonMatch = response.text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        parsed = JSON.parse(jsonMatch[0]);
      } else {
        parsed = { response_text: response.text.trim() };
      }
    } catch {
      parsed = { response_text: response.text.trim().replace(/^```json\s*/, '').replace(/```\s*$/, '') };
      try {
        const retryMatch = parsed.response_text.match(/\{[\s\S]*\}/);
        if (retryMatch) parsed = JSON.parse(retryMatch[0]);
      } catch {
        // keep text as-is
      }
    }

    if (parsed.action && parsed.action.type && parsed.action.contact_query) {
      const found = await searchContact(supabase, parsed.action.contact_query);

      if (!found) {
        await reply(directorWaId, `No encontre ningun contacto con "${parsed.action.contact_query}". Intenta con otro nombre, telefono o empresa.`);
        return;
      }

      const persona = await getOrAssignPersona(supabase, found.conversationId, found.contact.id);
      const actionParams = parsed.action.params || {};

      switch (parsed.action.type) {
        case 'send_message': {
          let finalMessage = actionParams.message as string || '';

          if (finalMessage) {
            try {
              const tonePrompt = `Reescribe este mensaje con el tono y estilo de ${persona.full_name}.
Estilo: ${persona.communication_style || 'profesional y amigable'}
Formalidad: ${persona.formality_level || 'professional_friendly'}
Reglas:
- Mantiene el SIGNIFICADO exacto
- Adapta SOLO el tono
- Formato WhatsApp: corto, natural
- 1-3 oraciones maximo
- Responde SOLO con el texto transformado`;

              const toneRes = await callAISecondary(tonePrompt, [{ role: 'user', content: finalMessage }], {
                maxTokens: 300,
                temperature: 0.6,
              });
              finalMessage = toneRes.text.trim();
            } catch {
              log.warn('Tone transformation failed, using original');
            }
          }

          await createPendingAction(
            supabase,
            directorWaId,
            'send_message',
            {
              target_wa_id: found.contact.wa_id || found.contact.phone_number,
              message: finalMessage,
              contact_name: found.contact.display_name || found.contact.phone_number,
              persona_name: persona.full_name,
              original_instruction: content,
            },
            parsed.response_text,
            found.contact.id,
            found.conversationId
          );

          const confirmText = `Enviare a ${found.contact.display_name || found.contact.phone_number} como ${persona.full_name}:\n\n"${finalMessage}"\n\nConfirmas?`;
          await reply(directorWaId, confirmText);
          break;
        }

        case 'schedule_meeting_request': {
          let meetingMsg = actionParams.message as string || '';

          if (!meetingMsg) {
            meetingMsg = `Hola! Queria ver si podemos agendar una reunion para conversar sobre el proyecto. Que dias y horarios te quedan mejor esta semana?`;
          }

          try {
            const tonePrompt = `Reescribe este mensaje con el tono de ${persona.full_name}.
Estilo: ${persona.communication_style || 'profesional y amigable'}
Reglas: Mantiene significado, adapta tono, formato WhatsApp corto y natural. Responde SOLO con el texto.`;

            const toneRes = await callAISecondary(tonePrompt, [{ role: 'user', content: meetingMsg }], {
              maxTokens: 300,
              temperature: 0.6,
            });
            meetingMsg = toneRes.text.trim();
          } catch {
            log.warn('Meeting message tone failed, using original');
          }

          await createPendingAction(
            supabase,
            directorWaId,
            'schedule_meeting_request',
            {
              target_wa_id: found.contact.wa_id || found.contact.phone_number,
              message: meetingMsg,
              contact_name: found.contact.display_name || found.contact.phone_number,
              persona_name: persona.full_name,
            },
            parsed.response_text,
            found.contact.id,
            found.conversationId
          );

          const confirmText = `Le preguntare a ${found.contact.display_name || found.contact.phone_number} como ${persona.full_name}:\n\n"${meetingMsg}"\n\nCuando responda, el agente agendara automaticamente en el calendar. Confirmas?`;
          await reply(directorWaId, confirmText);
          break;
        }

        case 'schedule_meeting_direct': {
          const meetDate = actionParams.date as string || '';
          const meetStart = actionParams.start_time as string || '';
          const meetEnd = actionParams.end_time as string || '';
          const meetType = (actionParams.meeting_type as string) || 'virtual';
          const meetTitle = (actionParams.title as string) || `Reunion Obzide - ${found.contact.display_name || 'Cliente'}`;

          if (!meetDate || !meetStart) {
            await reply(directorWaId, 'Necesito al menos la fecha y hora de inicio para agendar. Ejemplo: "agenda reunion con Juan el martes a las 10am"');
            break;
          }

          await createPendingAction(
            supabase,
            directorWaId,
            'schedule_meeting_direct',
            {
              target_wa_id: found.contact.wa_id || found.contact.phone_number,
              contact_name: found.contact.display_name || found.contact.phone_number,
              date: meetDate,
              start_time: meetStart,
              end_time: meetEnd,
              meeting_type: meetType,
              title: meetTitle,
            },
            parsed.response_text,
            found.contact.id,
            found.conversationId
          );

          const typeLabel = meetType === 'presencial' ? 'presencial en PH Plaza Real' : 'virtual con Google Meet';
          await reply(directorWaId, `Agendar reunion ${typeLabel}:\n${meetTitle}\n${meetDate} ${meetStart}${meetEnd ? '-' + meetEnd : ''}\nCliente: ${found.contact.display_name || found.contact.phone_number}\n\nConfirmas?`);
          break;
        }

        case 'update_stage': {
          const newStage = actionParams.stage as string || actionParams.new_stage as string || '';
          await createPendingAction(
            supabase,
            directorWaId,
            'update_stage',
            {
              new_stage: newStage,
              contact_name: found.contact.display_name || found.contact.phone_number,
            },
            parsed.response_text,
            found.contact.id,
            found.conversationId
          );
          await reply(directorWaId, `Cambiar etapa de ${found.contact.display_name} a "${newStage}". Confirmas?`);
          break;
        }

        case 'pause_ai': {
          await createPendingAction(
            supabase,
            directorWaId,
            'pause_ai',
            { contact_name: found.contact.display_name || found.contact.phone_number },
            parsed.response_text,
            found.contact.id,
            found.conversationId
          );
          await reply(directorWaId, `Pausar IA para ${found.contact.display_name}. Confirmas?`);
          break;
        }

        case 'resume_ai': {
          await createPendingAction(
            supabase,
            directorWaId,
            'resume_ai',
            { contact_name: found.contact.display_name || found.contact.phone_number },
            parsed.response_text,
            found.contact.id,
            found.conversationId
          );
          await reply(directorWaId, `Reactivar IA para ${found.contact.display_name}. Confirmas?`);
          break;
        }

        default:
          await reply(directorWaId, parsed.response_text || 'No entendi la accion. Intenta de nuevo.');
      }
    } else {
      await reply(directorWaId, parsed.response_text || 'No pude procesar tu solicitud. Intenta de nuevo.');
    }
  } catch (err) {
    log.error('Director agent error', { error: err instanceof Error ? err.message : String(err) });
    await reply(directorWaId, 'Hubo un error procesando tu solicitud. Usa $ayuda para ver todos los comandos disponibles.');
  }
}
