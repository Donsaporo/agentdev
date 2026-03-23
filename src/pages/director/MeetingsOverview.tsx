import { useState, useEffect, useCallback } from 'react';
import {
  Calendar,
  Video,
  MapPin,
  CheckCircle2,
  XCircle,
  Clock,
  Bell,
  RefreshCw,
  ChevronDown,
  ChevronUp,
  ExternalLink,
} from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { formatDistanceToNow, format, isToday, isTomorrow, isPast } from 'date-fns';
import { es } from 'date-fns/locale';

interface Meeting {
  id: string;
  title: string;
  start_time: string;
  end_time: string;
  meet_link: string | null;
  status: string;
  reminder_24h_sent: boolean;
  reminder_1h_sent: boolean;
  client_confirmed: boolean | null;
  confirmed_at: string | null;
  created_at: string;
  contact: {
    display_name: string;
    phone_number: string;
    lead_stage: string;
    company: string;
  } | null;
}

interface ReminderQueueItem {
  id: string;
  meeting_id: string;
  reminder_type: string;
  status: string;
  meeting_title: string;
  meeting_start_time: string;
  template_sent_at: string | null;
  message_sent_at: string | null;
  created_at: string;
}

type FilterTab = 'upcoming' | 'today' | 'past';

function getConfirmationBadge(confirmed: boolean | null) {
  if (confirmed === true) {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 text-[10px] font-medium">
        <CheckCircle2 className="w-3 h-3" />
        Confirmado
      </span>
    );
  }
  if (confirmed === false) {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-red-500/10 text-red-400 text-[10px] font-medium">
        <XCircle className="w-3 h-3" />
        Cancelado
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-400 text-[10px] font-medium">
      <Clock className="w-3 h-3" />
      Pendiente
    </span>
  );
}

