import { useState } from 'react';
import { Phone, Trash2, CheckCircle2, AlertCircle, Clock, Loader2, Signal, Send, MessageSquare, PhoneCall } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import type { WhatsAppBusinessAccount } from '../../lib/types';

interface WhatsAppAccountCardProps {
  account: WhatsAppBusinessAccount;
  onDelete: (id: string) => void;
  deleting: boolean;
}

const qualityColors: Record<string, string> = {
  GREEN: 'text-emerald-400 bg-emerald-500/10',
  YELLOW: 'text-amber-400 bg-amber-500/10',
  RED: 'text-red-400 bg-red-500/10',
  unknown: 'text-slate-400 bg-white/[0.04]',
};

const statusConfig: Record<string, { icon: typeof CheckCircle2; color: string; bg: string }> = {
  connected: { icon: CheckCircle2, color: 'text-emerald-400', bg: 'bg-emerald-500/10' },
  disconnected: { icon: AlertCircle, color: 'text-slate-400', bg: 'bg-white/[0.04]' },
  error: { icon: AlertCircle, color: 'text-red-400', bg: 'bg-red-500/10' },
  pending: { icon: Clock, color: 'text-amber-400', bg: 'bg-amber-500/10' },
};

export default function WhatsAppAccountCard({ account, onDelete, deleting }: WhatsAppAccountCardProps) {
  const status = statusConfig[account.status] || statusConfig.pending;
  const StatusIcon = status.icon;
  const quality = qualityColors[account.quality_rating] || qualityColors.unknown;

  const [showSend, setShowSend] = useState(false);
  const [sendTo, setSendTo] = useState('');
  const [sendMsg, setSendMsg] = useState('');
  const [sending, setSending] = useState(false);
  const [sendResult, setSendResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [registering, setRegistering] = useState(false);
  const [registered, setRegistered] = useState(false);

  async function handleRegister() {
    setRegistering(true);
    setSendResult(null);
    try {
      const apiUrl = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/whatsapp-send-message`;
      const res = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${import.meta.env.VITE_SUPABASE_ANON_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ action: 'register', account_id: account.id }),
      });
      const data = await res.json();
      if (!res.ok || data.error) {
        setSendResult({ ok: false, text: data.error || 'Registration failed' });
      } else {
        setSendResult({ ok: true, text: 'Phone number registered with Cloud API' });
        setRegistered(true);
      }
    } catch (err) {
      setSendResult({ ok: false, text: err instanceof Error ? err.message : 'Network error' });
    } finally {
      setRegistering(false);
    }
  }

  async function handleSend(type: 'text' | 'template') {
    if (!sendTo.trim()) return;
    if (type === 'text' && !sendMsg.trim()) return;

    setSending(true);
    setSendResult(null);

    try {
      const apiUrl = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/whatsapp-send-message`;
      const payload: Record<string, string> = {
        account_id: account.id,
        to: sendTo.trim(),
        type,
      };
      if (type === 'text') payload.message = sendMsg.trim();
      if (type === 'template') {
        payload.template_name = 'hello_world';
        payload.language_code = 'en_US';
      }

      const res = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${import.meta.env.VITE_SUPABASE_ANON_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      const data = await res.json();
      if (!res.ok || data.error) {
        setSendResult({ ok: false, text: data.error || 'Error sending message' });
      } else {
        setSendResult({ ok: true, text: `Sent! ID: ${data.message_id}` });
        setSendMsg('');
      }
    } catch (err) {
      setSendResult({ ok: false, text: err instanceof Error ? err.message : 'Network error' });
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="glass-card-hover p-5">
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-start gap-4 min-w-0">
          <div className={`w-12 h-12 rounded-xl ${status.bg} flex items-center justify-center flex-shrink-0`}>
            <Phone className={`w-6 h-6 ${status.color}`} />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2.5">
              <h3 className="text-base font-semibold text-white truncate">
                {account.display_phone_number || 'Pending number'}
              </h3>
              <StatusIcon className={`w-4 h-4 ${status.color} flex-shrink-0`} />
            </div>
            {account.verified_name && (
              <p className="text-sm text-slate-400 mt-0.5 truncate">{account.verified_name}</p>
            )}
            <div className="flex items-center gap-3 mt-2 flex-wrap">
              {account.quality_rating !== 'unknown' && (
                <span className={`inline-flex items-center gap-1.5 text-xs font-medium px-2 py-0.5 rounded-md ${quality}`}>
                  <Signal className="w-3 h-3" />
                  Quality: {account.quality_rating}
                </span>
              )}
              <span className="text-xs text-slate-500">
                WABA: <span className="font-mono text-slate-400">{account.waba_id || '---'}</span>
              </span>
              <span className="text-xs text-slate-500">
                Phone ID: <span className="font-mono text-slate-400">{account.phone_number_id || '---'}</span>
              </span>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2 flex-shrink-0">
          {account.status === 'connected' && (
            <button
              onClick={() => { setShowSend(!showSend); setSendResult(null); }}
              className={`p-2 rounded-lg transition-all ${
                showSend
                  ? 'text-emerald-400 bg-emerald-500/10'
                  : 'text-slate-500 hover:text-emerald-400 hover:bg-emerald-500/10'
              }`}
              title="Send test message"
            >
              <MessageSquare className="w-4 h-4" />
            </button>
          )}
          <button
            onClick={() => onDelete(account.id)}
            disabled={deleting}
            className="p-2 rounded-lg text-slate-500 hover:text-red-400 hover:bg-red-500/10 transition-all disabled:opacity-50"
            title="Remove account"
          >
            {deleting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
          </button>
        </div>
      </div>

      {showSend && (
        <div className="mt-4 p-4 rounded-xl bg-white/[0.03] border border-white/[0.06] space-y-3 animate-fade-in">
          {!registered && (
            <div className="flex items-center justify-between gap-3 p-3 rounded-lg bg-amber-500/5 border border-amber-500/10">
              <div className="text-xs text-amber-300/80">
                Si recibes error "Account not registered", registra el numero primero:
              </div>
              <button
                onClick={handleRegister}
                disabled={registering}
                className="flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg bg-amber-500/10 text-amber-400 hover:bg-amber-500/20 transition-colors disabled:opacity-50 flex-shrink-0"
              >
                {registering ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <PhoneCall className="w-3.5 h-3.5" />}
                Registrar
              </button>
            </div>
          )}
          <div className="flex items-center gap-2 text-sm font-medium text-slate-300">
            <Send className="w-3.5 h-3.5 text-emerald-400" />
            Enviar mensaje de prueba
          </div>
          <input
            type="text"
            placeholder="Numero destino (ej: 50766270927)"
            value={sendTo}
            onChange={e => setSendTo(e.target.value)}
            className="w-full px-3 py-2 rounded-lg bg-white/[0.04] border border-white/[0.08] text-sm text-white placeholder-slate-500 focus:outline-none focus:border-emerald-500/40 transition-colors"
          />
          <textarea
            placeholder="Mensaje de texto..."
            value={sendMsg}
            onChange={e => setSendMsg(e.target.value)}
            rows={2}
            className="w-full px-3 py-2 rounded-lg bg-white/[0.04] border border-white/[0.08] text-sm text-white placeholder-slate-500 focus:outline-none focus:border-emerald-500/40 transition-colors resize-none"
          />
          <div className="flex items-center gap-2">
            <button
              onClick={() => handleSend('text')}
              disabled={sending || !sendTo.trim() || !sendMsg.trim()}
              className="btn-primary text-xs px-3 py-1.5 disabled:opacity-40"
            >
              {sending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
              Enviar texto
            </button>
            <button
              onClick={() => handleSend('template')}
              disabled={sending || !sendTo.trim()}
              className="btn-ghost text-xs px-3 py-1.5 disabled:opacity-40"
            >
              Enviar template hello_world
            </button>
          </div>
          {sendResult && (
            <div className={`text-xs px-3 py-2 rounded-lg ${
              sendResult.ok
                ? 'bg-emerald-500/10 text-emerald-400'
                : 'bg-red-500/10 text-red-400'
            }`}>
              {sendResult.text}
            </div>
          )}
        </div>
      )}

      {account.status_message && (
        <div className="mt-3 text-xs text-slate-500 bg-white/[0.02] px-3 py-2 rounded-lg">
          {account.status_message}
        </div>
      )}

      <div className="mt-3 pt-3 border-t border-white/[0.04] flex items-center justify-between">
        <span className="text-xs text-slate-500">
          {account.connected_at
            ? `Connected ${formatDistanceToNow(new Date(account.connected_at), { addSuffix: true })}`
            : 'Not yet connected'
          }
        </span>
        <span className="text-xs text-slate-600 font-mono">
          App: {account.meta_app_id}
        </span>
      </div>
    </div>
  );
}
