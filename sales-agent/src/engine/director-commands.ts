import { SupabaseClient } from '@supabase/supabase-js';
import { createLogger } from '../core/logger.js';
import { sendTextMessage } from '../services/whatsapp.js';
import { callAISecondary } from '../services/ai.js';
import { getOrAssignPersona } from './persona-engine.js';
import { handleDirectorConversation } from './director-agent.js';

const log = createLogger('director-commands');

interface DirectorMessage {
  conversationId: string;
  contactId: string;
  content: string;
  directorWaId: string;
}

interface ContactMatch {
  id: string;
  wa_id: string;
  phone_number: string;
  display_name: string;
  company: string;
  lead_stage: string;
  email: string;
  conversationId: string;
  conversationCategory: string;
  agentMode: string;
  personaName: string | null;
  lastMessageAt: string;
  unreadCount: number;
}

async function reply(directorWaId: string, text: string) {
  await sendTextMessage(directorWaId, text).catch((err) => {
    log.error('Failed to reply to director', { error: err instanceof Error ? err.message : String(err) });
  });
}

function tokenMatch(haystack: string, query: string): boolean {
  const normalizedFull = query.toLowerCase().replace(/[+\-\s()&.,]/g, '');
  if (haystack.includes(normalizedFull)) return true;

  const tokens = query.toLowerCase().replace(/[&.,]/g, ' ').split(/\s+/).filter((t) => t.length >= 2);
  if (tokens.length === 0) return false;

  return tokens.every((token) => haystack.includes(token));
}

async function searchContacts(
  supabase: SupabaseClient,
  query: string
): Promise<ContactMatch[]> {
  const normalizedPhone = query.replace(/[+\-\s()]/g, '');

  const { data: conversations } = await supabase
    .from('whatsapp_conversations')
    .select(`
      id, status, category, agent_mode, last_message_at, unread_count, agent_persona_id,
      contact:whatsapp_contacts(id, wa_id, phone_number, display_name, company, lead_stage, email, profile_name),
      persona:sales_agent_personas(full_name)
    `)
    .eq('status', 'active')
    .order('last_message_at', { ascending: false })
    .limit(100);

  if (!conversations) return [];

  const matches: ContactMatch[] = [];

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
      matches.push({
        id: contact.id,
        wa_id: contact.wa_id,
        phone_number: contact.phone_number,
        display_name: contact.display_name || contact.profile_name || contact.phone_number,
        company: contact.company || '',
        lead_stage: contact.lead_stage || 'nuevo',
        email: contact.email || '',
        conversationId: conv.id,
        conversationCategory: (conv.category as string) || '',
        agentMode: (conv.agent_mode as string) || 'ai',
        personaName: persona?.full_name || null,
        lastMessageAt: conv.last_message_at as string,
        unreadCount: conv.unread_count as number,
      });
    }
  }

  return matches;
}

function parseCommand(text: string): { command: string; args: string } | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('$')) return null;

  const spaceIndex = trimmed.indexOf(' ');
  if (spaceIndex === -1) {
    return { command: trimmed.slice(1).toLowerCase(), args: '' };
  }

  return {
    command: trimmed.slice(1, spaceIndex).toLowerCase(),
    args: trimmed.slice(spaceIndex + 1).trim(),
  };
}

function splitArgs(args: string): { clientRef: string; message: string } {
  const parts = args.match(/^(\S+)\s+([\s\S]+)$/);
  if (!parts) return { clientRef: args, message: '' };
  return { clientRef: parts[1], message: parts[2] };
}

