import { config } from '../core/config.js';
import { createLogger } from '../core/logger.js';

const log = createLogger('calendar');

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const CALENDAR_BASE = 'https://www.googleapis.com/calendar/v3';

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

export async function getAvailableSlots(date: string): Promise<MeetingSlot[]> {
  if (!isConfigured()) {
    log.warn('Calendar integration not configured');
    return [];
  }

  const token = await getAccessToken();
  const calendarId = encodeURIComponent(config.google.calendarId);

  const dayStart = new Date(`${date}T00:00:00-05:00`);
  const dayEnd = new Date(`${date}T23:59:59-05:00`);

  const freebusyRes = await fetch(`${CALENDAR_BASE}/freeBusy`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      timeMin: dayStart.toISOString(),
      timeMax: dayEnd.toISOString(),
      timeZone: 'America/Panama',
      items: [{ id: config.google.calendarId }],
    }),
  });

  if (!freebusyRes.ok) {
    const err = await freebusyRes.text();
    log.error('FreeBusy query failed', { error: err });
    return [];
  }

  const freebusyData = await freebusyRes.json();
  const busy: Array<{ start: string; end: string }> =
    freebusyData.calendars?.[config.google.calendarId]?.busy || [];

  const workStart = 9;
  const workEnd = 18;
  const slotDuration = 30;
  const slots: MeetingSlot[] = [];

  for (let hour = workStart; hour < workEnd; hour++) {
    for (let min = 0; min < 60; min += slotDuration) {
      const slotStart = new Date(`${date}T${String(hour).padStart(2, '0')}:${String(min).padStart(2, '0')}:00-05:00`);
      const slotEnd = new Date(slotStart.getTime() + slotDuration * 60_000);

      if (slotEnd <= new Date()) continue;

      const conflict = busy.some((b) => {
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

export async function scheduleMeeting(
  title: string,
  start: string,
  durationMinutes: number,
  attendeeEmail?: string,
  presencial = false
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
      timeZone: 'America/Panama',
    },
    end: {
      dateTime: endDate.toISOString(),
      timeZone: 'America/Panama',
    },
  };

  if (presencial) {
    event.location = 'PH Plaza Real, Costa del Este, Ciudad de Panama, Panama';
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
