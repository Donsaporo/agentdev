import { SupabaseClient } from '@supabase/supabase-js';
import { config } from '../core/config.js';
import { createLogger } from '../core/logger.js';
import { getCrmSupabase } from '../core/supabase.js';

const log = createLogger('calendar');

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const CALENDAR_BASE = 'https://www.googleapis.com/calendar/v3';

const TIMEZONE = 'America/Panama';
const TIMEZONE_OFFSET = '-05:00';
const SLOT_DURATION_MIN = 30;
const MAX_MEETINGS_PER_DAY = 4;

const WORK_SCHEDULE: Record<number, { start: number; end: number } | null> = {
  0: null,
  1: { start: 8, end: 17 },
  2: { start: 8, end: 17 },
  3: { start: 8, end: 16 },
  4: { start: 8, end: 16 },
  5: { start: 8, end: 16 },
  6: null,
};

function getWorkHours(date: string): { start: number; end: number } | null {
  const d = new Date(`${date}T12:00:00${TIMEZONE_OFFSET}`);
  const day = d.getDay();
  return WORK_SCHEDULE[day] || null;
}

export interface MeetingSlot {
  start: string;
  end: string;
}

export interface ScheduledMeeting {
  eventId: string;
  title: string;
  start: string;
  end: string;
  meetLink: string;
}

export interface AvailabilityCheck {
  available: boolean;
  reason?: string;
  suggestedSlots?: MeetingSlot[];
  suggestedDate?: string;
}

let cachedAccessToken: string | null = null;
let tokenExpiresAt = 0;

async function getAccessToken(): Promise<string> {
  if (cachedAccessToken && Date.now() < tokenExpiresAt - 60_000) {
    return cachedAccessToken;
  }

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: config.google.clientId,
      client_secret: config.google.clientSecret,
      refresh_token: config.google.refreshToken,
      grant_type: 'refresh_token',
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    log.error('Failed to refresh Google access token', { error: err });
    throw new Error(`Google token refresh failed: ${res.status}`);
  }

  const data = await res.json();
  cachedAccessToken = data.access_token;
  tokenExpiresAt = Date.now() + data.expires_in * 1000;

  log.debug('Google access token refreshed');
  return cachedAccessToken!;
}

function isConfigured(): boolean {
  return !!(config.google.clientId && config.google.clientSecret && config.google.refreshToken);
}

function getPanamaDate(date: Date): string {
  return date.toLocaleDateString('en-CA', { timeZone: TIMEZONE });
}

function getPanamaNow(): Date {
  const nowStr = new Date().toLocaleString('en-US', { timeZone: TIMEZONE });
  return new Date(nowStr);
}

function isSameOrBeforeToday(dateStr: string): boolean {
  const now = getPanamaNow();
  const todayStr = getPanamaDate(now);
  return dateStr <= todayStr;
}

async function getGoogleCalendarBusy(date: string): Promise<Array<{ start: string; end: string }>> {
  if (!isConfigured()) return [];

  const token = await getAccessToken();

  const dayStart = new Date(`${date}T00:00:00${TIMEZONE_OFFSET}`);
  const dayEnd = new Date(`${date}T23:59:59${TIMEZONE_OFFSET}`);

  const freebusyRes = await fetch(`${CALENDAR_BASE}/freeBusy`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      timeMin: dayStart.toISOString(),
      timeMax: dayEnd.toISOString(),
      timeZone: TIMEZONE,
      items: [{ id: config.google.calendarId }],
    }),
  });

  if (!freebusyRes.ok) {
    const err = await freebusyRes.text();
    log.error('FreeBusy query failed', { error: err });
    return [];
  }

  const freebusyData = await freebusyRes.json();
  return freebusyData.calendars?.[config.google.calendarId]?.busy || [];
}