async function handleChatear(
  supabase: SupabaseClient,
  directorWaId: string,
  args: string
) {
  if (!args) {
    await reply(directorWaId, 'Uso: $chatear <nombre_cliente> <mensaje>\nEjemplo: $chatear juan Hola, como va todo?');
    return;
  }

  const { clientRef, message } = splitArgs(args);
  if (!message) {
    await reply(directorWaId, 'Falta el mensaje. Uso: $chatear <nombre_cliente> <mensaje>');
    return;
  }

  const matches = await searchContacts(supabase, clientRef);

  if (matches.length === 0) {
    await reply(directorWaId, `No encontre ningun cliente con "${clientRef}". Intenta con nombre, telefono o empresa.`);
    return;
  }

  if (matches.length > 1) {
    const list = matches.slice(0, 5).map((m, i) =>
      `${i + 1}. ${m.display_name}${m.company ? ` (${m.company})` : ''} - ${m.phone_number}`
    ).join('\n');
    await reply(directorWaId, `Encontre ${matches.length} resultados. Se mas especifico:\n${list}`);
    return;
  }

  const target = matches[0];
  const persona = await getOrAssignPersona(supabase, target.conversationId, target.id);

  let finalMessage = message;
  try {
    const systemPrompt = `Eres un transformador de mensajes. Reescribe este mensaje informal del director de ventas con el tono y estilo de ${persona.full_name}.
Estilo: ${persona.communication_style || 'profesional y amigable'}
Formalidad: ${persona.formality_level || 'professional_friendly'}
Reglas:
- Mantiene el SIGNIFICADO exacto
- Adapta SOLO el tono
- Formato WhatsApp: corto, natural
- 1-3 oraciones maximo
- Responde SOLO con el texto transformado`;

    const res = await callAISecondary(systemPrompt, [{ role: 'user', content: message }], {
      maxTokens: 300,
      temperature: 0.6,
    });
    finalMessage = res.text.trim();
  } catch {
    log.warn('Tone transformation failed, sending original');
  }

  const result = await sendTextMessage(target.wa_id || target.phone_number, finalMessage);

  await supabase.from('whatsapp_messages').insert({
    conversation_id: target.conversationId,
    contact_id: target.id,
    wa_message_id: result.messageId || '',
    direction: 'outbound',
    message_type: 'text',
    content: finalMessage,
    status: 'sent',
    sender_name: persona.full_name,
    metadata: { sent_by: 'director_command', original_message: message },
  });

  await supabase
    .from('whatsapp_conversations')
    .update({
      last_message_at: new Date().toISOString(),
      last_message_preview: finalMessage.slice(0, 100),
    })
    .eq('id', target.conversationId);

  await reply(directorWaId, `Enviado a ${target.display_name} como ${persona.full_name}:\n"${finalMessage}"`);
  log.info('Director chatear command executed', { target: target.display_name, persona: persona.full_name });
}

async function handleEstado(
  supabase: SupabaseClient,
  directorWaId: string,
  args: string
) {
  if (!args) {
    await reply(directorWaId, 'Uso: $estado <nombre_cliente>');
    return;
  }

  const matches = await searchContacts(supabase, args);

  if (matches.length === 0) {
    await reply(directorWaId, `No encontre ningun cliente con "${args}".`);
    return;
  }

  const target = matches[0];

  const { data: recentMsgs } = await supabase
    .from('whatsapp_messages')
    .select('direction, content, created_at')
    .eq('conversation_id', target.conversationId)
    .order('created_at', { ascending: false })
    .limit(3);

  const lastMsgSummary = (recentMsgs || [])
    .reverse()
    .map((m) => `${m.direction === 'inbound' ? 'Cliente' : 'Agente'}: ${(m.content || '').slice(0, 60)}`)
    .join('\n');

  const timeAgo = target.lastMessageAt
    ? formatTimeAgo(new Date(target.lastMessageAt))
    : 'Sin mensajes';

  const status = [
    `*${target.display_name}*`,
    target.company ? `Empresa: ${target.company}` : '',
    `Etapa: ${target.lead_stage}`,
    `Modo: ${target.agentMode === 'ai' ? 'IA' : 'Manual'}`,
    target.personaName ? `Persona: ${target.personaName}` : '',
    `Ultimo msg: ${timeAgo}`,
    target.email ? `Email: ${target.email}` : '',
    '',
    'Ultimos mensajes:',
    lastMsgSummary || '(sin mensajes)',
  ].filter(Boolean).join('\n');

  await reply(directorWaId, status);
}

