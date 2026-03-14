import { useState, useEffect } from 'react';
import {
  MessageCircle,
  AlertTriangle,
  TrendingUp,
  Clock,
  Bot,
  Wifi,
  WifiOff,
  Lock,
  Timer,
} from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { formatDistanceToNow } from 'date-fns';
import { es } from 'date-fns/locale';

interface MetricCard {
  label: string;
  value: string | number;
  icon: typeof MessageCircle;
  color: string;
  bgColor: string;
}

interface HeartbeatInfo {
  status: string;
  last_seen: string;
  version: string;
}

interface WindowStats {
  open: number;
  closing_soon: number;
  closed: number;
}

const STAGE_PIPELINE = [
  { key: 'nuevo', label: 'Nuevo', color: 'bg-slate-500' },
  { key: 'contactado', label: 'Contactado', color: 'bg-blue-500' },
  { key: 'en_negociacion', label: 'Negociacion', color: 'bg-cyan-500' },
  { key: 'demo_solicitada', label: 'Demo', color: 'bg-amber-500' },
  { key: 'cotizacion_enviada', label: 'Cotizacion', color: 'bg-sky-500' },
  { key: 'por_cerrar', label: 'Por Cerrar', color: 'bg-orange-500' },
  { key: 'ganado', label: 'Ganado', color: 'bg-emerald-500' },
  { key: 'perdido', label: 'Perdido', color: 'bg-red-500' },
];

