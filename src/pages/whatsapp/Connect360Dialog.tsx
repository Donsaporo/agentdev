import { useState } from 'react';
import { Loader2, ExternalLink, Key, Hash, Phone, Building2, CheckCircle2, AlertCircle } from 'lucide-react';
import { useToast } from '../../contexts/ToastContext';
import { supabase } from '../../lib/supabase';

interface Connect360DialogProps {
  onSuccess: () => void;
}

export default function Connect360Dialog({ onSuccess }: Connect360DialogProps) {
  const toast = useToast();
  const [apiKey, setApiKey] = useState('');
  const [channelId, setChannelId] = useState('');
  const [phoneNumber, setPhoneNumber] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [wabaId, setWabaId] = useState('');
  const [step, setStep] = useState<'form' | 'validating' | 'confirmed' | 'connecting'>('form');
  const [validating, setValidating] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [validationResult, setValidationResult] = useState<Record<string, unknown> | null>(null);

  async function callConnect(payload: Record<string, string>) {
    const { data: sessionData } = await supabase.auth.getSession();
    const authToken = sessionData.session?.access_token;
    const apiUrl = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/whatsapp-connect`;

    const resp = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${authToken}`,
        'apikey': import.meta.env.VITE_SUPABASE_ANON_KEY,
      },
      body: JSON.stringify({ provider: '360dialog', ...payload }),
    });

    const result = await resp.json();
    if (!resp.ok || result.error) {
      throw new Error(result.error || 'Request failed');
    }
    return result;
  }

  async function handleValidate() {
    if (!apiKey.trim()) {
      toast.error('Ingresa tu API Key de 360dialog');
      return;
    }

    setValidating(true);
    setStep('validating');
    try {
      const result = await callConnect({ action: 'validate', api_key: apiKey.trim() });
      setValidationResult(result);
      setStep('confirmed');

      if (result.phone?.verified_name && !displayName) {
        setDisplayName(result.phone.verified_name);
      }
      if (result.phone?.phone_number && !phoneNumber) {
        setPhoneNumber(result.phone.phone_number);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Validation failed';
      toast.error(message);
      setStep('form');
    } finally {
      setValidating(false);
    }
  }

  async function handleConnect() {
    if (!apiKey.trim() || !channelId.trim()) {
      toast.error('API Key y Channel ID son requeridos');
      return;
    }

    setConnecting(true);
    setStep('connecting');
    try {
      await callConnect({
        action: 'connect',
        api_key: apiKey.trim(),
        channel_id: channelId.trim(),
        phone_number: phoneNumber.trim(),
        display_name: displayName.trim(),
        waba_id: wabaId.trim(),
      });
      toast.success('Cuenta de 360dialog conectada correctamente');
      onSuccess();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Connection failed';
      toast.error(message);
      setStep('confirmed');
    } finally {
      setConnecting(false);
    }
  }

  if (step === 'connecting') {
    return (
      <div className="glass-card p-8 flex flex-col items-center justify-center text-center">
        <div className="w-12 h-12 border-2 border-emerald-500/30 border-t-emerald-500 rounded-full animate-spin mb-4" />
        <h3 className="text-base font-semibold text-white mb-1">Conectando 360dialog</h3>
        <p className="text-sm text-slate-400">Validando API key y configurando webhook...</p>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="glass-card p-6 space-y-5">
        <div>
          <h3 className="text-base font-semibold text-white">Conectar via 360dialog</h3>
          <p className="text-sm text-slate-400 mt-1">
            Ingresa los datos de tu canal de 360dialog para conectarlo.
          </p>
        </div>

        {step === 'confirmed' && validationResult && (
          <div className="flex items-center gap-3 p-3 rounded-xl bg-emerald-500/[0.06] border border-emerald-500/20">
            <CheckCircle2 className="w-5 h-5 text-emerald-400 flex-shrink-0" />
            <div>
              <p className="text-sm font-medium text-emerald-300">API Key validada</p>
              <p className="text-xs text-slate-400 mt-0.5">Conexion verificada con 360dialog</p>
            </div>
          </div>
        )}

        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-slate-300 mb-1.5">
              <span className="flex items-center gap-1.5">
                <Key className="w-3.5 h-3.5" />
                API Key
              </span>
            </label>
            <input
              type="text"
              value={apiKey}
              onChange={e => setApiKey(e.target.value)}
              placeholder="qUcqVcHUOY..."
              className="w-full glass-input font-mono text-xs"
              disabled={step === 'confirmed'}
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-300 mb-1.5">
              <span className="flex items-center gap-1.5">
                <Hash className="w-3.5 h-3.5" />
                Channel ID
              </span>
            </label>
            <input
              type="text"
              value={channelId}
              onChange={e => setChannelId(e.target.value)}
              placeholder="rUi6fKCH"
              className="w-full glass-input font-mono"
            />
            <p className="text-xs text-slate-500 mt-1">
              Lo encuentras en tu{' '}
              <a
                href="https://hub.360dialog.com"
                target="_blank"
                rel="noopener noreferrer"
                className="text-emerald-400 hover:text-emerald-300 inline-flex items-center gap-1"
              >
                360dialog Hub <ExternalLink className="w-3 h-3" />
              </a>
            </p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-slate-300 mb-1.5">
                <span className="flex items-center gap-1.5">
                  <Phone className="w-3.5 h-3.5" />
                  Numero de telefono
                </span>
              </label>
              <input
                type="text"
                value={phoneNumber}
                onChange={e => setPhoneNumber(e.target.value)}
                placeholder="50766270927"
                className="w-full glass-input font-mono"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-300 mb-1.5">
                <span className="flex items-center gap-1.5">
                  <Building2 className="w-3.5 h-3.5" />
                  Nombre de la cuenta
                </span>
              </label>
              <input
                type="text"
                value={displayName}
                onChange={e => setDisplayName(e.target.value)}
                placeholder="Obzide Panama"
                className="w-full glass-input"
              />
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-300 mb-1.5">
              WABA ID (opcional)
            </label>
            <input
              type="text"
              value={wabaId}
              onChange={e => setWabaId(e.target.value)}
              placeholder="1863971661143495"
              className="w-full glass-input font-mono"
            />
          </div>
        </div>

        <div className="pt-2">
          {step === 'form' || step === 'validating' ? (
            <button
              onClick={handleValidate}
              disabled={validating || !apiKey.trim()}
              className="btn-primary w-full justify-center"
            >
              {validating ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Validando API Key...
                </>
              ) : (
                'Validar API Key'
              )}
            </button>
          ) : (
            <div className="flex items-center gap-3">
              <button
                onClick={() => { setStep('form'); setValidationResult(null); }}
                className="btn-ghost flex-1 justify-center"
              >
                Atras
              </button>
              <button
                onClick={handleConnect}
                disabled={connecting || !channelId.trim()}
                className="btn-primary flex-1 justify-center"
              >
                {connecting ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Conectando...
                  </>
                ) : (
                  'Conectar cuenta'
                )}
              </button>
            </div>
          )}
        </div>
      </div>

      <div className="glass-card p-5">
        <h4 className="text-sm font-medium text-slate-300 mb-3">Datos necesarios de 360dialog</h4>
        <div className="space-y-3 text-sm text-slate-400">
          <div className="flex items-start gap-3">
            <span className="w-6 h-6 rounded-full bg-emerald-500/10 text-emerald-400 flex items-center justify-center text-xs font-bold flex-shrink-0">1</span>
            <p>
              Inicia sesion en{' '}
              <a href="https://hub.360dialog.com" target="_blank" rel="noopener noreferrer" className="text-emerald-400 hover:text-emerald-300">
                360dialog Hub
              </a>
              {' '}y accede a tu canal de WhatsApp
            </p>
          </div>
          <div className="flex items-start gap-3">
            <span className="w-6 h-6 rounded-full bg-emerald-500/10 text-emerald-400 flex items-center justify-center text-xs font-bold flex-shrink-0">2</span>
            <p>Copia el <span className="text-slate-300 font-mono text-xs">API Key</span> y el <span className="text-slate-300 font-mono text-xs">Channel ID</span> desde la pagina del canal</p>
          </div>
          <div className="flex items-start gap-3">
            <span className="w-6 h-6 rounded-full bg-emerald-500/10 text-emerald-400 flex items-center justify-center text-xs font-bold flex-shrink-0">3</span>
            <p>El webhook se configurara automaticamente al conectar</p>
          </div>
        </div>
      </div>
    </div>
  );
}
