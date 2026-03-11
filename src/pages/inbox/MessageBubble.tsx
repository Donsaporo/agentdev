import { Check, CheckCheck, Clock, AlertCircle, MessageSquareQuote } from 'lucide-react';
import type { WhatsAppMessage } from '../../lib/types';

const STATUS_ICONS: Record<string, JSX.Element> = {
  sent: <Check className="w-3 h-3 text-slate-500" />,
  delivered: <CheckCheck className="w-3 h-3 text-slate-500" />,
  read: <CheckCheck className="w-3 h-3 text-blue-400" />,
  failed: <AlertCircle className="w-3 h-3 text-red-400" />,
  received: <Clock className="w-3 h-3 text-slate-600" />,
};

interface Props {
  message: WhatsAppMessage;
  onFeedback?: (messageId: string) => void;
  showFeedbackButton?: boolean;
}

export default function MessageBubble({ message, onFeedback, showFeedbackButton }: Props) {
  const isOutbound = message.direction === 'outbound';

  function formatTime(dateStr: string) {
    try {
      const d = new Date(dateStr);
      return d.toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' });
    } catch {
      return '';
    }
  }

  function renderContent() {
    if (message.message_type === 'text' || !message.message_type) {
      return <p className="text-sm leading-relaxed whitespace-pre-wrap break-words">{message.content}</p>;
    }

    if (message.message_type === 'image') {
      return (
        <div>
          {message.media_url && (
            <div className="w-48 h-32 bg-slate-700/50 rounded-lg mb-1 flex items-center justify-center text-xs text-slate-400">
              Imagen
            </div>
          )}
          {message.content && <p className="text-sm mt-1">{message.content}</p>}
        </div>
      );
    }

    if (message.message_type === 'location') {
      return (
        <div className="flex items-center gap-2 text-sm">
          <span className="text-slate-400">Ubicacion:</span>
          <span>{message.content}</span>
        </div>
      );
    }

    if (message.message_type === 'document') {
      return (
        <div className="flex items-center gap-2 text-sm bg-white/[0.04] rounded-lg px-3 py-2">
          <span className="text-slate-400">Documento</span>
          {message.content && <span className="truncate">{message.content}</span>}
        </div>
      );
    }

    if (message.message_type === 'audio') {
      return (
        <div className="flex items-center gap-2 text-sm text-slate-400">
          Mensaje de voz
        </div>
      );
    }

    if (message.message_type === 'template') {
      return (
        <div className="text-sm italic text-slate-300">
          {message.content || '[Template message]'}
        </div>
      );
    }

    return (
      <p className="text-sm text-slate-400 italic">
        {message.content || `[${message.message_type}]`}
      </p>
    );
  }

  return (
    <div className={`flex ${isOutbound ? 'justify-end' : 'justify-start'} group`}>
      <div
        className={`relative max-w-[75%] rounded-2xl px-4 py-2.5 ${
          isOutbound
            ? 'bg-emerald-600/20 border border-emerald-500/10'
            : 'bg-white/[0.05] border border-white/[0.06]'
        }`}
      >
        {isOutbound && message.sender_name && (
          <p className="text-[10px] font-medium text-emerald-400/70 mb-0.5">
            {message.sender_name}
          </p>
        )}

        <div className={isOutbound ? 'text-emerald-50' : 'text-slate-200'}>
          {renderContent()}
        </div>

        <div className={`flex items-center gap-1.5 mt-1 ${isOutbound ? 'justify-end' : 'justify-start'}`}>
          <span className="text-[10px] text-slate-500">{formatTime(message.created_at)}</span>
          {isOutbound && STATUS_ICONS[message.status]}
        </div>

        {showFeedbackButton && isOutbound && onFeedback && (
          <button
            onClick={() => onFeedback(message.id)}
            className="absolute -left-8 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 transition-opacity p-1 rounded-lg hover:bg-white/[0.06] text-slate-500 hover:text-amber-400"
            title="Dar feedback"
          >
            <MessageSquareQuote className="w-3.5 h-3.5" />
          </button>
        )}
      </div>
    </div>
  );
}