export default function DirectorMetrics() {
  const [metrics, setMetrics] = useState<MetricCard[]>([]);
  const [heartbeat, setHeartbeat] = useState<HeartbeatInfo | null>(null);
  const [windowStats, setWindowStats] = useState<WindowStats>({ open: 0, closing_soon: 0, closed: 0 });
  const [pipelineCounts, setPipelineCounts] = useState<Record<string, number>>({});
  const [recentActions, setRecentActions] = useState<Array<{
    id: string;
    action_type: string;
    output_summary: string;
    model_used: string;
    tokens_input: number;
    tokens_output: number;
    created_at: string;
  }>>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadMetrics();
  }, []);

  async function loadMetrics() {
    setLoading(true);

    const [
      { count: totalConversations },
      { count: activeConversations },
      { count: totalMessages },
      { count: escalationsOpen },
      { count: feedbackPending },
      { data: actions },
      { data: hb },
      { data: convos },
      { data: contacts },
    ] = await Promise.all([
      supabase.from('whatsapp_conversations').select('id', { count: 'exact', head: true }),
      supabase.from('whatsapp_conversations').select('id', { count: 'exact', head: true }).eq('status', 'active'),
      supabase.from('whatsapp_messages').select('id', { count: 'exact', head: true }),
      supabase.from('sales_escalation_queue').select('id', { count: 'exact', head: true }).eq('status', 'open'),
      supabase.from('sales_agent_feedback').select('id', { count: 'exact', head: true }).eq('status', 'pending'),
      supabase
        .from('sales_agent_actions_log')
        .select('id, action_type, output_summary, model_used, tokens_input, tokens_output, created_at')
        .order('created_at', { ascending: false })
        .limit(10),
      supabase
        .from('sales_agent_heartbeat')
        .select('status, last_seen, version')
        .eq('id', 'sales-agent')
        .maybeSingle(),
      supabase
        .from('whatsapp_conversations')
        .select('window_status')
        .eq('status', 'active'),
      supabase
        .from('whatsapp_contacts')
        .select('lead_stage'),
    ]);

    setHeartbeat(hb);

    const ws: WindowStats = { open: 0, closing_soon: 0, closed: 0 };
    (convos || []).forEach((c: { window_status: string | null }) => {
      if (c.window_status === 'open') ws.open++;
      else if (c.window_status === 'closing_soon') ws.closing_soon++;
      else ws.closed++;
    });
    setWindowStats(ws);

    const pc: Record<string, number> = {};
    (contacts || []).forEach((c: { lead_stage: string }) => {
      pc[c.lead_stage] = (pc[c.lead_stage] || 0) + 1;
    });
    setPipelineCounts(pc);

    setMetrics([
      {
        label: 'Conversaciones Totales',
        value: totalConversations || 0,
        icon: MessageCircle,
        color: 'text-emerald-400',
        bgColor: 'bg-emerald-500/10',
      },
      {
        label: 'Conversaciones Activas',
        value: activeConversations || 0,
        icon: TrendingUp,
        color: 'text-blue-400',
        bgColor: 'bg-blue-500/10',
      },
      {
        label: 'Mensajes Totales',
        value: totalMessages || 0,
        icon: Bot,
        color: 'text-teal-400',
        bgColor: 'bg-teal-500/10',
      },
      {
        label: 'Escalaciones Abiertas',
        value: escalationsOpen || 0,
        icon: AlertTriangle,
        color: escalationsOpen && escalationsOpen > 0 ? 'text-red-400' : 'text-slate-400',
        bgColor: escalationsOpen && escalationsOpen > 0 ? 'bg-red-500/10' : 'bg-slate-500/10',
      },
      {
        label: 'Feedback Pendiente',
        value: feedbackPending || 0,
        icon: Clock,
        color: feedbackPending && feedbackPending > 0 ? 'text-amber-400' : 'text-slate-400',
        bgColor: feedbackPending && feedbackPending > 0 ? 'bg-amber-500/10' : 'bg-slate-500/10',
      },
    ]);

    setRecentActions(actions || []);
    setLoading(false);
  }

  function isAgentOnline(): boolean {
    if (!heartbeat || heartbeat.status !== 'online') return false;
    const lastSeen = new Date(heartbeat.last_seen).getTime();
    return Date.now() - lastSeen < 120_000;
  }

  if (loading) {
    return (
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-4">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="glass-card p-5">
            <div className="skeleton w-10 h-10 rounded-xl mb-3" />
            <div className="skeleton w-16 h-6 mb-1" />
            <div className="skeleton w-24 h-4" />
          </div>
        ))}
      </div>
    );
  }

  const online = isAgentOnline();
  const totalPipeline = Object.values(pipelineCounts).reduce((sum, n) => sum + n, 0) || 1;

  return (
    <div className="space-y-6">
      <div className="glass-card p-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${online ? 'bg-emerald-500/10' : 'bg-red-500/10'}`}>
            {online ? (
              <Wifi className="w-5 h-5 text-emerald-400" />
            ) : (
              <WifiOff className="w-5 h-5 text-red-400" />
            )}
          </div>
          <div>
            <p className="text-sm font-semibold text-white">
              Sales Agent {online ? 'En Linea' : 'Desconectado'}
            </p>
            <p className="text-xs text-slate-500">
              {heartbeat?.last_seen
                ? `Visto ${formatDistanceToNow(new Date(heartbeat.last_seen), { addSuffix: true, locale: es })}`
                : 'Sin datos de heartbeat'}
              {heartbeat?.version && ` - v${heartbeat.version}`}
            </p>
          </div>
        </div>
        <div className={`w-3 h-3 rounded-full ${online ? 'bg-emerald-500 animate-pulse' : 'bg-red-500'}`} />
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-4">
        {metrics.map((m, i) => (
          <div key={i} className="glass-card p-5">
            <div className={`w-10 h-10 rounded-xl ${m.bgColor} flex items-center justify-center mb-3`}>
              <m.icon className={`w-5 h-5 ${m.color}`} />
            </div>
            <p className="text-2xl font-bold text-white">{m.value}</p>
            <p className="text-xs text-slate-400 mt-0.5">{m.label}</p>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="glass-card p-5">
          <h3 className="text-sm font-semibold text-white mb-4">Ventana de Mensajeria (24h)</h3>
          <div className="grid grid-cols-3 gap-4">
            <div className="text-center">
              <div className="w-10 h-10 rounded-xl bg-emerald-500/10 flex items-center justify-center mx-auto mb-2">
                <MessageCircle className="w-5 h-5 text-emerald-400" />
              </div>
              <p className="text-xl font-bold text-white">{windowStats.open}</p>
              <p className="text-[10px] text-slate-500 mt-0.5">Abiertas</p>
            </div>
            <div className="text-center">
              <div className="w-10 h-10 rounded-xl bg-amber-500/10 flex items-center justify-center mx-auto mb-2">
                <Timer className="w-5 h-5 text-amber-400" />
              </div>
              <p className="text-xl font-bold text-white">{windowStats.closing_soon}</p>
              <p className="text-[10px] text-slate-500 mt-0.5">Por Cerrar</p>
            </div>
            <div className="text-center">
              <div className="w-10 h-10 rounded-xl bg-red-500/10 flex items-center justify-center mx-auto mb-2">
                <Lock className="w-5 h-5 text-red-400" />
              </div>
              <p className="text-xl font-bold text-white">{windowStats.closed}</p>
              <p className="text-[10px] text-slate-500 mt-0.5">Cerradas</p>
            </div>
          </div>
          {windowStats.closing_soon > 0 && (
            <div className="mt-4 px-3 py-2 rounded-lg bg-amber-500/10 border border-amber-500/20">
              <p className="text-xs text-amber-400">
                {windowStats.closing_soon} conversacion{windowStats.closing_soon > 1 ? 'es' : ''} con ventana por cerrarse
              </p>
            </div>
          )}
        </div>

        <div className="glass-card p-5">
          <h3 className="text-sm font-semibold text-white mb-4">Pipeline de Ventas</h3>
          <div className="space-y-2.5">
            {STAGE_PIPELINE.map((stage) => {
              const count = pipelineCounts[stage.key] || 0;
              const pct = Math.round((count / totalPipeline) * 100);
              return (
                <div key={stage.key} className="flex items-center gap-3">
                  <span className="text-[11px] text-slate-400 w-20 text-right flex-shrink-0">{stage.label}</span>
                  <div className="flex-1 h-5 bg-white/[0.04] rounded-full overflow-hidden relative">
                    <div
                      className={`h-full ${stage.color} rounded-full transition-all duration-500 ease-out`}
                      style={{ width: `${Math.max(pct, count > 0 ? 3 : 0)}%`, opacity: 0.5 }}
                    />
                    <span className="absolute inset-0 flex items-center justify-center text-[10px] font-medium text-white">
                      {count}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      <div className="glass-card">
        <div className="px-5 py-4 border-b border-white/[0.06]">
          <h3 className="text-sm font-semibold text-white">Actividad Reciente del Agente</h3>
        </div>
        {recentActions.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <Bot className="w-8 h-8 text-slate-600 mb-2" />
            <p className="text-sm text-slate-500">No hay actividad registrada aun</p>
            <p className="text-xs text-slate-600 mt-1">
              Las acciones del agente apareceran aqui cuando el sistema este activo
            </p>
          </div>
        ) : (
          <div className="divide-y divide-white/[0.04]">
            {recentActions.map((action) => (
              <div key={action.id} className="px-5 py-3 flex items-start gap-3">
                <div className="w-8 h-8 rounded-lg bg-emerald-500/10 flex items-center justify-center flex-shrink-0 mt-0.5">
                  <Bot className="w-4 h-4 text-emerald-400" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-white font-medium">{action.action_type}</p>
                  <p className="text-xs text-slate-400 mt-0.5 truncate">{action.output_summary}</p>
                  <div className="flex items-center gap-3 mt-1 text-[10px] text-slate-600">
                    <span>{action.model_used}</span>
                    <span>{action.tokens_input + action.tokens_output} tokens</span>
                    <span>{new Date(action.created_at).toLocaleString('es')}</span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
