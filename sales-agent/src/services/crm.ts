import { getCrmSupabase } from '../core/supabase.js';
import { createLogger } from '../core/logger.js';

const log = createLogger('crm');

const VALID_LEAD_STAGES = [
  'nuevo', 'en_proceso', 'demo_solicitada',
  'cotizacion_enviada', 'por_cerrar', 'ganado', 'perdido',
] as const;

const STAGE_ALIASES: Record<string, string> = {
  contactado: 'en_proceso',
  en_negociacion: 'en_proceso',
  cerrado: 'ganado',
};

const VALID_EVENT_TYPES = [
  'lead_creado', 'whatsapp', 'estado_cambio', 'reunion_programada',
  'demo_solicitada', 'comentario', 'cotizacion_creada', 'cotizacion_enviada',
  'cotizacion_aceptada', 'cotizacion_rechazada', 'reunion_completada',
  'reunion_cancelada', 'documento_subido', 'llamada', 'email',
  'demo_completada', 'lead_cerrado', 'otro',
] as const;

function stripAccents(str: string): string {
  return str.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

const PERSONA_TO_SALESPERSON: Record<string, string> = {
  'tatiana velazquez': 'ace63d9d-ce98-4f87-b822-bdd2b0bcebfc',
  'julieta casanova': 'ace63d9d-ce98-4f87-b822-bdd2b0bcebfc',
  'hugo sanchez': '46493789-3fb2-4d3d-80c1-b0e7edc89a41',
  'maria fernanda rodriguez': '263d984a-35d5-4d9d-bb7e-0e20f5eb9ba8',
  'danna almirante': '263d984a-35d5-4d9d-bb7e-0e20f5eb9ba8',
};

export interface CrmLeadParams {
  name: string;
  firstName?: string;
  lastName?: string;
  clientType?: 'individual' | 'business';
  companyName?: string;
  email?: string;
  phone?: string;
  company?: string;
  notes?: string;
  assignedPersonaName?: string;
}

export interface CrmTimelineEvent {
  clientId: string;
  eventType: string;
  title: string;
  description?: string;
  metadata?: Record<string, unknown>;
  referenceId?: string;
  referenceTable?: string;
}

export interface CrmMeetingParams {
  clientId: string;
  title: string;
  startTime: string;
  endTime: string;
  meetLink?: string;
  googleEventId?: string;
  description?: string;
  meetingType?: 'virtual' | 'presencial';
}

function isAvailable(): boolean {
  const crm = getCrmSupabase();
  if (!crm) {
    log.debug('CRM not configured, skipping');
    return false;
  }
  return true;
}

function validateStage(stage: string): string {
  const mapped = STAGE_ALIASES[stage] || stage;
  if (VALID_LEAD_STAGES.includes(mapped as typeof VALID_LEAD_STAGES[number])) {
    return mapped;
  }
  log.warn('Invalid lead stage, defaulting to nuevo', { stage });
  return 'nuevo';
}

function validateEventType(eventType: string): string {
  if (VALID_EVENT_TYPES.includes(eventType as typeof VALID_EVENT_TYPES[number])) {
    return eventType;
  }
  log.warn('Invalid event type, defaulting to otro', { eventType });
  return 'otro';
}

export function getSalespersonId(personaName: string): string | null {
  const normalized = stripAccents(personaName).toLowerCase();
  return PERSONA_TO_SALESPERSON[normalized] || null;
}

export interface CrmClientMatch {
  id: string;
  name: string;
  phone: string;
  email: string;
  company_name: string;
  lead_stage: string;
}

export async function searchClientsByName(query: string): Promise<CrmClientMatch[]> {
  if (!isAvailable()) return [];
  const crm = getCrmSupabase()!;

  try {
    const normalizedQuery = stripAccents(query.toLowerCase().trim());
    const tokens = normalizedQuery.split(/\s+/).filter((t) => t.length >= 2);
    if (tokens.length === 0) return [];

    const ilikePattern = `%${tokens.join('%')}%`;
    const normalizedPhone = query.replace(/\D/g, '');

    let orFilter = `name.ilike.${ilikePattern},company_name.ilike.${ilikePattern}`;
    if (normalizedPhone.length >= 4) {
      orFilter += `,phone.ilike.%${normalizedPhone}%`;
    }

    const { data } = await crm
      .from('tech_clients')
      .select('id, name, phone, email, company_name, lead_stage')
      .or(orFilter)
      .limit(10);

    if (!data || data.length === 0) return [];

    return data.map((c) => ({
      id: c.id,
      name: c.name || '',
      phone: c.phone || '',
      email: c.email || '',
      company_name: c.company_name || '',
      lead_stage: c.lead_stage || 'nuevo',
    }));
  } catch (err) {
    log.error('CRM searchClientsByName error', { error: err instanceof Error ? err.message : String(err) });
    return [];
  }
}

export async function findClientByPhone(phone: string): Promise<string | null> {
  if (!isAvailable()) return null;
  const crm = getCrmSupabase()!;

  const cleaned = phone.replace(/\D/g, '');
  const { data } = await crm
    .from('tech_clients')
    .select('id')
    .or(`phone.ilike.%${cleaned}%,phone.ilike.%${phone}%`)
    .limit(1)
    .maybeSingle();

  return data?.id || null;
}

export async function findClientByEmail(email: string): Promise<string | null> {
  if (!isAvailable() || !email) return null;
  const crm = getCrmSupabase()!;

  const { data } = await crm
    .from('tech_clients')
    .select('id')
    .ilike('email', email.trim())
    .limit(1)
    .maybeSingle();

  return data?.id || null;
}

export async function createCrmLead(params: CrmLeadParams): Promise<string | null> {
  if (!isAvailable()) return null;
  const crm = getCrmSupabase()!;

  try {
    if (params.phone) {
      const existing = await findClientByPhone(params.phone);
      if (existing) {
        log.info('Client already exists by phone', { clientId: existing, phone: params.phone });
        return existing;
      }
    }

    if (params.email) {
      const existing = await findClientByEmail(params.email);
      if (existing) {
        log.info('Client already exists by email', { clientId: existing, email: params.email });
        return existing;
      }
    }

    const salespersonId = params.assignedPersonaName
      ? getSalespersonId(params.assignedPersonaName)
      : null;

    const resolvedFirstName = params.firstName || params.name.split(' ')[0] || '';
    const resolvedLastName = params.lastName || params.name.split(' ').slice(1).join(' ') || '';
    const resolvedClientType = params.clientType || (params.company || params.companyName ? 'business' : 'individual');
    const resolvedCompany = params.companyName || params.company || null;

    const insertData: Record<string, unknown> = {
      name: params.name,
      first_name: resolvedFirstName,
      last_name: resolvedLastName,
      email: params.email || null,
      phone: params.phone || null,
      company_name: resolvedCompany,
      notes: params.notes || null,
      client_type: resolvedClientType,
      status_tag: 'Lead',
      lead_stage: 'nuevo',
      assigned_salesperson_id: salespersonId,
      last_activity_at: new Date().toISOString(),
    };

    let { data, error } = await crm
      .from('tech_clients')
      .insert(insertData)
      .select('id')
      .single();

    if (error && error.message?.includes('foreign key') && salespersonId) {
      log.warn('Salesperson FK invalid, retrying without assignment', { salespersonId });
      insertData.assigned_salesperson_id = null;
      ({ data, error } = await crm
        .from('tech_clients')
        .insert(insertData)
        .select('id')
        .single());
    }

    if (error || !data) {
      log.error('Failed to create CRM lead', { error: error?.message });
      return null;
    }

    log.info('CRM lead created', { clientId: data.id, name: params.name, salesperson: salespersonId });
    return data.id;
  } catch (err) {
    log.error('CRM createCrmLead error', { error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

export async function updateCrmClient(
  clientId: string,
  updates: Record<string, unknown>
): Promise<boolean> {
  if (!isAvailable()) return false;
  const crm = getCrmSupabase()!;

  try {
    if (updates.lead_stage) {
      updates.lead_stage = validateStage(updates.lead_stage as string);
    }

    let { error } = await crm
      .from('tech_clients')
      .update({ ...updates, last_activity_at: new Date().toISOString() })
      .eq('id', clientId);

    if (error && error.message?.includes('foreign key') && updates.assigned_salesperson_id) {
      log.warn('Salesperson FK invalid on update, retrying without', { clientId });
      delete updates.assigned_salesperson_id;
      ({ error } = await crm
        .from('tech_clients')
        .update({ ...updates, last_activity_at: new Date().toISOString() })
        .eq('id', clientId));
    }

    if (error) {
      log.error('Failed to update CRM client', { clientId, error: error.message });
      return false;
    }

    log.debug('CRM client updated', { clientId });
    return true;
  } catch (err) {
    log.error('CRM updateCrmClient error', { error: err instanceof Error ? err.message : String(err) });
    return false;
  }
}

export async function syncNameUpdateToCrm(
  crmClientId: string,
  name: string,
  firstName?: string,
  lastName?: string,
  clientType?: 'individual' | 'business'
): Promise<boolean> {
  if (!isAvailable() || !crmClientId) return false;

  try {
    const updates: Record<string, unknown> = { name };
    if (firstName) updates.first_name = firstName;
    if (lastName) updates.last_name = lastName;
    if (clientType) updates.client_type = clientType;

    const ok = await updateCrmClient(crmClientId, updates);
    if (ok) {
      log.info('CRM name synced', { crmClientId, name, clientType });
    }
    return ok;
  } catch (err) {
    log.error('CRM syncNameUpdateToCrm error', { error: err instanceof Error ? err.message : String(err) });
    return false;
  }
}

export async function addTimelineEvent(event: CrmTimelineEvent): Promise<string | null> {
  if (!isAvailable()) return null;
  const crm = getCrmSupabase()!;

  try {
    const { data, error } = await crm.from('tech_lead_timeline_events').insert({
      client_id: event.clientId,
      event_type: validateEventType(event.eventType),
      title: event.title,
      description: event.description || null,
      metadata: event.metadata || {},
      reference_id: event.referenceId || null,
      reference_table: event.referenceTable || null,
    }).select('id').single();

    if (error) {
      log.error('Failed to add timeline event', { clientId: event.clientId, error: error.message });
      return null;
    }

    log.debug('Timeline event added', { clientId: event.clientId, type: event.eventType });
    return data.id;
  } catch (err) {
    log.error('CRM addTimelineEvent error', { error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

export async function addComment(
  clientId: string,
  comment: string,
  isInternal = true
): Promise<boolean> {
  if (!isAvailable()) return false;
  const crm = getCrmSupabase()!;

  try {
    const { error } = await crm.from('tech_lead_comments').insert({
      client_id: clientId,
      comment,
      is_internal: isInternal,
    });

    if (error) {
      log.error('Failed to add CRM comment', { clientId, error: error.message });
      return false;
    }

    await addTimelineEvent({
      clientId,
      eventType: 'comentario',
      title: 'Comentario agregado desde WhatsApp',
      description: comment.slice(0, 200),
    }).catch(() => {});

    log.debug('CRM comment added', { clientId });
    return true;
  } catch (err) {
    log.error('CRM addComment error', { error: err instanceof Error ? err.message : String(err) });
    return false;
  }
}

export async function addMeeting(params: CrmMeetingParams): Promise<string | null> {
  if (!isAvailable()) return null;
  const crm = getCrmSupabase()!;

  try {
    const { data, error } = await crm.from('tech_lead_meetings').insert({
      client_id: params.clientId,
      title: params.title,
      description: params.description || null,
      meeting_type: params.meetingType || 'virtual',
      start_time: params.startTime,
      end_time: params.endTime,
      meeting_link: params.meetLink || null,
      google_event_id: params.googleEventId || null,
      status: 'programada',
    }).select('id').single();

    if (error) {
      log.error('Failed to add CRM meeting', { clientId: params.clientId, error: error.message });
      return null;
    }

    log.info('CRM meeting added', { clientId: params.clientId, meetingId: data.id });
    return data.id;
  } catch (err) {
    log.error('CRM addMeeting error', { error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

export async function cancelMeetingInCrm(
  clientId: string,
  googleEventId: string | null,
  reason: string,
  meetingTitle: string
): Promise<boolean> {
  if (!isAvailable()) return false;
  const crm = getCrmSupabase()!;

  try {
    if (googleEventId) {
      const { data: crmMeeting } = await crm
        .from('tech_lead_meetings')
        .select('id')
        .eq('client_id', clientId)
        .eq('google_event_id', googleEventId)
        .maybeSingle();

      if (crmMeeting) {
        await crm
          .from('tech_lead_meetings')
          .update({ status: 'cancelada', updated_at: new Date().toISOString() })
          .eq('id', crmMeeting.id);
        log.info('CRM meeting cancelled', { crmMeetingId: crmMeeting.id, clientId });
      }
    }

    if (!googleEventId) {
      const { data: latestMeeting } = await crm
        .from('tech_lead_meetings')
        .select('id')
        .eq('client_id', clientId)
        .in('status', ['programada', 'scheduled'])
        .order('start_time', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (latestMeeting) {
        await crm
          .from('tech_lead_meetings')
          .update({ status: 'cancelada', updated_at: new Date().toISOString() })
          .eq('id', latestMeeting.id);
        log.info('CRM meeting cancelled (by latest)', { crmMeetingId: latestMeeting.id, clientId });
      }
    }

    await addTimelineEvent({
      clientId,
      eventType: 'reunion_cancelada',
      title: `Reunion cancelada: "${meetingTitle}"`,
      description: `Razon: ${reason}`,
      metadata: { google_event_id: googleEventId, source: 'whatsapp_agent' },
    });

    await addComment(clientId, `[REUNION CANCELADA] "${meetingTitle}" - Razon: ${reason}`);

    return true;
  } catch (err) {
    log.error('CRM cancelMeetingInCrm error', { error: err instanceof Error ? err.message : String(err) });
    return false;
  }
}

export async function completeMeetingInCrm(
  clientId: string,
  googleEventId: string | null,
  meetingTitle: string
): Promise<boolean> {
  if (!isAvailable()) return false;
  const crm = getCrmSupabase()!;

  try {
    if (googleEventId) {
      const { data: crmMeeting } = await crm
        .from('tech_lead_meetings')
        .select('id')
        .eq('client_id', clientId)
        .eq('google_event_id', googleEventId)
        .maybeSingle();

      if (crmMeeting) {
        await crm
          .from('tech_lead_meetings')
          .update({ status: 'completada', updated_at: new Date().toISOString() })
          .eq('id', crmMeeting.id);
      }
    } else {
      const { data: latestMeeting } = await crm
        .from('tech_lead_meetings')
        .select('id')
        .eq('client_id', clientId)
        .in('status', ['programada', 'scheduled'])
        .order('start_time', { ascending: true })
        .limit(1)
        .maybeSingle();

      if (latestMeeting) {
        await crm
          .from('tech_lead_meetings')
          .update({ status: 'completada', updated_at: new Date().toISOString() })
          .eq('id', latestMeeting.id);
      }
    }

    await addTimelineEvent({
      clientId,
      eventType: 'reunion_completada',
      title: `Reunion completada: "${meetingTitle}"`,
      metadata: { google_event_id: googleEventId },
    });

    return true;
  } catch (err) {
    log.error('CRM completeMeetingInCrm error', { error: err instanceof Error ? err.message : String(err) });
    return false;
  }
}

export async function rescheduleMeetingInCrm(
  clientId: string,
  oldGoogleEventId: string | null,
  oldTitle: string,
  reason: string,
  newMeeting: CrmMeetingParams
): Promise<string | null> {
  if (!isAvailable()) return null;

  try {
    await cancelMeetingInCrm(clientId, oldGoogleEventId, `Reagendada: ${reason}`, oldTitle);

    const newMeetingId = await addMeeting(newMeeting);

    await addTimelineEvent({
      clientId,
      eventType: 'reunion_programada',
      title: `Reunion reagendada: "${newMeeting.title}"`,
      description: `Reunion original "${oldTitle}" fue reagendada. Nueva fecha: ${newMeeting.startTime}`,
      metadata: { old_google_event_id: oldGoogleEventId, source: 'whatsapp_agent' },
    });

    return newMeetingId;
  } catch (err) {
    log.error('CRM rescheduleMeetingInCrm error', { error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

export async function getClientHistory(clientId: string): Promise<{
  timeline: Array<{ event_type: string; title: string; description: string; created_at: string }>;
  meetings: Array<{ title: string; start_time: string; status: string; meeting_link: string }>;
  comments: Array<{ comment: string; created_at: string }>;
}> {
  if (!isAvailable()) return { timeline: [], meetings: [], comments: [] };
  const crm = getCrmSupabase()!;

  try {
    const [timelineRes, meetingsRes, commentsRes] = await Promise.all([
      crm
        .from('tech_lead_timeline_events')
        .select('event_type, title, description, created_at')
        .eq('client_id', clientId)
        .order('created_at', { ascending: false })
        .limit(10),
      crm
        .from('tech_lead_meetings')
        .select('title, start_time, status, meeting_link')
        .eq('client_id', clientId)
        .order('start_time', { ascending: false })
        .limit(5),
      crm
        .from('tech_lead_comments')
        .select('comment, created_at')
        .eq('client_id', clientId)
        .order('created_at', { ascending: false })
        .limit(5),
    ]);

    return {
      timeline: timelineRes.data || [],
      meetings: meetingsRes.data || [],
      comments: commentsRes.data || [],
    };
  } catch (err) {
    log.error('CRM getClientHistory error', { error: err instanceof Error ? err.message : String(err) });
    return { timeline: [], meetings: [], comments: [] };
  }
}

export async function getCrmClientData(clientId: string): Promise<Record<string, unknown> | null> {
  if (!isAvailable()) return null;
  const crm = getCrmSupabase()!;

  try {
    const { data } = await crm
      .from('tech_clients')
      .select('id, name, email, phone, company_name, lead_stage, status_tag, estimated_value, next_action, next_action_date, notes, last_activity_at, assigned_salesperson_id')
      .eq('id', clientId)
      .maybeSingle();

    return data;
  } catch (err) {
    log.error('CRM getCrmClientData error', { error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

export async function syncStageToCrm(
  clientId: string,
  stage: string,
  personaName: string
): Promise<void> {
  if (!isAvailable()) return;

  const validStage = validateStage(stage);
  await updateCrmClient(clientId, { lead_stage: validStage });
  await addTimelineEvent({
    clientId,
    eventType: 'estado_cambio',
    title: `Etapa cambiada a "${validStage}"`,
    description: `Cambio automatico por agente ${personaName} desde WhatsApp`,
  });

  if (validStage === 'ganado') {
    await updateCrmClient(clientId, { status_tag: 'Ganado' });
  } else if (validStage === 'perdido') {
    await updateCrmClient(clientId, { status_tag: 'Perdido' });
  }
}

export async function syncContactToCrm(contact: {
  phone_number: string;
  display_name: string;
  profile_name: string;
  email?: string;
  company?: string;
  notes?: string;
  firstName?: string;
  lastName?: string;
  clientType?: 'individual' | 'business';
  companyName?: string;
}, personaName: string): Promise<string | null> {
  if (!isAvailable()) return null;

  try {
    let clientId = await findClientByPhone(contact.phone_number);

    if (!clientId && contact.email) {
      clientId = await findClientByEmail(contact.email);
    }

    if (clientId) {
      const updates: Record<string, unknown> = {};
      if (contact.email) updates.email = contact.email;
      if (contact.company) updates.company_name = contact.company;

      const salespersonId = getSalespersonId(personaName);
      if (salespersonId) updates.assigned_salesperson_id = salespersonId;

      if (Object.keys(updates).length > 0) {
        await updateCrmClient(clientId, updates);
      }
      return clientId;
    }

    const name = contact.display_name || contact.profile_name || contact.phone_number;

    clientId = await createCrmLead({
      name,
      firstName: contact.firstName,
      lastName: contact.lastName,
      clientType: contact.clientType,
      companyName: contact.companyName,
      phone: contact.phone_number,
      email: contact.email,
      company: contact.company,
      notes: contact.notes,
      assignedPersonaName: personaName,
    });

    if (clientId) {
      await addTimelineEvent({
        clientId,
        eventType: 'lead_creado',
        title: 'Lead creado desde WhatsApp',
        description: `Lead creado automaticamente por ${personaName}. Telefono: ${contact.phone_number}`,
        metadata: { source: 'whatsapp_sales_agent', persona: personaName },
      });

      await addTimelineEvent({
        clientId,
        eventType: 'whatsapp',
        title: 'Conversacion de WhatsApp iniciada',
        description: `Primer contacto via WhatsApp, atendido por ${personaName}`,
      });
    }

    return clientId;
  } catch (err) {
    log.error('CRM syncContactToCrm error', { error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

export interface CrmClientContext {
  client: {
    id: string;
    name: string;
    company: string | null;
    email: string | null;
    phone: string | null;
    status: string;
    lead_stage: string;
    estimated_value: number | null;
    next_action: string | null;
    next_action_date: string | null;
    notes: string | null;
    last_activity: string | null;
  } | null;
  insights: Record<string, Array<{ title: string; content: string; confidence: number; source: string; date: string }>>;
  insights_total: number;
  meetings: Array<{
    id: string;
    title: string;
    date: string;
    status: string;
    type: string;
    project_id: string | null;
    summary: string | null;
    key_points: string[];
    decisions: string[];
    sentiment: string | null;
  }>;
  projects: Array<{
    id: string;
    name: string;
    status: string;
    type: string | null;
    value: number | null;
    deadline: string | null;
    notes: string | null;
    start_date: string | null;
    delivered_at: string | null;
  }>;
  quotations: Array<{
    id: string;
    number: string;
    status: string;
    total: number;
    date: string;
  }>;
  pending_tasks: Array<{
    id: string;
    title: string;
    status: string;
    priority: string;
    due_date: string | null;
    source: string;
  }>;
}

export async function fetchClientContextFromCrm(phone?: string, clientId?: string): Promise<CrmClientContext | null> {
  const { config } = await import('../core/config.js');
  const crmUrl = config.crm.url;
  const crmKey = config.crm.serviceRoleKey;

  if (!crmUrl || !crmKey) return null;

  try {
    const body: Record<string, string> = {};
    if (clientId) body.client_id = clientId;
    if (phone) body.phone = phone;
    if (!body.client_id && !body.phone) return null;

    const res = await fetch(`${crmUrl}/functions/v1/get-client-context`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${crmKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      log.warn('CRM get-client-context failed', { status: res.status });
      return null;
    }

    const data = await res.json();
    if (!data.success || data.error) return null;

    return data.context || null;
  } catch (err) {
    log.warn('CRM fetchClientContextFromCrm error', { error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

export interface CrmMeetingNote {
  title: string;
  start_time: string;
  status: string;
  executive_summary: string;
  key_points: string[];
  decisions: string[];
  action_items: Array<{ description: string; assigned_to: string; status: string }>;
}

export async function getMeetingNotesFromCrm(clientId: string): Promise<CrmMeetingNote[]> {
  if (!isAvailable()) return [];
  const crm = getCrmSupabase()!;

  try {
    const { data: meetings } = await crm
      .from('tech_lead_meetings')
      .select('id, title, start_time, status')
      .eq('client_id', clientId)
      .in('status', ['completada', 'completed'])
      .order('start_time', { ascending: false })
      .limit(5);

    if (!meetings || meetings.length === 0) return [];

    const meetingIds = meetings.map((m) => m.id);

    const [aiNotesRes, actionItemsRes] = await Promise.all([
      crm
        .from('meeting_ai_notes')
        .select('meeting_id, executive_summary, key_points, decisions')
        .in('meeting_id', meetingIds),
      crm
        .from('meeting_action_items')
        .select('meeting_id, description, assigned_to, status')
        .in('meeting_id', meetingIds),
    ]);

    const aiNotesMap = new Map<string, { executive_summary: string; key_points: string[]; decisions: string[] }>();
    for (const note of aiNotesRes.data || []) {
      aiNotesMap.set(note.meeting_id, {
        executive_summary: note.executive_summary || '',
        key_points: Array.isArray(note.key_points) ? note.key_points : [],
        decisions: Array.isArray(note.decisions) ? note.decisions : [],
      });
    }

    const actionItemsMap = new Map<string, Array<{ description: string; assigned_to: string; status: string }>>();
    for (const item of actionItemsRes.data || []) {
      if (!actionItemsMap.has(item.meeting_id)) actionItemsMap.set(item.meeting_id, []);
      actionItemsMap.get(item.meeting_id)!.push({
        description: item.description,
        assigned_to: item.assigned_to || '',
        status: item.status || 'pendiente',
      });
    }

    return meetings.map((m) => {
      const notes = aiNotesMap.get(m.id);
      return {
        title: m.title,
        start_time: m.start_time,
        status: m.status,
        executive_summary: notes?.executive_summary || '',
        key_points: notes?.key_points || [],
        decisions: notes?.decisions || [],
        action_items: actionItemsMap.get(m.id) || [],
      };
    });
  } catch (err) {
    log.error('CRM getMeetingNotesFromCrm error', { error: err instanceof Error ? err.message : String(err) });
    return [];
  }
}
