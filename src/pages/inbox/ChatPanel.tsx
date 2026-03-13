import { useState, useEffect, useRef, useCallback } from 'react';
import {
  Send,
  Bot,
  UserRound,
  ArrowLeftRight,
  Phone,
  MoreVertical,
  ChevronLeft,
  Loader2,
  Wand2,
  X,
  RotateCcw,
} from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { useToast } from '../../contexts/ToastContext';
import { useConversationMessages } from './useInboxData';
import MessageBubble from './MessageBubble';
import type { WhatsAppConversation, WhatsAppContact, AgentMode } from '../../lib/types';

interface Props {
  conversation: WhatsAppConversation;
  contact: WhatsAppContact | undefined;
  onBack: () => void;
  onToggleContact: () => void;
  onFeedback: (messageId: string) => void;
}

export default function ChatPanel({
  conversation,
  contact,
  onBack,
  onToggleContact,
  onFeedback,
}: Props) {
  const toast = useToast();
  const { messages, loading } = useConversationMessages(conversation.id);
  const [newMessage, setNewMessage] = useState('');
  const [sending, setSending] = useState(false);
  const [toneEnabled, setToneEnabled] = useState(true);
  const [transformedPreview, setTransformedPreview] = useState<string | null>(null);
  const [transforming, setTransforming] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages, scrollToBottom]);

  useEffect(() => {
    inputRef.current?.focus();
  }, [conversation.id]);

  useEffect(() => {
    setTransformedPreview(null);
  }, [conversation.id]);

  async function transformMessage(text: string): Promise<string> {
    const apiUrl = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/compose-as-persona`;
    const res = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${import.meta.env.VITE_SUPABASE_ANON_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        text,
        persona_id: conversation.agent_persona_id,
        conversation_id: conversation.id,
      }),
    });

    if (!res.ok) throw new Error('Error al transformar mensaje');
    const data = await res.json();
    return data.transformed || text;
  }

  async function handleSend() {
    if (!newMessage.trim() || sending) return;

    const text = newMessage.trim();

    if (toneEnabled && !transformedPreview && conversation.agent_persona_id) {
      setTransforming(true);
      try {
        const transformed = await transformMessage(text);
        setTransformedPreview(transformed);
      } catch {
        toast.error('No se pudo transformar el mensaje. Enviando original.');
        await sendMessage(text);
      } finally {
        setTransforming(false);
      }
      return;
    }

    const messageToSend = transformedPreview || text;
    await sendMessage(messageToSend);
  }

  async function sendMessage(text: string) {
    setNewMessage('');
    setTransformedPreview(null);
    setSending(true);

    try {
      const { data: account } = await supabase
        .from('whatsapp_business_accounts')
        .select('id')
        .eq('status', 'connected')
        .limit(1)
        .maybeSingle();

      if (!account) {
        toast.error('No hay cuenta de WhatsApp conectada');
        setNewMessage(text);
        setSending(false);
        return;
      }

      const to = contact?.wa_id || contact?.phone_number;
      if (!to) {
        toast.error('No se encontro numero de destino');
        setNewMessage(text);
        setSending(false);
        return;
      }

      const apiUrl = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/whatsapp-send-message`;
      const res = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${import.meta.env.VITE_SUPABASE_ANON_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          account_id: account.id,
          to,
          message: text,
          type: 'text',
        }),
      });

      const result = await res.json();
      if (!res.ok || result.error) {
        throw new Error(result.error || 'Error al enviar mensaje');
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Error al enviar');
      setNewMessage(text);
    } finally {
      setSending(false);
      inputRef.current?.focus();
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (transformedPreview) {
        sendMessage(transformedPreview);
      } else {
        handleSend();
      }
    }
    if (e.key === 'Escape' && transformedPreview) {
      setTransformedPreview(null);
    }
  }

  function handleCancelPreview() {
    setTransformedPreview(null);
  }

  function handleSendOriginal() {
    const text = newMessage.trim();
    if (text) sendMessage(text);
  }

  async function handleRetransform() {
    const text = newMessage.trim();
    if (!text) return;
    setTransforming(true);
    try {
      const transformed = await transformMessage(text);
      setTransformedPreview(transformed);
    } catch {
      toast.error('No se pudo transformar el mensaje');
    } finally {
      setTransforming(false);
    }
  }

  async function toggleAgentMode(mode: AgentMode) {
    await supabase
      .from('whatsapp_conversations')
      .update({ agent_mode: mode })
      .eq('id', conversation.id);

    if (mode === 'manual') {
      toast.success('Tomaste el control de la conversacion');
    } else {
      toast.success('Agente IA reactivado');
    }
  }

  const name = contact?.display_name || contact?.profile_name || contact?.phone_number || 'Desconocido';
  const personaName = conversation.persona?.first_name || conversation.persona?.full_name;

  return (
    <div className="flex flex-col h-full">
      <div className="flex-shrink-0 px-4 py-3 border-b border-white/[0.06] flex items-center gap-3">
        <button
          onClick={onBack}
          className="lg:hidden p-1.5 rounded-lg hover:bg-white/[0.04] text-slate-400"
        >
          <ChevronLeft className="w-5 h-5" />
        </button>

        <button onClick={onToggleContact} className="flex items-center gap-3 flex-1 min-w-0">
          <div className="w-10 h-10 rounded-full bg-gradient-to-br from-slate-700 to-slate-800 flex items-center justify-center text-xs font-bold text-white ring-1 ring-white/[0.06] flex-shrink-0">
            {name.split(' ').map((w: string) => w[0]).join('').toUpperCase().slice(0, 2)}
          </div>
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-white truncate">{name}</h3>
            <p className="text-[11px] text-slate-500 truncate">
              {contact?.phone_number}
              {conversation.persona && ` -- ${conversation.persona.full_name}`}
            </p>
          </div>
        </button>

        <div className="flex items-center gap-1 flex-shrink-0">
          {conversation.agent_mode === 'ai' ? (
            <button
              onClick={() => toggleAgentMode('manual')}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-medium bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20 transition-all"
              title="Tomar control manualmente"
            >
              <Bot className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">IA activa</span>
              <ArrowLeftRight className="w-3 h-3 opacity-50" />
            </button>
          ) : (
            <button
              onClick={() => toggleAgentMode('ai')}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-medium bg-blue-500/10 text-blue-400 hover:bg-blue-500/20 transition-all"
              title="Devolver al agente IA"
            >
              <UserRound className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">Manual</span>
              <ArrowLeftRight className="w-3 h-3 opacity-50" />
            </button>
          )}

          <button className="p-2 rounded-xl text-slate-400 hover:text-slate-200 hover:bg-white/[0.04] transition-all">
            <Phone className="w-4 h-4" />
          </button>
          <button
            onClick={onToggleContact}
            className="p-2 rounded-xl text-slate-400 hover:text-slate-200 hover:bg-white/[0.04] transition-all"
          >
            <MoreVertical className="w-4 h-4" />
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-3">
        {loading && (
          <div className="flex justify-center py-8">
            <Loader2 className="w-5 h-5 text-emerald-500 animate-spin" />
          </div>
        )}

        {!loading && messages.length === 0 && (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <p className="text-sm text-slate-500">No hay mensajes en esta conversacion</p>
          </div>
        )}

        {messages.map((msg) => (
          <MessageBubble
            key={msg.id}
            message={msg}
            onFeedback={onFeedback}
            showFeedbackButton={msg.direction === 'outbound'}
          />
        ))}

        {conversation.is_agent_typing && (
          <div className="flex justify-start">
            <div className="bg-white/[0.05] border border-white/[0.06] rounded-2xl px-4 py-3">
              <div className="flex items-center gap-1">
                <div className="w-2 h-2 rounded-full bg-slate-400 animate-bounce" style={{ animationDelay: '0ms' }} />
                <div className="w-2 h-2 rounded-full bg-slate-400 animate-bounce" style={{ animationDelay: '150ms' }} />
                <div className="w-2 h-2 rounded-full bg-slate-400 animate-bounce" style={{ animationDelay: '300ms' }} />
              </div>
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      <div className="flex-shrink-0 border-t border-white/[0.06]">
        {transformedPreview && (
          <div className="px-4 pt-3 pb-1">
            <div className="bg-emerald-500/[0.07] border border-emerald-500/20 rounded-xl p-3">
              <div className="flex items-center justify-between mb-2">
                <span className="text-[11px] font-medium text-emerald-400/80 uppercase tracking-wider">
                  Vista previa como {personaName || 'persona'}
                </span>
                <div className="flex items-center gap-1">
                  <button
                    onClick={handleRetransform}
                    disabled={transforming}
                    className="p-1 rounded-md text-slate-400 hover:text-emerald-400 hover:bg-white/[0.04] transition-all"
                    title="Regenerar"
                  >
                    <RotateCcw className={`w-3.5 h-3.5 ${transforming ? 'animate-spin' : ''}`} />
                  </button>
                  <button
                    onClick={handleCancelPreview}
                    className="p-1 rounded-md text-slate-400 hover:text-red-400 hover:bg-white/[0.04] transition-all"
                    title="Cancelar"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
              <p className="text-sm text-emerald-50 leading-relaxed">{transformedPreview}</p>
              <div className="flex items-center gap-2 mt-2.5">
                <button
                  onClick={() => sendMessage(transformedPreview)}
                  disabled={sending}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-medium transition-all"
                >
                  {sending ? <Loader2 className="w-3 h-3 animate-spin" /> : <Send className="w-3 h-3" />}
                  Enviar
                </button>
                <button
                  onClick={handleSendOriginal}
                  disabled={sending}
                  className="px-3 py-1.5 rounded-lg bg-white/[0.05] hover:bg-white/[0.08] text-slate-300 text-xs font-medium transition-all"
                >
                  Enviar original
                </button>
              </div>
            </div>
          </div>
        )}

        <div className="px-4 py-3">
          <div className="flex items-end gap-2">
            <div className="flex-1 relative">
              <textarea
                ref={inputRef}
                value={newMessage}
                onChange={(e) => setNewMessage(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={
                  conversation.agent_mode === 'ai'
                    ? 'El agente IA esta respondiendo... (escribe para enviar manualmente)'
                    : 'Escribe un mensaje...'
                }
                rows={1}
                className="w-full bg-white/[0.04] border border-white/[0.08] rounded-xl px-4 py-2.5 pr-12 text-sm text-white placeholder-slate-500 focus:outline-none focus:ring-1 focus:ring-emerald-500/30 transition-all resize-none max-h-32"
                style={{ minHeight: '42px' }}
              />
              {conversation.agent_persona_id && (
                <button
                  onClick={() => setToneEnabled(!toneEnabled)}
                  className={`absolute right-2 bottom-2 p-1.5 rounded-lg transition-all ${
                    toneEnabled
                      ? 'text-emerald-400 bg-emerald-500/15 hover:bg-emerald-500/25'
                      : 'text-slate-500 hover:text-slate-400 hover:bg-white/[0.04]'
                  }`}
                  title={toneEnabled ? `Tono de ${personaName || 'persona'} activado` : 'Tono de persona desactivado'}
                >
                  <Wand2 className="w-4 h-4" />
                </button>
              )}
            </div>
            <button
              onClick={transformedPreview ? () => sendMessage(transformedPreview) : handleSend}
              disabled={!newMessage.trim() || sending || transforming}
              className="flex-shrink-0 w-10 h-10 rounded-xl bg-emerald-600 hover:bg-emerald-500 disabled:bg-slate-700 disabled:text-slate-500 text-white flex items-center justify-center transition-all active:scale-95"
            >
              {sending || transforming ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Send className="w-4 h-4" />
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