async function handlePausar(
  supabase: SupabaseClient,
  directorWaId: string,
  args: string
) {
  if (!args) {
    await reply(directorWaId, 'Uso: $pausar <nombre_cliente>');
    return;
  }

  const matches = await searchContacts(supabase, args);
  if (matches.length === 0) {
    await reply(directorWaId, `No encontre ningun cliente con "${args}".`);
    return;
  }

  const target = matches[0];
  await supabase
    .from('whatsapp_conversations')
    .update({ agent_mode: 'manual' })
    .eq('id', target.conversationId);

  await reply(directorWaId, `IA pausada para ${target.display_name}. La conversacion esta en modo manual.`);
  log.info('Director paused AI', { target: target.display_name });
}

async function handleReanudar(
  supabase: SupabaseClient,
  directorWaId: string,
  args: string
) {
  if (!args) {
    await reply(directorWaId, 'Uso: $reanudar <nombre_cliente>');
    return;
  }

  const matches = await searchContacts(supabase, args);
  if (matches.length === 0) {
    await reply(directorWaId, `No encontre ningun cliente con "${args}".`);
    return;
  }

  const target = matches[0];
  await supabase
    .from('whatsapp_conversations')
    .update({ agent_mode: 'ai' })
    .eq('id', target.conversationId);

  await reply(directorWaId, `IA reactivada para ${target.display_name}.`);
  log.info('Director resumed AI', { target: target.display_name });
}

async function handleResumen(
  supabase: SupabaseClient,
  directorWaId: string
) {
  const { data: conversations } = await supabase
    .from('whatsapp_conversations')
    .select(`
      id, category, agent_mode, last_message_at, unread_count, needs_director_attention,
      contact:whatsapp_contacts(display_name, phone_number, lead_stage, company)
    `)
    .eq('status', 'active')
    .order('last_message_at', { ascending: false })
    .limit(15);

  if (!conversations || conversations.length === 0) {
    await reply(directorWaId, 'No hay conversaciones activas.');
    return;
  }

  const escalated = conversations.filter(c => c.needs_director_attention);
  const lines: string[] = [];

  if (escalated.length > 0) {
    lines.push(`ESCALACIONES (${escalated.length}):`);
    for (const c of escalated) {
      const rawContact = c.contact as unknown;
      const contact = (Array.isArray(rawContact) ? rawContact[0] : rawContact) as Record<string, string> | null;
      const name = contact?.display_name || contact?.phone_number || '?';
      lines.push(`  ! ${name} - ${contact?.lead_stage || '?'}`);
    }
    lines.push('');
  }

  lines.push(`CONVERSACIONES ACTIVAS (${conversations.length}):`);
  for (const c of conversations) {
    const rawContact = c.contact as unknown;
    const contact = (Array.isArray(rawContact) ? rawContact[0] : rawContact) as Record<string, string> | null;
    const name = contact?.display_name || contact?.phone_number || '?';
    const mode = c.agent_mode === 'ai' ? 'IA' : 'Manual';
    const stage = contact?.lead_stage || '?';
    const timeAgo = c.last_message_at ? formatTimeAgo(new Date(c.last_message_at as string)) : '?';
    const unread = (c.unread_count as number) > 0 ? ` (${c.unread_count} sin leer)` : '';
    lines.push(`  ${name} | ${stage} | ${mode} | ${timeAgo}${unread}`);
  }

  await reply(directorWaId, lines.join('\n'));
}

