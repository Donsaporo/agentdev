import { useState, useEffect } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  ExternalLink,
  Loader2,
} from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { useToast } from '../../contexts/ToastContext';
import type { SalesEscalation } from '../../lib/types';

const PRIORITY_STYLES = {
  critical: { label: 'Critico', color: 'bg-red-500/20 text-red-400' },
  high: { label: 'Alto', color: 'bg-orange-500/20 text-orange-400' },
  normal: { label: 'Normal', color: 'bg-slate-500/20 text-slate-400' },
};

const STATUS_STYLES = {
  open: { label: 'Abierta', color: 'text-red-400' },
  attended: { label: 'Atendida', color: 'text-amber-400' },
  resolved: { label: 'Resuelta', color: 'text-emerald-400' },
};

export default function EscalationQueue() {
  const toast = useToast();
  const [escalations, setEscalations] = useState<SalesEscalation[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<'all' | 'open' | 'attended' | 'resolved'>('open');

  useEffect(() => {
    loadEscalations();
  }, [filter]);

  async function loadEscalations() {
    setLoading(true);
    let query = supabase
      .from('sales_escalation_queue')
      .select('*, contact:whatsapp_contacts(*)')
      .order('created_at', { ascending: false });

    if (filter !== 'all') {
      query = query.eq('status', filter);
    }

    const { data } = await query;
    setEscalations(data || []);
    setLoading(false);
  }

  async function updateStatus(id: string, status: 'attended' | 'resolved') {
    const updates: Record<string, unknown> = { status };
    if (status === 'resolved') updates.resolved_at = new Date().toISOString();

    const { error } = await supabase
      .from('sales_escalation_queue')
      .update(updates)
      .eq('id', id);

    if (error) {
      toast.error('Error al actualizar');
    } else {
      toast.success(`Escalacion marcada como ${STATUS_STYLES[status].label.toLowerCase()}`);
      loadEscalations();
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        {(['all', 'open', 'attended', 'resolved'] as const).map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
              filter === f
                ? 'bg-emerald-500/10 text-emerald-400'
                : 'text-slate-400 hover:text-slate-200 hover:bg-white/[0.04]'
            }`}
          >
            {f === 'all' ? 'Todas' : STATUS_STYLES[f].label}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="flex justify-center py-12">
          <Loader2 className="w-5 h-5 text-emerald-500 animate-spin" />
        </div>
      ) : escalations.length === 0 ? (
        <div className="glass-card flex flex-col items-center justify-center py-16 text-center">
          <CheckCircle2 className="w-10 h-10 text-emerald-500/50 mb-3" />
          <p className="text-sm text-slate-400">No hay escalaciones {filter !== 'all' ? STATUS_STYLES[filter as keyof typeof STATUS_STYLES]?.label.toLowerCase() + 's' : ''}</p>
        </div>
      ) : (
        <div className="space-y-3">
          {escalations.map((esc) => {
            const priority = PRIORITY_STYLES[esc.priority];
            const status = STATUS_STYLES[esc.status];
            const contactName =
              (esc.contact as unknown as { display_name: string; phone_number: string })?.display_name ||
              (esc.contact as unknown as { display_name: string; phone_number: string })?.phone_number ||
              'Desconocido';

            return (
              <div key={esc.id} className="glass-card p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-start gap-3 min-w-0">
                    <div className="w-9 h-9 rounded-xl bg-red-500/10 flex items-center justify-center flex-shrink-0 mt-0.5">
                      <AlertTriangle className="w-4 h-4 text-red-400" />
                    </div>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-medium text-white">{contactName}</span>
                        <span className={`px-2 py-0.5 rounded text-[10px] font-medium ${priority.color}`}>
                          {priority.label}
                        </span>
                        <span className={`text-[10px] font-medium ${status.color}`}>
                          {status.label}
                        </span>
                      </div>
                      <p className="text-sm text-slate-300 mt-1">{esc.reason}</p>
                      {esc.resolution_notes && (
                        <p className="text-xs text-slate-500 mt-1 italic">{esc.resolution_notes}</p>
                      )}
                      <p className="text-[10px] text-slate-600 mt-1.5">
                        {new Date(esc.created_at).toLocaleString('es')}
                      </p>
                    </div>
                  </div>

                  <div className="flex items-center gap-1 flex-shrink-0">
                    {esc.status === 'open' && (
                      <>
                        <button
                          onClick={() => updateStatus(esc.id, 'attended')}
                          className="px-2.5 py-1.5 rounded-lg text-xs font-medium text-amber-400 hover:bg-amber-500/10 transition-all"
                        >
                          <Clock className="w-3.5 h-3.5" />
                        </button>
                        <button
                          onClick={() => updateStatus(esc.id, 'resolved')}
                          className="px-2.5 py-1.5 rounded-lg text-xs font-medium text-emerald-400 hover:bg-emerald-500/10 transition-all"
                        >
                          <CheckCircle2 className="w-3.5 h-3.5" />
                        </button>
                      </>
                    )}
                    {esc.status === 'attended' && (
                      <button
                        onClick={() => updateStatus(esc.id, 'resolved')}
                        className="px-2.5 py-1.5 rounded-lg text-xs font-medium text-emerald-400 hover:bg-emerald-500/10 transition-all"
                      >
                        <CheckCircle2 className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
