import { useState, useEffect } from 'react';
import {
  MessageSquareQuote,
  AlertCircle,
  Lightbulb,
  BookOpen,
  ThumbsUp,
  Loader2,
  CheckCircle2,
} from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { useToast } from '../../contexts/ToastContext';
import type { SalesAgentFeedback } from '../../lib/types';

const TYPE_CONFIG = {
  correction: { icon: AlertCircle, label: 'Correccion', color: 'text-red-400', bg: 'bg-red-500/10' },
  instruction: { icon: Lightbulb, label: 'Instruccion', color: 'text-amber-400', bg: 'bg-amber-500/10' },
  new_knowledge: { icon: BookOpen, label: 'Conocimiento', color: 'text-blue-400', bg: 'bg-blue-500/10' },
  praise: { icon: ThumbsUp, label: 'Bien hecho', color: 'text-emerald-400', bg: 'bg-emerald-500/10' },
};

const STATUS_CONFIG = {
  pending: { label: 'Pendiente', color: 'text-amber-400' },
  processed: { label: 'Procesado', color: 'text-blue-400' },
  incorporated: { label: 'Incorporado', color: 'text-emerald-400' },
};

export default function FeedbackHistory() {
  const toast = useToast();
  const [feedback, setFeedback] = useState<SalesAgentFeedback[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<'all' | SalesAgentFeedback['status']>('all');

  useEffect(() => {
    loadFeedback();
  }, [filter]);

  async function loadFeedback() {
    setLoading(true);
    let query = supabase
      .from('sales_agent_feedback')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(50);

    if (filter !== 'all') {
      query = query.eq('status', filter);
    }

    const { data } = await query;
    setFeedback(data || []);
    setLoading(false);
  }

  async function markProcessed(id: string) {
    const { error } = await supabase
      .from('sales_agent_feedback')
      .update({ status: 'processed', processed_at: new Date().toISOString() })
      .eq('id', id);

    if (error) {
      toast.error('Error al actualizar');
    } else {
      toast.success('Marcado como procesado');
      loadFeedback();
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        {(['all', 'pending', 'processed', 'incorporated'] as const).map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
              filter === f
                ? 'bg-emerald-500/10 text-emerald-400'
                : 'text-slate-400 hover:text-slate-200 hover:bg-white/[0.04]'
            }`}
          >
            {f === 'all' ? 'Todos' : STATUS_CONFIG[f].label}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="flex justify-center py-12">
          <Loader2 className="w-5 h-5 text-emerald-500 animate-spin" />
        </div>
      ) : feedback.length === 0 ? (
        <div className="glass-card flex flex-col items-center justify-center py-16 text-center">
          <MessageSquareQuote className="w-10 h-10 text-slate-600 mb-3" />
          <p className="text-sm text-slate-400">No hay feedback registrado</p>
          <p className="text-xs text-slate-600 mt-1">
            Desde el inbox, haz clic en el icono de feedback en cualquier mensaje del agente
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {feedback.map((fb) => {
            const typeConf = TYPE_CONFIG[fb.feedback_type];
            const statusConf = STATUS_CONFIG[fb.status];
            const Icon = typeConf.icon;

            return (
              <div key={fb.id} className="glass-card p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-start gap-3 min-w-0">
                    <div className={`w-9 h-9 rounded-xl ${typeConf.bg} flex items-center justify-center flex-shrink-0 mt-0.5`}>
                      <Icon className={`w-4 h-4 ${typeConf.color}`} />
                    </div>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className={`text-xs font-medium ${typeConf.color}`}>{typeConf.label}</span>
                        <span className={`text-[10px] font-medium ${statusConf.color}`}>{statusConf.label}</span>
                      </div>
                      <p className="text-sm text-slate-200 mt-1">{fb.content}</p>
                      <p className="text-[10px] text-slate-600 mt-1.5">
                        {new Date(fb.created_at).toLocaleString('es')}
                      </p>
                    </div>
                  </div>

                  {fb.status === 'pending' && (
                    <button
                      onClick={() => markProcessed(fb.id)}
                      className="flex-shrink-0 p-2 rounded-lg text-emerald-400 hover:bg-emerald-500/10 transition-all"
                      title="Marcar como procesado"
                    >
                      <CheckCircle2 className="w-4 h-4" />
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
