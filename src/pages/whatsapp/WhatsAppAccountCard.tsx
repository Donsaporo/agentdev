import { useState } from 'react';
import { Phone, Trash2, CheckCircle2, AlertCircle, Clock, Loader2, Signal, Send, MessageSquare, PhoneCall, ShieldCheck, Info, RefreshCw, Zap } from 'lucide-react';
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
  const is360 = account.provider === '360dialog';

  const [showSend, setShowSend] = useState(false);
  const [sendTo, setSendTo] = useState('');
  const [sendMsg, setSendMsg] = useState('');
  const [sending, setSending] = useState(false);
  const [sendResult, setSendResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [registering, setRegistering] = useState(false);
  const [registered, setRegistered] = useState(is360);
  const [phoneStatus, setPhoneStatus] = useState<Record<string, unknown> | null>(null);
  const [verifyStep, setVerifyStep] = useState<'idle' | 'code_sent' | 'verified'>('idle');
  const [verifyCode, setVerifyCode] = useState('');
  const [verifyLoading, setVerifyLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const apiUrl = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/whatsapp-send-message`;
  const apiHeaders = {
    Authorization: `Bearer ${import.meta.env.VITE_SUPABASE_ANON_KEY}`,
    'Content-Type': 'application/json',
  };

  async function callAction(payload: Record<string, string>) {
    const res = await fetch(apiUrl, {
      method: 'POST',
      headers: apiHeaders,
      body: JSON.stringify({ account_id: account.id, ...payload }),
    });
    const data = await res.json();
    if (!res.ok || data.error) {
      throw new Error(data.error || 'Request failed');
    }
    return data;
  }

  async function handleCheckStatus() {
    setRegistering(true);
    setSendResult(null);
    try {
      const data = await callAction({ action: 'check_status' });
      setPhoneStatus(data.phone_status);
      const codeStatus = data.phone_status?.code_verification_status;
      if (codeStatus === 'VERIFIED') {
        setRegistered(true);
        setSendResult({ ok: true, text: 'Numero verificado y listo para enviar mensajes' });
      } else {
        setSendResult({ ok: false, text: `Estado: ${codeStatus || 'NOT_VERIFIED'} - Necesita verificacion` });
      }
    } catch (err) {
      setSendResult({ ok: false, text: err instanceof Error ? err.message : 'Error' });
    } finally {
      setRegistering(false);
    }
  }

  async function handleRequestCode(method: string) {
    setVerifyLoading(true);
    setSendResult(null);
    try {
      await callAction({ action: 'request_code', code_method: method, language: 'es' });
      setVerifyStep('code_sent');
      setSendResult({ ok: true, text: `Codigo de verificacion enviado por ${method}` });
    } catch (err) {
      setSendResult({ ok: false, text: err instanceof Error ? err.message : 'Error' });
    } finally {
      setVerifyLoading(false);
    }
  }

  async function handleVerifyCode() {
    if (!verifyCode.trim()) return;
    setVerifyLoading(true);
    setSendResult(null);
    try {
      await callAction({ action: 'verify_code', code: verifyCode.trim() });
      setVerifyStep('verified');
      setRegistered(true);
      setSendResult({ ok: true, text: 'Numero verificado y registrado correctamente' });
    } catch (err) {
      setSendResult({ ok: false, text: err instanceof Error ? err.message : 'Error' });
    } finally {
      setVerifyLoading(false);
    }
  }

  async function handleRefreshToken() {
    setRefreshing(true);
    setSendResult(null);
    try {
      const data = await callAction({ action: 'refresh_token' });
      setSendResult({
        ok: true,
        text: data.expires_in_days
          ? `Token renovado - expira en ${data.expires_in_days} dias`
          : data.message || 'Token renovado exitosamente',
      });
    } catch (err) {
      setSendResult({ ok: false, text: err instanceof Error ? err.message : 'Error' });
    } finally {
      setRefreshing(false);
    }
  }

  async function handleSend(type: 'text' | 'template') {
    if (!sendTo.trim()) return;
    if (type === 'text' && !sendMsg.trim()) return;

    setSending(true);
    setSendResult(null);

    try {
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
        headers: apiHeaders,
        body: JSON.stringify(payload),
      });

      const data = await res.json();
      if (!res.ok || data.error) {
        setSendResult({ ok: false, text: data.error || 'Error sending message' });
      } else {
        setSendResult({ ok: true, text: `Enviado! ID: ${data.message_id}` });
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
              {is360 && (
                <span className="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-sky-500/10 text-sky-400 flex-shrink-0">
                  <Zap className="w-2.5 h-2.5" />
                  360dialog
                </span>
              )}
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
              {is360 && account.channel_id && (
                <span className="text-xs text-slate-500">
                  Channel: <span className="font-mono text-slate-400">{account.channel_id}</span>
                </span>
              )}
              {!is360 && (
                <span className="text-xs text-slate-500">
                  Phone ID: <span className="font-mono text-slate-400">{account.phone_number_id || '---'}</span>
                </span>
              )}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2 flex-shrink-0">
          {account.status === 'connected' && !is360 && (
            <button
              onClick={handleRefreshToken}
              disabled={refreshing}
              className="p-2 rounded-lg text-slate-500 hover:text-sky-400 hover:bg-sky-500/10 transition-all disabled:opacity-50"
              title="Renovar token de acceso"
            >
              {refreshing ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
            </button>
          )}
          {account.status === 'connected' && (
            <button
              onClick={() => { setShowSend(!showSend); setSendResult(null); }}
              className={`p-2 rounded-lg transition-all ${
                showSend
                  ? 'text-emerald-400 bg-emerald-500/10'
                  : 'text-slate-500 hover:text-emerald-400 hover:bg-emerald-500/10'
              }`}
              title="Enviar mensaje de prueba"
            >
              <MessageSquare className="w-4 h-4" />
            </button>
          )}
          <button
            onClick={() => onDelete(account.id)}
            disabled={deleting}
            className="p-2 rounded-lg text-slate-500 hover:text-red-400 hover:bg-red-500/10 transition-all disabled:opacity-50"
            title="Eliminar cuenta"
          >
            {deleting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
          </button>
        </div>
      </div>

      {!showSend && sendResult && (
        <div className={`mt-3 text-xs px-3 py-2 rounded-lg ${
          sendResult.ok ? 'bg-emerald-500/10 text-emerald-400' : 'bg-red-500/10 text-red-400'
        }`}>
          {sendResult.text}
        </div>
      )}

      {showSend && (
        <div className="mt-4 p-4 rounded-xl bg-white/[0.03] border border-white/[0.06] space-y-3 animate-fade-in">
          {!registered && !is360 && (
            <div className="space-y-2.5 p-3 rounded-lg bg-amber-500/5 border border-amber-500/10">
              <div className="flex items-center gap-2 text-xs font-medium text-amber-300">
                <PhoneCall className="w-3.5 h-3.5" />
                Verificacion de numero
              </div>

              {verifyStep === 'idle' && (
                <div className="space-y-2">
                  <p className="text-xs text-amber-300/70">
                    El numero debe verificarse antes de enviar mensajes. Solicita un codigo por SMS o llamada.
                  </p>
                  <div className="flex items-center gap-2 flex-wrap">
                    <button
                      onClick={() => handleRequestCode('SMS')}
                      disabled={verifyLoading}
                      className="flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20 transition-colors disabled:opacity-50"
                    >
                      {verifyLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
                      Verificar por SMS
                    </button>
                    <button
                      onClick={() => handleRequestCode('VOICE')}
                      disabled={verifyLoading}
                      className="flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg bg-sky-500/10 text-sky-400 hover:bg-sky-500/20 transition-colors disabled:opacity-50"
                    >
                      {verifyLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <PhoneCall className="w-3.5 h-3.5" />}
                      Verificar por llamada
                    </button>
                    <button
                      onClick={handleCheckStatus}
                      disabled={registering}
                      className="flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg bg-white/[0.04] text-slate-300 hover:bg-white/[0.08] transition-colors disabled:opacity-50"
                    >
                      {registering ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Info className="w-3.5 h-3.5" />}
                      Ver estado
                    </button>
                  </div>
                  {phoneStatus && (
                    <div className="text-xs font-mono text-slate-400 bg-white/[0.02] p-2 rounded-lg max-h-32 overflow-auto">
                      {JSON.stringify(phoneStatus, null, 2)}
                    </div>
                  )}
                </div>
              )}

              {verifyStep === 'code_sent' && (
                <div className="space-y-2">
                  <p className="text-xs text-amber-300/70">
                    Ingresa el codigo de verificacion que recibiste:
                  </p>
                  <div className="flex items-center gap-2">
                    <input
                      type="text"
                      placeholder="Codigo de 6 digitos"
                      value={verifyCode}
                      onChange={e => setVerifyCode(e.target.value)}
                      maxLength={6}
                      className="w-40 px-3 py-1.5 rounded-lg bg-white/[0.04] border border-white/[0.08] text-sm text-white placeholder-slate-500 focus:outline-none focus:border-emerald-500/40 transition-colors font-mono tracking-widest"
                    />
                    <button
                      onClick={handleVerifyCode}
                      disabled={verifyLoading || !verifyCode.trim()}
                      className="flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20 transition-colors disabled:opacity-50"
                    >
                      {verifyLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ShieldCheck className="w-3.5 h-3.5" />}
                      Verificar
                    </button>
                    <button
                      onClick={() => { setVerifyStep('idle'); setVerifyCode(''); }}
                      className="text-xs text-slate-500 hover:text-slate-300 transition-colors"
                    >
                      Cancelar
                    </button>
                  </div>
                </div>
              )}
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
            ? `Conectado ${formatDistanceToNow(new Date(account.connected_at), { addSuffix: true })}`
            : 'Sin conectar'
          }
        </span>
        <span className="text-xs text-slate-600 font-mono">
          {is360 ? `Channel: ${account.channel_id}` : `App: ${account.meta_app_id}`}
        </span>
      </div>
    </div>
  );
}
