import { createLogger } from '../core/logger.js';

const log = createLogger('calendar');

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

export async function getAvailableSlots(_date: string): Promise<MeetingSlot[]> {
  log.warn('Calendar integration not yet configured');
  return [];
}

export async function scheduleMeeting(
  _title: string,
  _start: string,
  _durationMinutes: number,
  _attendeeEmail?: string
): Promise<ScheduledMeeting | null> {
  log.warn('Calendar integration not yet configured');
  return null;
}