async function getCrmTeamBlocks(date: string): Promise<Array<{ start: string; end: string }>> {
  const crm = getCrmSupabase();
  if (!crm) return [];

  try {
    const dayDate = new Date(`${date}T12:00:00${TIMEZONE_OFFSET}`);
    const dayOfWeek = dayDate.toLocaleDateString('en-US', { weekday: 'long', timeZone: TIMEZONE }).toLowerCase();

    const [recurringRes, oneTimeRes] = await Promise.all([
      crm
        .from('tech_user_recurring_blocks')
        .select('start_time, end_time, user_id')
        .eq('day_of_week', dayOfWeek)
        .eq('is_active', true),
      crm
        .from('tech_user_one_time_blocks')
        .select('start_time, end_time, user_id')
        .eq('block_date', date),
    ]);

    const blocks: Array<{ start: string; end: string }> = [];

    for (const block of recurringRes.data || []) {
      blocks.push({
        start: new Date(`${date}T${block.start_time}${TIMEZONE_OFFSET}`).toISOString(),
        end: new Date(`${date}T${block.end_time}${TIMEZONE_OFFSET}`).toISOString(),
      });
    }

    for (const block of oneTimeRes.data || []) {
      const startStr = typeof block.start_time === 'string' && block.start_time.includes('T')
        ? block.start_time
        : `${date}T${block.start_time}${TIMEZONE_OFFSET}`;
      const endStr = typeof block.end_time === 'string' && block.end_time.includes('T')
        ? block.end_time
        : `${date}T${block.end_time}${TIMEZONE_OFFSET}`;

      blocks.push({
        start: new Date(startStr).toISOString(),
        end: new Date(endStr).toISOString(),
      });
    }

    return blocks;
  } catch (err) {
    log.warn('Failed to fetch CRM team blocks', { error: err instanceof Error ? err.message : String(err) });
    return [];
  }
}

async function getDailyMeetingCount(supabase: SupabaseClient, date: string): Promise<number> {
  const dayStart = new Date(`${date}T00:00:00${TIMEZONE_OFFSET}`).toISOString();
  const dayEnd = new Date(`${date}T23:59:59${TIMEZONE_OFFSET}`).toISOString();

  const { count: localCount } = await supabase
    .from('sales_meetings')
    .select('id', { count: 'exact', head: true })
    .gte('start_time', dayStart)
    .lte('start_time', dayEnd)
    .in('status', ['scheduled', 'in_progress']);

  let crmCount = 0;
  const crm = getCrmSupabase();
  if (crm) {
    try {
      const { count } = await crm
        .from('tech_lead_meetings')
        .select('id', { count: 'exact', head: true })
        .gte('start_time', dayStart)
        .lte('start_time', dayEnd)
        .in('status', ['programada', 'en_curso']);
      crmCount = count || 0;
    } catch {
      log.warn('Failed to count CRM meetings for day', { date });
    }
  }

  return Math.max(localCount || 0, crmCount);
}

export async function checkAvailability(
  supabase: SupabaseClient,
  requestedDatetime: string,
  durationMinutes = SLOT_DURATION_MIN
): Promise<AvailabilityCheck> {
  const requestedDate = new Date(requestedDatetime);
  if (isNaN(requestedDate.getTime())) {
    return { available: false, reason: 'Fecha/hora invalida' };
  }

  const dateStr = getPanamaDate(requestedDate);

  if (isSameOrBeforeToday(dateStr)) {
    const tomorrow = new Date(getPanamaNow());
    tomorrow.setDate(tomorrow.getDate() + 1);
    const tomorrowStr = getPanamaDate(tomorrow);

    const slots = await getAvailableSlots(supabase, tomorrowStr);
    return {
      available: false,
      reason: 'Las reuniones deben agendarse con al menos un dia de antelacion',
      suggestedDate: tomorrowStr,
      suggestedSlots: slots.slice(0, 6),
    };
  }

  const workHours = getWorkHours(dateStr);
  if (!workHours) {
    const tomorrow = new Date(getPanamaNow());
    tomorrow.setDate(tomorrow.getDate() + 1);
    while (tomorrow.getDay() === 0 || tomorrow.getDay() === 6) {
      tomorrow.setDate(tomorrow.getDate() + 1);
    }
    const nextStr = getPanamaDate(tomorrow);
    const slots = await getAvailableSlots(supabase, nextStr);
    return {
      available: false,
      reason: 'No tenemos reuniones los fines de semana',
      suggestedDate: nextStr,
      suggestedSlots: slots.slice(0, 6),
    };
  }

  const panamaHour = parseInt(
    requestedDate.toLocaleString('en-US', { hour: 'numeric', hour12: false, timeZone: TIMEZONE })
  );
  const panamaMinute = parseInt(
    requestedDate.toLocaleString('en-US', { minute: 'numeric', timeZone: TIMEZONE })
  );

  const meetingEndHour = panamaHour + Math.floor((panamaMinute + durationMinutes) / 60);
  const meetingEndMin = (panamaMinute + durationMinutes) % 60;

  if (panamaHour < workHours.start || (meetingEndHour > workHours.end) || (meetingEndHour === workHours.end && meetingEndMin > 0)) {
    const slots = await getAvailableSlots(supabase, dateStr);
    const endDisplay = workHours.end > 12 ? `${workHours.end - 12}:00 PM` : `${workHours.end}:00 AM`;
    return {
      available: false,
      reason: `Nuestro horario de reuniones ese dia es de ${workHours.start}:00 AM a ${endDisplay} (hora de Panama)`,
      suggestedSlots: slots.slice(0, 6),
    };
  }

  const dailyCount = await getDailyMeetingCount(supabase, dateStr);
  if (dailyCount >= MAX_MEETINGS_PER_DAY) {
    const nextDate = new Date(`${dateStr}T12:00:00${TIMEZONE_OFFSET}`);
    nextDate.setDate(nextDate.getDate() + 1);
    const nextDateStr = getPanamaDate(nextDate);
    const nextSlots = await getAvailableSlots(supabase, nextDateStr);

    return {
      available: false,
      reason: `Ya tenemos ${MAX_MEETINGS_PER_DAY} reuniones para ese dia. Te sugiero otro dia`,
      suggestedDate: nextDateStr,
      suggestedSlots: nextSlots.slice(0, 6),
    };
  }

  const [googleBusy, teamBlocks] = await Promise.all([
    getGoogleCalendarBusy(dateStr),
    getCrmTeamBlocks(dateStr),
  ]);

  const allBusy = [...googleBusy, ...teamBlocks];
  const reqStart = requestedDate.getTime();
  const reqEnd = reqStart + durationMinutes * 60_000;

  const hasConflict = allBusy.some((b) => {
    const bStart = new Date(b.start).getTime();
    const bEnd = new Date(b.end).getTime();
    return reqStart < bEnd && reqEnd > bStart;
  });

  if (hasConflict) {
    const slots = await getAvailableSlots(supabase, dateStr);
    return {
      available: false,
      reason: 'Ese horario no esta disponible',
      suggestedSlots: slots.slice(0, 6),
    };
  }

  return { available: true };
}

