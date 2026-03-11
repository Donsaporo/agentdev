import { useState } from 'react';
import { X, MessageSquareQuote, Send } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { useAuth } from '../../contexts/AuthContext';
import { useToast } from '../../contexts/ToastContext';
import type { SalesAgentFeedback } from '../../lib/types';

interface Props {
  messageId: string | null;
  conversationId: string | null;
  onClose: () => void;
}

const FEEDBACK_TYPES: { value: SalesAgentFeedback['feedback_type']; label: string; description: string }[] = [
  { value: 'correction', label: 'Correccion', description: 'El agente dijo algo incorrecto' },
  { value: 'instruction', label: 'Instruccion', description: 'El agente debe hacer esto diferente' },
  { value: 'new_knowledge', label: 'Conocimiento nuevo', description: 'Informacion que el agente no tenia' },
  { value: 'praise', label: 'Bien hecho', description: 'El agente respondio correctamente' },
];

export default function FeedbackModal({ messageId, conversationId, onClose }: Props) {
  const { user } = useAuth();
  const toast = useToast();
  const [type, setType] = useState<SalesAgentFeedback['feedback_type']>('correction');
  const [content, setContent] = useState('');
  const [sending, setSending] = useState(false);

  async function handleSubmit() {
    if (!content.trim() || !user) return;

    setSending(true);
    const { error } = await supabase.from('sales_agent_feedback').insert({
      conversation_id: conversationId,
      message_id: messageId,
      feedback_type: type,
      content: content.trim(),
      created_by: user.id,
    });

    if (error) {
      toast.error('Error al enviar feedback');
    } else {
      toast.success('Feedback registrado');
      onClose();
    }
    setSending(false);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div
        className="w-full max-w-md bg-[#0d1117] border border-white/[0.08] rounded-2xl shadow-2xl animate-scale-in"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-white/[0.06]">
          <div className="flex items-center gap-2">
            <MessageSquareQuote className="w-5 h-5 text-amber-400" />
            <h3 className="text-sm font-semibold text-white">Feedback al Agente</h3>
          </div>
          <button onClick={onClose} className="p-1 rounded-lg hover:bg-white/[0.04] text-slate-400">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-5 space-y-4">
          <div>
            <label className="text-xs text-slate-400 mb-2 block">Tipo de feedback</label>
            <div className="grid grid-cols-2 gap-2">
              {FEEDBACK_TYPES.map((ft) => (
                <button
                  key={ft.value}
                  onClick={() => setType(ft.value)}
                  className={`text-left px-3 py-2 rounded-xl border text-xs transition-all ${
                    type === ft.value
                      ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400'
                      : 'border-white/[0.06] text-slate-400 hover:bg-white/[0.04]'
                  }`}
                >
                  <span className="font-medium block">{ft.label}</span>
                  <span className="text-[10px] opacity-60">{ft.description}</span>
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="text-xs text-slate-400 mb-1.5 block">Detalle</label>
            <textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              rows={4}
              className="w-full bg-white/[0.04] border border-white/[0.08] rounded-xl px-4 py-3 text-sm text-white placeholder-slate-500 focus:outline-none focus:ring-1 focus:ring-emerald-500/30 resize-none"
              placeholder="Describe que deberia haber dicho el agente, que estuvo mal, o que informacion le falta..."
              autoFocus
            />
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 px-5 py-4 border-t border-white/[0.06]">
          <button onClick={onClose} className="px-4 py-2 text-sm text-slate-400 hover:text-slate-200 rounded-xl transition-all">
            Cancelar
          </button>
          <button
            onClick={handleSubmit}
            disabled={!content.trim() || sending}
            className="flex items-center gap-2 px-4 py-2 bg-emerald-600 hover:bg-emerald-500 disabled:bg-slate-700 disabled:text-slate-500 text-white text-sm font-medium rounded-xl transition-all"
          >
            <Send className="w-3.5 h-3.5" />
            {sending ? 'Enviando...' : 'Enviar feedback'}
          </button>
        </div>
      </div>
    </div>
  );
}
