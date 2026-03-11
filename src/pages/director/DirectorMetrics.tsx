import { useState, useEffect } from 'react';
import {
  MessageCircle,
  Users,
  Calendar,
  AlertTriangle,
  TrendingUp,
  Clock,
  Bot,
} from 'lucide-react';
import { supabase } from '../../lib/supabase';

interface MetricCard {
  label: string;
  value: string | number;
  icon: typeof MessageCircle;
  color: string;
  bgColor: string;
}

export default function DirectorMetrics() {
  const [metrics, setMetrics] = useState<MetricCard[]>([]);
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
    ]);

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

  return (
    <div className="space-y-6">
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