export async function getAvailableSlots(
  supabase: SupabaseClient,
  date: string
): Promise<MeetingSlot[]> {
  const [googleBusy, teamBlocks] = await Promise.all([
    getGoogleCalendarBusy(date).catch(() => []),
    getCrmTeamBlocks(date).catch(() => []),
  ]);

  const workHours = getWorkHours(date);
  if (!workHours) return [];

  const allBusy = [...googleBusy, ...teamBlocks];
  const slots: MeetingSlot[] = [];
  const now = new Date();

  for (let hour = workHours.start; hour < workHours.end; hour++) {
    for (let min = 0; min < 60; min += SLOT_DURATION_MIN) {
      const slotStart = new Date(`${date}T${String(hour).padStart(2, '0')}:${String(min).padStart(2, '0')}:00${TIMEZONE_OFFSET}`);
      const slotEnd = new Date(slotStart.getTime() + SLOT_DURATION_MIN * 60_000);

      if (slotEnd.getTime() > new Date(`${date}T${String(workHours.end).padStart(2, '0')}:00:00${TIMEZONE_OFFSET}`).getTime()) {
        continue;
      }

      if (slotEnd <= now) continue;

      const conflict = allBusy.some((b) => {
        const bStart = new Date(b.start).getTime();
        const bEnd = new Date(b.end).getTime();
        return slotStart.getTime() < bEnd && slotEnd.getTime() > bStart;
      });

      if (!conflict) {
        slots.push({
          start: slotStart.toISOString(),
          end: slotEnd.toISOString(),
        });
      }
    }
  }

  log.info('Available slots retrieved', { date, count: slots.length });
  return slots;
}

export async function getNextAvailableDays(
  supabase: SupabaseClient,
  daysToCheck = 5
): Promise<Array<{ date: string; slotCount: number; firstSlot: string | null }>> {
  const results: Array<{ date: string; slotCount: number; firstSlot: string | null }> = [];
  const startDate = new Date(getPanamaNow());
  startDate.setDate(startDate.getDate() + 1);

  for (let i = 0; i < daysToCheck + 7 && results.length < daysToCheck; i++) {
    const checkDate = new Date(startDate);
    checkDate.setDate(checkDate.getDate() + i);

    const day = checkDate.getDay();
    if (day === 0 || day === 6) continue;

    const dateStr = getPanamaDate(checkDate);

    const dailyCount = await getDailyMeetingCount(supabase, dateStr);
    if (dailyCount >= MAX_MEETINGS_PER_DAY) continue;

    const slots = await getAvailableSlots(supabase, dateStr);
    if (slots.length > 0) {
      results.push({
        date: dateStr,
        slotCount: slots.length,
        firstSlot: slots[0].start,
      });
    }
  }

  return results;
}