async function handleReunion(
  supabase: SupabaseClient,
  directorWaId: string,
  args: string
) {
  if (!args) {
    await reply(directorWaId, 'Uso: $reunion <cliente> <fecha> <hora>\nEjemplo: $reunion juan 2026-03-20 10:00\nFecha formato: YYYY-MM-DD\nHora formato: HH:MM (24h, hora Panama)');
    return;
  }

  const parts = args.split(/\s+/);
  if (parts.length < 3) {
    await reply(directorWaId, 'Necesito cliente, fecha y hora.\nEjemplo: $reunion juan 2026-03-20 10:00');
    return;
  }

  const clientRef = parts[0];
  const date = parts[1];
  const startTime = parts[2];
  const meetingType = parts[3] === 'presencial' ? 'presencial' : 'virtual';

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    await reply(directorWaId, 'Formato de fecha invalido. Usa YYYY-MM-DD (ej: 2026-03-20)');
    return;
  }

  if (!/^\d{2}:\d{2}$/.test(startTime)) {
    await reply(directorWaId, 'Formato de hora invalido. Usa HH:MM (ej: 10:00)');
    return;
  }

  const matches = await searchContacts(supabase, clientRef);
  if (matches.length === 0) {
    await reply(directorWaId, `No encontre ningun cliente con "${clientRef}".`);
    return;
  }

  if (matches.length > 1) {
    const list = matches.slice(0, 5).map((m, i) =>
      `${i + 1}. ${m.display_name}${m.company ? ` (${m.company})` : ''} - ${m.phone_number}`
    ).join('\n');
    await reply(directorWaId, `Encontre ${matches.length} resultados. Se mas especifico:\n${list}`);
    return;
  }

  const target = matches[0];

  const [h, m] = startTime.split(':').map(Number);
  const endMin = m + 30;
  const endTime = `${String(h + Math.floor(endMin / 60)).padStart(2, '0')}:${String(endMin % 60).padStart(2, '0')}`;

  const { scheduleMeetingViaCrm } = await import('../services/calendar.js');

  const result = await scheduleMeetingViaCrm({
    phoneNumber: target.wa_id || target.phone_number,
    title: `Reunion Obzide - ${target.display_name}`,
    date,
    startTime,
    endTime,
    meetingType,
  });

  if (!result.success) {
    let failMsg = `No pude agendar: ${result.message || result.reason || 'Error'}`;
    if (result.conflicts && result.conflicts.length > 0) {
      failMsg += '\n' + result.conflicts.map((c) => `- ${c.label}: ${c.time_range}`).join('\n');
    }
    await reply(directorWaId, failMsg);
    return;
  }

  await supabase.from('sales_meetings').insert({
    conversation_id: target.conversationId,
    contact_id: target.id,
    google_event_id: result.googleEventId || null,
    title: `Reunion Obzide - ${target.display_name}`,
    start_time: new Date(`${date}T${startTime}:00-05:00`).toISOString(),
    end_time: new Date(`${date}T${endTime}:00-05:00`).toISOString(),
    meet_link: result.meetLink || null,
    status: 'scheduled',
  });

  const typeLabel = meetingType === 'presencial' ? 'Presencial - PH Plaza Real' : `Virtual${result.meetLink ? ': ' + result.meetLink : ''}`;
  await reply(directorWaId, `Reunion agendada:\n${target.display_name}\n${date} ${startTime}-${endTime}\n${typeLabel}`);
  log.info('Director scheduled meeting directly', { target: target.display_name, date, startTime });
}

async function handleAyuda(directorWaId: string) {
  const helpText = `*COMANDOS DISPONIBLES*

$chatear <cliente> <mensaje>
  Enviar mensaje a un cliente como su persona asignada
  Ej: $chatear juan Hola, como vas?

$estado <cliente>
  Ver estado detallado de un cliente
  Ej: $estado maria

$pausar <cliente>
  Pausar la IA para un cliente (modo manual)
  Ej: $pausar juan

$reanudar <cliente>
  Reactivar la IA para un cliente
  Ej: $reanudar juan

$reiniciar <cliente>
  Reiniciar un contacto como nuevo lead
  Ej: $reiniciar pedro

$resumen
  Ver resumen de todas las conversaciones activas

$reunion <cliente> <fecha> <hora> [presencial]
  Agendar reunion directamente en el calendario
  Ej: $reunion juan 2026-03-20 10:00
  Ej: $reunion maria 2026-03-21 14:00 presencial

$ayuda
  Mostrar esta guia

Sin $ = Modo conversacion natural con el asistente IA
  Ej: "como va la conversacion con Juan?"
  Ej: "enviare a Maria un seguimiento"`;

  await reply(directorWaId, helpText);
}