function getStatusBadge(status: string) {
  const map: Record<string, { label: string; color: string; bg: string }> = {
    scheduled: { label: 'Programada', color: 'text-blue-400', bg: 'bg-blue-500/10' },
    in_progress: { label: 'En Curso', color: 'text-emerald-400', bg: 'bg-emerald-500/10' },
    completed: { label: 'Completada', color: 'text-slate-400', bg: 'bg-slate-500/10' },
    cancelled: { label: 'Cancelada', color: 'text-red-400', bg: 'bg-red-500/10' },
  };
  const s = map[status] || map.scheduled;
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full ${s.bg} ${s.color} text-[10px] font-medium`}>
      {s.label}
    </span>
  );
}

function formatMeetingDate(startTime: string): string {
  const d = new Date(startTime);
  if (isToday(d)) return `Hoy, ${format(d, 'h:mm a', { locale: es })}`;
  if (isTomorrow(d)) return `Manana, ${format(d, 'h:mm a', { locale: es })}`;
  return format(d, "EEEE d 'de' MMMM, h:mm a", { locale: es });
}

export default function MeetingsOverview() {
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [reminders, setReminders] = useState<ReminderQueueItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<FilterTab>('upcoming');
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    setLoading(true);

    const now = new Date().toISOString();
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayEnd = new Date();
    todayEnd.setHours(23, 59, 59, 999);

    let query = supabase
      .from('sales_meetings')
      .select(`
        id, title, start_time, end_time, meet_link, status,
        reminder_24h_sent, reminder_1h_sent, client_confirmed, confirmed_at, created_at,
        contact:whatsapp_contacts(display_name, phone_number, lead_stage, company)
      `)
      .order('start_time', { ascending: filter !== 'past' });

    if (filter === 'upcoming') {
      query = query.gte('start_time', now).in('status', ['scheduled', 'in_progress']);
    } else if (filter === 'today') {
      query = query
        .gte('start_time', todayStart.toISOString())
        .lte('start_time', todayEnd.toISOString());
    } else {
      query = query.lt('start_time', now).order('start_time', { ascending: false });
    }

    query = query.limit(25);

    const [meetingsRes, remindersRes] = await Promise.all([
      query,
      supabase
        .from('meeting_reminder_queue')
        .select('id, meeting_id, reminder_type, status, meeting_title, meeting_start_time, template_sent_at, message_sent_at, created_at')
        .eq('status', 'pending_response')
        .order('created_at', { ascending: false })
        .limit(20),
    ]);

    const rawMeetings = (meetingsRes.data || []).map((m) => {
      const rawContact = m.contact as unknown;
      const contact = Array.isArray(rawContact) ? rawContact[0] : rawContact;
      return { ...m, contact: contact as Meeting['contact'] };
    });

    setMeetings(rawMeetings);
    setReminders(remindersRes.data || []);
    setLoading(false);
  }, [filter]);

  useEffect(() => {
    loadData();
    const interval = setInterval(loadData, 60_000);
    return () => clearInterval(interval);
  }, [loadData]);

  const stats = {
    total: meetings.length,
    confirmed: meetings.filter((m) => m.client_confirmed === true).length,
    pending: meetings.filter((m) => m.client_confirmed === null && m.status === 'scheduled').length,
    cancelled: meetings.filter((m) => m.status === 'cancelled').length,
    pendingReminders: reminders.length,
  };

  if (loading) {
    return (
      <div className="space-y-4">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="glass-card p-5">
            <div className="skeleton w-48 h-5 mb-3" />
            <div className="skeleton w-32 h-4 mb-2" />
            <div className="skeleton w-64 h-4" />
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className="glass-card p-4 text-center">
          <p className="text-2xl font-bold text-white">{stats.total}</p>
          <p className="text-[10px] text-slate-500 mt-0.5">Reuniones</p>
        </div>
        <div className="glass-card p-4 text-center">
          <p className="text-2xl font-bold text-emerald-400">{stats.confirmed}</p>
          <p className="text-[10px] text-slate-500 mt-0.5">Confirmadas</p>
        </div>
        <div className="glass-card p-4 text-center">
          <p className="text-2xl font-bold text-amber-400">{stats.pending}</p>
          <p className="text-[10px] text-slate-500 mt-0.5">Sin Confirmar</p>
        </div>
        <div className="glass-card p-4 text-center">
          <p className="text-2xl font-bold text-red-400">{stats.cancelled}</p>
          <p className="text-[10px] text-slate-500 mt-0.5">Canceladas</p>
        </div>
      </div>

      {stats.pendingReminders > 0 && (
        <div className="glass-card p-4 border border-amber-500/20">
          <div className="flex items-center gap-2 mb-2">
            <Bell className="w-4 h-4 text-amber-400" />
            <h4 className="text-sm font-medium text-amber-400">
              {stats.pendingReminders} recordatorio{stats.pendingReminders > 1 ? 's' : ''} esperando respuesta
            </h4>
          </div>
          <div className="space-y-1.5">
            {reminders.slice(0, 5).map((r) => (
              <div key={r.id} className="flex items-center justify-between text-xs">
                <span className="text-slate-300">{r.meeting_title}</span>
                <span className="text-slate-500">
                  Template enviado {r.template_sent_at ? formatDistanceToNow(new Date(r.template_sent_at), { addSuffix: true, locale: es }) : ''}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1">
          {(['upcoming', 'today', 'past'] as FilterTab[]).map((tab) => (
            <button
              key={tab}
              onClick={() => setFilter(tab)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                filter === tab
                  ? 'bg-emerald-500/10 text-emerald-400'
                  : 'text-slate-400 hover:text-slate-200 hover:bg-white/[0.04]'
              }`}
            >
              {tab === 'upcoming' ? 'Proximas' : tab === 'today' ? 'Hoy' : 'Pasadas'}
            </button>
          ))}
        </div>
        <button
          onClick={loadData}
          className="p-2 rounded-lg text-slate-400 hover:text-white hover:bg-white/[0.04] transition-all"
        >
          <RefreshCw className="w-4 h-4" />
        </button>
      </div>

      {meetings.length === 0 ? (
        <div className="glass-card flex flex-col items-center justify-center py-16 text-center">
          <Calendar className="w-10 h-10 text-slate-600 mb-3" />
          <p className="text-sm text-slate-400">No hay reuniones {filter === 'upcoming' ? 'programadas' : filter === 'today' ? 'para hoy' : 'pasadas'}</p>
        </div>
      ) : (
        <div className="space-y-3">
          {meetings.map((meeting) => {
            const isExpanded = expandedId === meeting.id;
            const isVirtual = !!meeting.meet_link;
            const meetingPast = isPast(new Date(meeting.start_time));

            return (
              <div
                key={meeting.id}
                className={`glass-card overflow-hidden transition-all ${
                  meetingPast && meeting.status === 'scheduled' ? 'border border-amber-500/20' : ''
                }`}
              >
                <button
                  onClick={() => setExpandedId(isExpanded ? null : meeting.id)}
                  className="w-full px-5 py-4 flex items-center gap-4 text-left hover:bg-white/[0.02] transition-colors"
                >
                  <div className={`w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0 ${
                    isVirtual ? 'bg-blue-500/10' : 'bg-teal-500/10'
                  }`}>
                    {isVirtual ? (
                      <Video className="w-5 h-5 text-blue-400" />
                    ) : (
                      <MapPin className="w-5 h-5 text-teal-400" />
                    )}
                  </div>

                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="text-sm font-medium text-white truncate">{meeting.title}</p>
                      {getStatusBadge(meeting.status)}
                      {meeting.status === 'scheduled' && getConfirmationBadge(meeting.client_confirmed)}
                    </div>
                    <div className="flex items-center gap-3 mt-1 text-xs text-slate-400">
                      <span>{formatMeetingDate(meeting.start_time)}</span>
                      {meeting.contact && (
                        <span className="truncate">
                          {meeting.contact.display_name}
                          {meeting.contact.company ? ` - ${meeting.contact.company}` : ''}
                        </span>
                      )}
                    </div>
                  </div>

                  <div className="flex items-center gap-2 flex-shrink-0">
                    <div className="flex gap-1">
                      <div className={`w-2 h-2 rounded-full ${meeting.reminder_24h_sent ? 'bg-emerald-500' : 'bg-slate-600'}`}
                           title={meeting.reminder_24h_sent ? 'Recordatorio 24h enviado' : 'Recordatorio 24h pendiente'} />
                      <div className={`w-2 h-2 rounded-full ${meeting.reminder_1h_sent ? 'bg-emerald-500' : 'bg-slate-600'}`}
                           title={meeting.reminder_1h_sent ? 'Recordatorio 1h enviado' : 'Recordatorio 1h pendiente'} />
                    </div>
                    {isExpanded ? (
                      <ChevronUp className="w-4 h-4 text-slate-500" />
                    ) : (
                      <ChevronDown className="w-4 h-4 text-slate-500" />
                    )}
                  </div>
                </button>

                {isExpanded && (
                  <div className="px-5 pb-4 pt-0 border-t border-white/[0.04] space-y-3">
                    <div className="grid grid-cols-2 gap-4 pt-3">
                      <div>
                        <p className="text-[10px] text-slate-500 uppercase tracking-wider mb-1">Contacto</p>
                        <p className="text-sm text-white">{meeting.contact?.display_name || 'Sin nombre'}</p>
                        {meeting.contact?.phone_number && (
                          <p className="text-xs text-slate-400">{meeting.contact.phone_number}</p>
                        )}
                        {meeting.contact?.company && (
                          <p className="text-xs text-slate-400">{meeting.contact.company}</p>
                        )}
                      </div>
                      <div>
                        <p className="text-[10px] text-slate-500 uppercase tracking-wider mb-1">Horario</p>
                        <p className="text-sm text-white">
                          {format(new Date(meeting.start_time), 'h:mm a', { locale: es })} - {format(new Date(meeting.end_time), 'h:mm a', { locale: es })}
                        </p>
                        <p className="text-xs text-slate-400">
                          {format(new Date(meeting.start_time), "EEEE d 'de' MMMM, yyyy", { locale: es })}
                        </p>
                      </div>
                    </div>

                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <p className="text-[10px] text-slate-500 uppercase tracking-wider mb-1">Recordatorios</p>
                        <div className="space-y-1">
                          <div className="flex items-center gap-2 text-xs">
                            {meeting.reminder_24h_sent ? (
                              <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                            ) : (
                              <Clock className="w-3.5 h-3.5 text-slate-500" />
                            )}
                            <span className={meeting.reminder_24h_sent ? 'text-emerald-400' : 'text-slate-500'}>
                              24 horas antes
                            </span>
                          </div>
                          <div className="flex items-center gap-2 text-xs">
                            {meeting.reminder_1h_sent ? (
                              <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                            ) : (
                              <Clock className="w-3.5 h-3.5 text-slate-500" />
                            )}
                            <span className={meeting.reminder_1h_sent ? 'text-emerald-400' : 'text-slate-500'}>
                              1 hora antes
                            </span>
                          </div>
                        </div>
                      </div>
                      <div>
                        <p className="text-[10px] text-slate-500 uppercase tracking-wider mb-1">Confirmacion</p>
                        <div className="flex items-center gap-2">
                          {getConfirmationBadge(meeting.client_confirmed)}
                        </div>
                        {meeting.confirmed_at && (
                          <p className="text-[10px] text-slate-500 mt-1">
                            {formatDistanceToNow(new Date(meeting.confirmed_at), { addSuffix: true, locale: es })}
                          </p>
                        )}
                      </div>
                    </div>

                    {meeting.meet_link && (
                      <div>
                        <p className="text-[10px] text-slate-500 uppercase tracking-wider mb-1">Link de reunion</p>
                        <a
                          href={meeting.meet_link}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1.5 text-xs text-blue-400 hover:text-blue-300 transition-colors"
                        >
                          <ExternalLink className="w-3 h-3" />
                          {meeting.meet_link}
                        </a>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
