import { useState, useEffect, useRef, useCallback } from 'react';
import {
  Send,
  Bot,
  User,
  Loader2,
  MessageSquare,
  AlertCircle,
  Lightbulb,
  BookOpen,
  ThumbsUp,
  ChevronDown,
  Link2,
  Sparkles,
  CheckCircle2,
} from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { useAuth } from '../../contexts/AuthContext';
import { useToast } from '../../contexts/ToastContext';
import { formatDistanceToNow } from 'date-fns';
import { es } from 'date-fns/locale';
import type { SalesAgentFeedback } from '../../lib/types';

interface ConversationOption {
  id: string;
  contactName: string;
  lastMessage: string;
  lastMessageAt: string;
}

interface AgentAck {
  id: string;
  isAgent: true;
  content: string;
  created_at: string;
}

type ChatEntry = (SalesAgentFeedback & { isAgent?: false }) | AgentAck;

const FEEDBACK_TYPES = [
  { value: 'correction' as const, label: 'Correccion', icon: AlertCircle, color: 'text-red-400', bg: 'bg-red-500/10', border: 'border-red-500/20' },
  { value: 'instruction' as const, label: 'Instruccion', icon: Lightbulb, color: 'text-amber-400', bg: 'bg-amber-500/10', border: 'border-amber-500/20' },
  { value: 'new_knowledge' as const, label: 'Conocimiento', icon: BookOpen, color: 'text-blue-400', bg: 'bg-blue-500/10', border: 'border-blue-500/20' },
  { value: 'praise' as const, label: 'Bien hecho', icon: ThumbsUp, color: 'text-emerald-400', bg: 'bg-emerald-500/10', border: 'border-emerald-500/20' },
];

const STATUS_BADGE = {
  pending: { label: 'Pendiente', color: 'bg-amber-500/15 text-amber-400' },
  processed: { label: 'Procesado', color: 'bg-blue-500/15 text-blue-400' },
  incorporated: { label: 'Incorporado', color: 'bg-emerald-500/15 text-emerald-400' },
};

function getAgentAck(feedbackType: SalesAgentFeedback['feedback_type'], autoCreated: boolean): string {
  if (feedbackType === 'correction') {
    return autoCreated
      ? 'Entendido. He registrado la correccion como instruccion de prioridad alta. La aplicare en mis proximas respuestas.'
      : 'He recibido tu correccion. La tendre en cuenta.';
  }
  if (feedbackType === 'instruction') {
    return autoCreated
      ? 'Instruccion registrada. Ya la estoy aplicando en mis conversaciones activas.'
      : 'Instruccion recibida. La procesare pronto.';
  }
  if (feedbackType === 'new_knowledge') {
    return 'Informacion guardada en mi base de conocimiento. La usare cuando sea relevante en conversaciones.';
  }
  return 'Gracias por el feedback. Lo aprecio.';
}