async function handleReiniciar(
  supabase: SupabaseClient,
  directorWaId: string,
  args: string
) {
  if (!args) {
    await reply(directorWaId, 'Uso: $reiniciar <nombre_cliente>\nEjemplo: $reiniciar juan');
    return;
  }

  const matches = await searchContacts(supabase, args);
  if (matches.length === 0) {
    await reply(directorWaId, `No encontre ningun cliente con "${args}".`);
    return;
  }

  if (matches.length > 1) {
    const list = matches.slice(0, 5).map((m, i) =>
      `${i + 1}. ${m.display_name}${m.company ? ` (${m.company})` : ''} - ${m.phone_number}`
    ).join('\n');
    await reply(directorWaId, `Encontre ${matches.length} resultados. Se mas especifico:\n${list}`);
    return;
  }

  const target = matches[0];

  await supabase
    .from('whatsapp_contacts')
    .update({ intro_sent: false, lead_stage: 'nuevo' })
    .eq('id', target.id);

  await supabase
    .from('whatsapp_conversations')
    .update({ agent_mode: 'ai', category: 'new_lead' })
    .eq('id', target.conversationId);

  await supabase.from('whatsapp_messages').insert({
    conversation_id: target.conversationId,
    contact_id: target.id,
    wa_message_id: '',
    direction: 'inbound',
    message_type: 'text',
    content: 'Hola',
    status: 'received',
    sender_name: target.display_name || '',
    metadata: { synthetic_reset: true },
  });

  await reply(directorWaId, `${target.display_name} reiniciado como nuevo. El agente ya esta enviando el intro.`);
  log.info('Director reset contact as new', { target: target.display_name, contactId: target.id });
}

function formatTimeAgo(date: Date): string {
  const diffMs = Date.now() - date.getTime();
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return 'ahora';
  if (minutes < 60) return `hace ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `hace ${hours}h`;
  const days = Math.floor(hours / 24);
  return `hace ${days}d`;
}

export function isDirectorPhone(waId: string, directorPhones: readonly string[]): boolean {
  const cleaned = waId.replace(/[+\-\s()]/g, '');
  return directorPhones.some((dp) => {
    const cleanedDp = dp.replace(/[+\-\s()]/g, '');
    return cleaned === cleanedDp || cleaned.endsWith(cleanedDp) || cleanedDp.endsWith(cleaned);
  });
}

export async function handleDirectorCommand(
  supabase: SupabaseClient,
  msg: DirectorMessage
): Promise<void> {
  const parsed = parseCommand(msg.content);

  if (!parsed) {
    log.info('Director free-text message, routing to conversational agent', { waId: msg.directorWaId });
    await handleDirectorConversation({
      supabase,
      directorWaId: msg.directorWaId,
      content: msg.content,
      conversationId: msg.conversationId,
      contactId: msg.contactId,
    });
    return;
  }

  log.info('Director command received', { command: parsed.command, hasArgs: !!parsed.args });

  switch (parsed.command) {
    case 'chatear':
      await handleChatear(supabase, msg.directorWaId, parsed.args);
      break;
    case 'estado':
      await handleEstado(supabase, msg.directorWaId, parsed.args);
      break;
    case 'pausar':
      await handlePausar(supabase, msg.directorWaId, parsed.args);
      break;
    case 'reanudar':
      await handleReanudar(supabase, msg.directorWaId, parsed.args);
      break;
    case 'reiniciar':
      await handleReiniciar(supabase, msg.directorWaId, parsed.args);
      break;
    case 'resumen':
      await handleResumen(supabase, msg.directorWaId);
      break;
    case 'reunion':
      await handleReunion(supabase, msg.directorWaId, parsed.args);
      break;
    case 'ayuda':
    case 'help':
      await handleAyuda(msg.directorWaId);
      break;
    default:
      await reply(msg.directorWaId, `Comando desconocido: $${parsed.command}\nUsa $ayuda para ver todos los comandos disponibles.`);
  }
}