export async function scheduleMeeting(
  title: string,
  start: string,
  durationMinutes: number,
  attendeeEmail?: string,
  presencial = false,
  location?: string
): Promise<ScheduledMeeting | null> {
  if (!isConfigured()) {
    log.warn('Calendar integration not configured');
    return null;
  }

  const token = await getAccessToken();
  const calendarId = encodeURIComponent(config.google.calendarId);

  const startDate = new Date(start);
  const endDate = new Date(startDate.getTime() + durationMinutes * 60_000);

  const event: Record<string, unknown> = {
    summary: title,
    start: {
      dateTime: startDate.toISOString(),
      timeZone: TIMEZONE,
    },
    end: {
      dateTime: endDate.toISOString(),
      timeZone: TIMEZONE,
    },
  };

  if (presencial) {
    event.location = location || 'PH Plaza Real, Costa del Este, Ciudad de Panama, Panama';
  } else {
    event.conferenceData = {
      createRequest: {
        requestId: `obzide-${Date.now()}`,
        conferenceSolutionKey: { type: 'hangoutsMeet' },
      },
    };
  }

  if (attendeeEmail) {
    event.attendees = [{ email: attendeeEmail }];
  }

  const conferenceVersion = presencial ? '' : 'conferenceDataVersion=1&';
  const res = await fetch(
    `${CALENDAR_BASE}/calendars/${calendarId}/events?${conferenceVersion}sendUpdates=all`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(event),
    }
  );

  if (!res.ok) {
    const err = await res.text();
    log.error('Failed to create calendar event', { error: err });
    return null;
  }

  const created = await res.json();
  const meetLink = presencial
    ? ''
    : (created.hangoutLink || created.conferenceData?.entryPoints?.[0]?.uri || '');

  log.info('Meeting scheduled', {
    eventId: created.id,
    start: startDate.toISOString(),
    type: presencial ? 'presencial' : 'virtual',
    meetLink,
  });

  return {
    eventId: created.id,
    title: created.summary,
    start: startDate.toISOString(),
    end: endDate.toISOString(),
    meetLink,
  };
}

export interface CrmScheduleResult {
  success: boolean;
  meetingId?: string;
  googleEventId?: string;
  meetLink?: string;
  scheduled?: { date: string; start_time: string; end_time: string };
  clientId?: string;
  clientName?: string;
  reason?: string;
  conflicts?: Array<{ type: string; label: string; time_range: string }>;
  message?: string;
}

export async function scheduleMeetingViaCrm(params: {
  phoneNumber: string;
  title: string;
  date: string;
  startTime: string;
  endTime: string;
  meetingType?: string;
  description?: string;
  attendees?: string[];
  projectId?: string;
  location?: string;
}): Promise<CrmScheduleResult> {
  const crmUrl = config.crm.url;
  const crmKey = config.crm.serviceRoleKey;

  if (!crmUrl || !crmKey) {
    log.warn('CRM not configured for scheduling');
    return { success: false, reason: 'crm_not_configured', message: 'CRM no esta configurado' };
  }

  try {
    const res = await fetch(`${crmUrl}/functions/v1/schedule-meeting-from-whatsapp`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${crmKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        phone_number: params.phoneNumber,
        title: params.title,
        date: params.date,
        start_time: params.startTime,
        end_time: params.endTime,
        meeting_type: params.meetingType || 'virtual',
        description: params.description,
        attendees: params.attendees,
        project_id: params.projectId,
        create_meet: params.meetingType !== 'presencial',
        location: params.location,
      }),
    });

    const data = await res.json();

    if (!res.ok || data.success === false) {
      log.warn('CRM schedule-meeting returned failure', {
        status: res.status,
        reason: data.reason,
        conflicts: data.conflicts?.length,
      });

      return {
        success: false,
        reason: data.reason || 'unknown',
        conflicts: data.conflicts,
        message: data.message,
        clientId: data.client?.id,
        clientName: data.client?.name,
      };
    }

    log.info('Meeting scheduled via CRM', {
      meetingId: data.meeting_id,
      googleEventId: data.google_event_id,
      meetLink: data.meet_link,
    });

    return {
      success: true,
      meetingId: data.meeting_id,
      googleEventId: data.google_event_id,
      meetLink: data.meet_link,
      scheduled: data.scheduled,
      clientId: data.client?.id,
      clientName: data.client?.name,
    };
  } catch (err) {
    log.error('CRM schedule-meeting request failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      success: false,
      reason: 'network_error',
      message: 'Error de conexion con el CRM',
    };
  }
}