export default function DirectorChat() {
  const { user } = useAuth();
  const toast = useToast();
  const [entries, setEntries] = useState<ChatEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [feedbackType, setFeedbackType] = useState<SalesAgentFeedback['feedback_type']>('instruction');
  const [showTypeSelector, setShowTypeSelector] = useState(false);
  const [linkedConversationId, setLinkedConversationId] = useState<string | null>(null);
  const [showConversationPicker, setShowConversationPicker] = useState(false);
  const [conversations, setConversations] = useState<ConversationOption[]>([]);
  const [autoCreateInstruction, setAutoCreateInstruction] = useState(true);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  useEffect(() => {
    loadMessages();
    loadConversations();
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [entries, scrollToBottom]);

  async function loadMessages() {
    setLoading(true);
    const { data } = await supabase
      .from('sales_agent_feedback')
      .select('*')
      .order('created_at', { ascending: true })
      .limit(100);

    const loaded: ChatEntry[] = [];
    for (const msg of data || []) {
      loaded.push(msg);
      if (msg.status === 'incorporated') {
        loaded.push({
          id: `ack-${msg.id}`,
          isAgent: true,
          content: getAgentAck(msg.feedback_type, true),
          created_at: msg.processed_at || msg.created_at,
        });
      }
    }
    setEntries(loaded);
    setLoading(false);
  }

  async function loadConversations() {
    const { data } = await supabase
      .from('whatsapp_conversations')
      .select('id, last_message_preview, last_message_at, contact:whatsapp_contacts(display_name, profile_name, phone_number)')
      .order('last_message_at', { ascending: false })
      .limit(20);

    if (data) {
      const options: ConversationOption[] = data.map((c: Record<string, unknown>) => {
        const contact = c.contact as Record<string, string> | null;
        return {
          id: c.id as string,
          contactName: contact?.display_name || contact?.profile_name || contact?.phone_number || 'Desconocido',
          lastMessage: (c.last_message_preview as string) || '',
          lastMessageAt: c.last_message_at as string,
        };
      });
      setConversations(options);
    }
  }

  async function handleSend() {
    if (!input.trim() || !user || sending) return;

    const text = input.trim();
    setInput('');
    setSending(true);

    const { data: feedback, error } = await supabase
      .from('sales_agent_feedback')
      .insert({
        conversation_id: linkedConversationId,
        feedback_type: feedbackType,
        content: text,
        created_by: user.id,
      })
      .select()
      .maybeSingle();

    if (error) {
      toast.error('Error al enviar');
      setInput(text);
      setSending(false);
      return;
    }

    if (feedback) {
      setEntries((prev) => [...prev, feedback]);
    }

    let wasIncorporated = false;

    if (autoCreateInstruction && (feedbackType === 'instruction' || feedbackType === 'correction')) {
      const priority = feedbackType === 'correction' ? 'high' : 'normal';
      const category = feedbackType === 'correction' ? 'correcciones' : 'general';

      await supabase.from('sales_agent_instructions').insert({
        instruction: text,
        priority,
        category,
        source_feedback_id: feedback?.id || null,
      });

      if (feedback) {
        await supabase
          .from('sales_agent_feedback')
          .update({ status: 'incorporated' })
          .eq('id', feedback.id);

        setEntries((prev) =>
          prev.map((m) => (m.id === feedback.id ? { ...m, status: 'incorporated' as const } : m))
        );
        wasIncorporated = true;
      }
    }

    if (feedbackType === 'new_knowledge') {
      await supabase.from('sales_agent_knowledge').insert({
        title: text.slice(0, 80),
        content: text,
        category: 'director_input',
        source: 'director_chat',
      });

      if (feedback) {
        await supabase
          .from('sales_agent_feedback')
          .update({ status: 'incorporated' })
          .eq('id', feedback.id);

        setEntries((prev) =>
          prev.map((m) => (m.id === feedback.id ? { ...m, status: 'incorporated' as const } : m))
        );
        wasIncorporated = true;
      }
    }

    const ackText = getAgentAck(feedbackType, wasIncorporated);
    const ack: AgentAck = {
      id: `ack-${feedback?.id || Date.now()}`,
      isAgent: true,
      content: ackText,
      created_at: new Date().toISOString(),
    };
    setEntries((prev) => [...prev, ack]);

    setLinkedConversationId(null);
    setSending(false);
    inputRef.current?.focus();
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  const activeType = FEEDBACK_TYPES.find((t) => t.value === feedbackType)!;
  const linkedConversation = conversations.find((c) => c.id === linkedConversationId);

  return (
    <div className="flex flex-col h-[calc(100vh-240px)] min-h-[500px]">
      <div className="flex items-center justify-between px-1 pb-4">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-xl bg-emerald-500/10 flex items-center justify-center">
            <Bot className="w-4 h-4 text-emerald-400" />
          </div>
          <div>
            <p className="text-sm font-medium text-white">Chat con el Agente</p>
            <p className="text-[10px] text-slate-500">
              Correcciones, instrucciones y conocimiento
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-1.5 cursor-pointer">
            <input
              type="checkbox"
              checked={autoCreateInstruction}
              onChange={(e) => setAutoCreateInstruction(e.target.checked)}
              className="w-3.5 h-3.5 rounded border-white/20 bg-white/[0.04] text-emerald-500 focus:ring-emerald-500/30 focus:ring-offset-0"
            />
            <span className="text-[10px] text-slate-500">Auto-crear instruccion</span>
          </label>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto glass-card rounded-2xl mb-3">
        {loading ? (
          <div className="flex items-center justify-center h-full">
            <Loader2 className="w-5 h-5 text-emerald-500 animate-spin" />
          </div>
        ) : entries.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-center px-6">
            <div className="w-16 h-16 rounded-2xl bg-emerald-500/[0.07] flex items-center justify-center mb-4">
              <MessageSquare className="w-8 h-8 text-emerald-500/40" />
            </div>
            <p className="text-sm font-medium text-slate-300 mb-1">
              Panel de comunicacion con el agente
            </p>
            <p className="text-xs text-slate-500 max-w-sm">
              Escribe correcciones, instrucciones o informacion nueva. El agente incorporara
              automaticamente tus indicaciones en sus futuras respuestas.
            </p>
            <div className="grid grid-cols-2 gap-3 mt-6 max-w-sm w-full">
              {FEEDBACK_TYPES.map((ft) => (
                <button
                  key={ft.value}
                  onClick={() => {
                    setFeedbackType(ft.value);
                    inputRef.current?.focus();
                  }}
                  className={`flex items-center gap-2 px-3 py-2.5 rounded-xl ${ft.bg} border ${ft.border} text-xs font-medium ${ft.color} hover:brightness-110 transition-all`}
                >
                  <ft.icon className="w-3.5 h-3.5" />
                  {ft.label}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="p-4 space-y-4">
            {entries.map((entry) => {
              if ('isAgent' in entry && entry.isAgent) {
                return (
                  <div key={entry.id} className="flex gap-3">
                    <div className="flex-shrink-0 mt-1">
                      <div className="w-8 h-8 rounded-lg bg-emerald-500/10 flex items-center justify-center ring-1 ring-emerald-500/20">
                        <Bot className="w-4 h-4 text-emerald-400" />
                      </div>
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="text-xs font-medium text-emerald-400">Agente</span>
                        <span className="text-[10px] text-slate-600">
                          {formatTime(entry.created_at)}
                        </span>
                      </div>
                      <div className="bg-emerald-500/[0.04] border border-emerald-500/10 rounded-xl rounded-tl-sm px-4 py-3">
                        <p className="text-sm text-emerald-300/80 leading-relaxed">{entry.content}</p>
                      </div>
                    </div>
                  </div>
                );
              }

              const msg = entry as SalesAgentFeedback;
              const typeConf = FEEDBACK_TYPES.find((t) => t.value === msg.feedback_type) || FEEDBACK_TYPES[0];
              const statusConf = STATUS_BADGE[msg.status];
              const TypeIcon = typeConf.icon;

              return (
                <div key={msg.id} className="flex gap-3">
                  <div className="flex-shrink-0 mt-1">
                    <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-slate-700 to-slate-800 flex items-center justify-center ring-1 ring-white/[0.06]">
                      <User className="w-4 h-4 text-slate-300" />
                    </div>
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-xs font-medium text-slate-300">Director</span>
                      <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-medium ${typeConf.bg} ${typeConf.color}`}>
                        <TypeIcon className="w-2.5 h-2.5" />
                        {typeConf.label}
                      </span>
                      <span className={`px-1.5 py-0.5 rounded text-[9px] font-medium ${statusConf.color}`}>
                        {statusConf.label}
                      </span>
                      <span className="text-[10px] text-slate-600">
                        {formatTime(msg.created_at)}
                      </span>
                    </div>
                    <div className="bg-white/[0.03] border border-white/[0.06] rounded-xl rounded-tl-sm px-4 py-3">
                      <p className="text-sm text-slate-200 whitespace-pre-wrap leading-relaxed">{msg.content}</p>
                      {msg.conversation_id && (
                        <div className="flex items-center gap-1 mt-2 pt-2 border-t border-white/[0.04]">
                          <Link2 className="w-3 h-3 text-slate-600" />
                          <span className="text-[10px] text-slate-600">
                            Vinculado a conversacion {msg.conversation_id.slice(0, 8)}
                          </span>
                        </div>
                      )}
                    </div>
                    {msg.status === 'incorporated' && (
                      <div className="flex items-center gap-1 mt-1.5">
                        <CheckCircle2 className="w-3 h-3 text-emerald-500" />
                        <span className="text-[10px] text-emerald-500/70">
                          Incorporado al sistema del agente
                        </span>
                      </div>
                    )}
                  </div>
                </div>
              );
            })}

            {sending && (
              <div className="flex gap-3">
                <div className="flex-shrink-0 mt-1">
                  <div className="w-8 h-8 rounded-lg bg-emerald-500/10 flex items-center justify-center">
                    <Bot className="w-4 h-4 text-emerald-400" />
                  </div>
                </div>
                <div className="flex-1">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-xs font-medium text-emerald-400">Agente</span>
                  </div>
                  <div className="bg-emerald-500/[0.04] border border-emerald-500/10 rounded-xl rounded-tl-sm px-4 py-3">
                    <div className="flex items-center gap-2 text-sm text-emerald-400/70">
                      <Sparkles className="w-3.5 h-3.5 animate-pulse" />
                      Procesando e incorporando...
                    </div>
                  </div>
                </div>
              </div>
            )}

            <div ref={messagesEndRef} />
          </div>
        )}
      </div>

      {linkedConversation && (
        <div className="flex items-center gap-2 px-3 py-2 mb-2 bg-blue-500/[0.06] border border-blue-500/10 rounded-xl">
          <Link2 className="w-3.5 h-3.5 text-blue-400 flex-shrink-0" />
          <span className="text-xs text-blue-400 truncate flex-1">
            Vinculado a: {linkedConversation.contactName}
          </span>
          <button
            onClick={() => setLinkedConversationId(null)}
            className="text-[10px] text-blue-400/60 hover:text-blue-300 transition-colors"
          >
            Quitar
          </button>
        </div>
      )}

      <div className="flex items-end gap-2">
        <div className="relative">
          <button
            onClick={() => setShowTypeSelector(!showTypeSelector)}
            className={`flex items-center gap-1.5 px-3 py-2.5 rounded-xl text-xs font-medium transition-all ${activeType.bg} ${activeType.color} border ${activeType.border}`}
          >
            <activeType.icon className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">{activeType.label}</span>
            <ChevronDown className="w-3 h-3 opacity-50" />
          </button>

          {showTypeSelector && (
            <>
              <div className="fixed inset-0 z-10" onClick={() => setShowTypeSelector(false)} />
              <div className="absolute bottom-full left-0 mb-2 w-48 bg-[#0d1117] border border-white/[0.08] rounded-xl shadow-2xl z-20 overflow-hidden">
                {FEEDBACK_TYPES.map((ft) => (
                  <button
                    key={ft.value}
                    onClick={() => {
                      setFeedbackType(ft.value);
                      setShowTypeSelector(false);
                    }}
                    className={`w-full flex items-center gap-2.5 px-3 py-2.5 text-xs transition-all hover:bg-white/[0.04] ${
                      feedbackType === ft.value ? `${ft.color} ${ft.bg}` : 'text-slate-400'
                    }`}
                  >
                    <ft.icon className="w-3.5 h-3.5" />
                    {ft.label}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>

        <button
          onClick={() => setShowConversationPicker(!showConversationPicker)}
          className={`p-2.5 rounded-xl transition-all ${
            linkedConversationId
              ? 'bg-blue-500/10 text-blue-400 border border-blue-500/20'
              : 'bg-white/[0.04] text-slate-500 hover:text-slate-300 border border-white/[0.06]'
          }`}
          title="Vincular a conversacion"
        >
          <Link2 className="w-4 h-4" />
        </button>

        {showConversationPicker && (
          <>
            <div className="fixed inset-0 z-10" onClick={() => setShowConversationPicker(false)} />
            <div className="absolute bottom-20 left-0 right-0 mx-4 max-h-64 overflow-y-auto bg-[#0d1117] border border-white/[0.08] rounded-xl shadow-2xl z-20">
              <div className="p-2 border-b border-white/[0.06]">
                <p className="text-[10px] text-slate-500 px-2">Vincular feedback a una conversacion</p>
              </div>
              {conversations.map((conv) => (
                <button
                  key={conv.id}
                  onClick={() => {
                    setLinkedConversationId(conv.id);
                    setShowConversationPicker(false);
                  }}
                  className={`w-full text-left px-3 py-2.5 hover:bg-white/[0.04] transition-all ${
                    linkedConversationId === conv.id ? 'bg-emerald-500/[0.06]' : ''
                  }`}
                >
                  <p className="text-xs font-medium text-slate-200 truncate">{conv.contactName}</p>
                  <p className="text-[10px] text-slate-500 truncate">{conv.lastMessage}</p>
                </button>
              ))}
              {conversations.length === 0 && (
                <div className="px-3 py-6 text-center">
                  <p className="text-xs text-slate-500">No hay conversaciones</p>
                </div>
              )}
            </div>
          </>
        )}

        <textarea
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={getPlaceholder(feedbackType)}
          rows={1}
          className="flex-1 bg-white/[0.04] border border-white/[0.08] rounded-xl px-4 py-2.5 text-sm text-white placeholder-slate-500 focus:outline-none focus:ring-1 focus:ring-emerald-500/30 transition-all resize-none max-h-32"
          style={{ minHeight: '42px' }}
        />

        <button
          onClick={handleSend}
          disabled={!input.trim() || sending}
          className="flex-shrink-0 w-10 h-10 rounded-xl bg-emerald-600 hover:bg-emerald-500 disabled:bg-slate-700 disabled:text-slate-500 text-white flex items-center justify-center transition-all active:scale-95"
        >
          {sending ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <Send className="w-4 h-4" />
          )}
        </button>
      </div>
    </div>
  );
}

function formatTime(dateStr: string): string {
  if (!dateStr) return '';
  try {
    return formatDistanceToNow(new Date(dateStr), { addSuffix: true, locale: es });
  } catch {
    return '';
  }
}

function getPlaceholder(type: SalesAgentFeedback['feedback_type']): string {
  switch (type) {
    case 'correction':
      return 'Ej: En la conversacion con Juan, no debiste ofrecer descuento sin consultar...';
    case 'instruction':
      return 'Ej: Cuando pregunten por precios, siempre sugiere una reunion primero...';
    case 'new_knowledge':
      return 'Ej: Ahora ofrecemos servicio de mantenimiento mensual por $500/mes...';
    case 'praise':
      return 'Ej: Excelente manejo de la objecion de precio con el cliente Maria...';
    default:
      return 'Escribe tu mensaje al agente...';
  }
}
