import { Check, CheckCheck, Clock, AlertCircle, MessageSquareQuote, Download, Play, FileText, MapPin } from 'lucide-react';
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

function MediaRenderer({ message }: { message: WhatsAppMessage }) {
  const mediaUrl = message.media_local_path || message.media_url;
  const isPending = message.media_download_status === 'pending';
  const isFailed = message.media_download_status === 'failed';

  if (isPending) {
    return (
      <div className="flex items-center gap-2 px-3 py-2 bg-white/[0.04] rounded-lg text-xs text-slate-500">
        <Clock className="w-3.5 h-3.5 animate-pulse" />
        <span>Descargando...</span>
      </div>
    );
  }

  if (isFailed || !mediaUrl) {
    return (
      <div className="flex items-center gap-2 px-3 py-2 bg-red-500/10 rounded-lg text-xs text-red-400">
        <AlertCircle className="w-3.5 h-3.5" />
        <span>Error al cargar archivo</span>
      </div>
    );
  }

  switch (message.message_type) {
    case 'image':
      return (
        <div className="relative group/media mb-1">
          <img
            src={mediaUrl}
            alt={message.content || 'Imagen'}
            className="max-w-[260px] rounded-lg cursor-pointer hover:opacity-90 transition-opacity"
            loading="lazy"
            onClick={() => window.open(mediaUrl, '_blank')}
          />
          <a
            href={mediaUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="absolute top-2 right-2 p-1.5 bg-black/60 rounded-full text-white opacity-0 group-hover/media:opacity-100 transition-opacity"
          >
            <Download className="w-3 h-3" />
          </a>
        </div>
      );

    case 'video':
      return (
        <div className="max-w-[260px] mb-1">
          <video
            src={mediaUrl}
            controls
            preload="metadata"
            className="rounded-lg w-full"
          />
        </div>
      );

    case 'audio':
      return (
        <div className="flex items-center gap-2.5 min-w-[200px] mb-1">
          <div className="flex-shrink-0 w-7 h-7 bg-emerald-500/20 rounded-full flex items-center justify-center">
            <Play className="w-3.5 h-3.5 text-emerald-400 ml-0.5" />
          </div>
          <audio src={mediaUrl} controls preload="metadata" className="flex-1 h-8 [&::-webkit-media-controls-panel]:bg-transparent" />
        </div>
      );

    case 'document': {
      const fileName = message.content || 'Documento';
      const fileSize = message.media_file_size
        ? message.media_file_size > 1024 * 1024
          ? `${(message.media_file_size / (1024 * 1024)).toFixed(1)} MB`
          : `${Math.round(message.media_file_size / 1024)} KB`
        : '';

      return (
        <a
          href={mediaUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-2.5 px-3 py-2 bg-white/[0.04] rounded-lg hover:bg-white/[0.08] transition-colors mb-1"
        >
          <FileText className="w-7 h-7 text-sky-400 flex-shrink-0" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium truncate">{fileName}</p>
            <p className="text-[10px] text-slate-500">{fileSize || message.media_mime_type}</p>
          </div>
          <Download className="w-3.5 h-3.5 text-slate-500 flex-shrink-0" />
        </a>
      );
    }

    default:
      return null;
  }
}

export default function MessageBubble({ message, onFeedback, showFeedbackButton }: Props) {
  const isOutbound = message.direction === 'outbound';
  const hasMedia = ['image', 'video', 'audio', 'document'].includes(message.message_type);
  const isLocation = message.message_type === 'location';

  function formatTime(dateStr: string) {
    try {
      const d = new Date(dateStr);
      return d.toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' });
    } catch {
      return '';
    }
  }

  function renderContent() {
    if (hasMedia) {
      return (
        <>
          <MediaRenderer message={message} />
          {message.content && !message.content.startsWith('[') && (
            <p className="text-sm leading-relaxed whitespace-pre-wrap break-words">{message.content}</p>
          )}
        </>
      );
    }

    if (isLocation) {
      const parts = message.content.split(',').map(Number);
      const lat = parts[0];
      const lon = parts[1];
      const mapUrl = !isNaN(lat) && !isNaN(lon) ? `https://www.google.com/maps?q=${lat},${lon}` : '#';
      return (
        <a href={mapUrl} target="_blank" rel="noopener noreferrer" className="flex items-center gap-2 text-sm text-sky-400 hover:text-sky-300">
          <MapPin className="w-4 h-4" />
          <span>Ver ubicacion</span>
        </a>
      );
    }

    if (message.message_type === 'template') {
      return (
        <div className="text-sm italic text-slate-400">
          {message.content || '[Mensaje de plantilla]'}
        </div>
      );
    }

    if (message.message_type === 'text' || !message.message_type) {
      return <p className="text-sm leading-relaxed whitespace-pre-wrap break-words">{message.content}</p>;
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
