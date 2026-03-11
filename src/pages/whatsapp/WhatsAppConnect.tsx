import { useState } from 'react';
import { Loader2, ExternalLink, Key, Phone, Building2, ChevronDown, ChevronUp, CheckCircle2 } from 'lucide-react';
import { useToast } from '../../contexts/ToastContext';
import { supabase } from '../../lib/supabase';

interface WhatsAppConnectProps {
  onSuccess: () => void;
}

interface DiscoveredAccount {
  waba_id: string;
  waba_name: string;
  phone_numbers: {
    id: string;
    display_phone_number: string;
    verified_name: string;
    quality_rating: string;
  }[];
}

export default function WhatsAppConnect({ onSuccess }: WhatsAppConnectProps) {
  const toast = useToast();
  const [accessToken, setAccessToken] = useState('');
  const [step, setStep] = useState<'token' | 'select' | 'connecting'>('token');
  const [validating, setValidating] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [accounts, setAccounts] = useState<DiscoveredAccount[]>([]);
  const [selectedWaba, setSelectedWaba] = useState<string>('');
  const [selectedPhone, setSelectedPhone] = useState<string>('');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [manualWabaId, setManualWabaId] = useState('');
  const [manualPhoneId, setManualPhoneId] = useState('');

  async function handleValidateToken() {
    const token = accessToken.trim();
    if (!token) {
      toast.error('Ingresa tu Access Token');
      return;
    }

    setValidating(true);
    try {
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
        body: JSON.stringify({
          action: 'discover',
          access_token: token,
        }),
      });

      const result = await resp.json();

      if (!resp.ok || result.error) {
        throw new Error(result.error || 'Failed to validate token');
      }

      if (result.accounts && result.accounts.length > 0) {
        setAccounts(result.accounts);
        setSelectedWaba(result.accounts[0].waba_id);
        if (result.accounts[0].phone_numbers?.length > 0) {
          setSelectedPhone(result.accounts[0].phone_numbers[0].id);
        }
        setStep('select');
      } else {
        toast.warning('No se encontraron cuentas de WhatsApp Business con ese token. Usa los campos manuales abajo.');
        setShowAdvanced(true);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Token validation failed';
      toast.error(message);
    } finally {
      setValidating(false);
    }
  }

  async function handleConnect() {
    const token = accessToken.trim();
    const wabaId = selectedWaba || manualWabaId.trim();
    const phoneId = selectedPhone || manualPhoneId.trim();

    if (!token) {
      toast.error('Access Token es requerido');
      return;
    }
    if (!wabaId) {
      toast.error('Selecciona o ingresa un WABA ID');
      return;
    }

    setConnecting(true);
    setStep('connecting');

    try {
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
        body: JSON.stringify({
          action: 'connect',
          access_token: token,
          waba_id: wabaId,
          phone_number_id: phoneId || undefined,
        }),
      });

      const result = await resp.json();

      if (!resp.ok || result.error) {
        throw new Error(result.error || 'Failed to connect account');
      }

      toast.success('Cuenta de WhatsApp Business conectada correctamente');
      onSuccess();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Connection failed';
      toast.error(message);
      setStep('select');
    } finally {
      setConnecting(false);
    }
  }

  const selectedAccount = accounts.find(a => a.waba_id === selectedWaba);

  if (step === 'connecting') {
    return (
      <div className="glass-card p-8 flex flex-col items-center justify-center text-center">
        <div className="w-12 h-12 border-2 border-emerald-500/30 border-t-emerald-500 rounded-full animate-spin mb-4" />
        <h3 className="text-base font-semibold text-white mb-1">Conectando WhatsApp Business</h3>
        <p className="text-sm text-slate-400">Verificando credenciales y configurando la cuenta...</p>
      </div>
    );
  }

  if (step === 'select') {
    return (
      <div className="space-y-5">
        <div className="glass-card p-6 space-y-5">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-emerald-500/10 flex items-center justify-center">
              <CheckCircle2 className="w-5 h-5 text-emerald-400" />
            </div>
            <div>
              <h3 className="text-base font-semibold text-white">Token verificado</h3>
              <p className="text-sm text-slate-400">
                {accounts.length === 1
                  ? 'Se encontro 1 cuenta de WhatsApp Business'
                  : `Se encontraron ${accounts.length} cuentas de WhatsApp Business`
                }
              </p>
            </div>
          </div>

          <div className="space-y-3">
            <label className="block text-sm font-medium text-slate-300">Selecciona la cuenta</label>
            {accounts.map(account => (
              <button
                key={account.waba_id}
                onClick={() => {
                  setSelectedWaba(account.waba_id);
                  if (account.phone_numbers?.length > 0) {
                    setSelectedPhone(account.phone_numbers[0].id);
                  } else {
                    setSelectedPhone('');
                  }
                }}
                className={`w-full text-left p-4 rounded-xl border transition-all ${
                  selectedWaba === account.waba_id
                    ? 'border-emerald-500/40 bg-emerald-500/[0.06]'
                    : 'border-white/[0.06] bg-white/[0.02] hover:bg-white/[0.04]'
                }`}
              >
                <div className="flex items-center gap-3">
                  <Building2 className={`w-5 h-5 flex-shrink-0 ${
                    selectedWaba === account.waba_id ? 'text-emerald-400' : 'text-slate-500'
                  }`} />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold text-white truncate">{account.waba_name || 'WhatsApp Business Account'}</p>
                    <p className="text-xs text-slate-500 font-mono mt-0.5">WABA ID: {account.waba_id}</p>
                  </div>
                  {selectedWaba === account.waba_id && (
                    <CheckCircle2 className="w-5 h-5 text-emerald-400 flex-shrink-0" />
                  )}
                </div>
              </button>
            ))}
          </div>

          {selectedAccount && selectedAccount.phone_numbers.length > 0 && (
            <div className="space-y-3">
              <label className="block text-sm font-medium text-slate-300">Selecciona el numero</label>
              {selectedAccount.phone_numbers.map(phone => (
                <button
                  key={phone.id}
                  onClick={() => setSelectedPhone(phone.id)}
                  className={`w-full text-left p-3.5 rounded-xl border transition-all ${
                    selectedPhone === phone.id
                      ? 'border-emerald-500/40 bg-emerald-500/[0.06]'
                      : 'border-white/[0.06] bg-white/[0.02] hover:bg-white/[0.04]'
                  }`}
                >
                  <div className="flex items-center gap-3">
                    <Phone className={`w-4 h-4 flex-shrink-0 ${
                      selectedPhone === phone.id ? 'text-emerald-400' : 'text-slate-500'
                    }`} />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-white">{phone.display_phone_number}</p>
                      {phone.verified_name && (
                        <p className="text-xs text-slate-500 mt-0.5">{phone.verified_name}</p>
                      )}
                    </div>
                    {phone.quality_rating && phone.quality_rating !== 'unknown' && (
                      <span className={`text-xs font-medium px-2 py-0.5 rounded-md ${
                        phone.quality_rating === 'GREEN' ? 'text-emerald-400 bg-emerald-500/10' :
                        phone.quality_rating === 'YELLOW' ? 'text-amber-400 bg-amber-500/10' :
                        'text-red-400 bg-red-500/10'
                      }`}>
                        {phone.quality_rating}
                      </span>
                    )}
                    {selectedPhone === phone.id && (
                      <CheckCircle2 className="w-4 h-4 text-emerald-400 flex-shrink-0" />
                    )}
                  </div>
                </button>
              ))}
            </div>
          )}

          <div className="flex items-center gap-3 pt-2">
            <button
              onClick={() => { setStep('token'); setAccounts([]); }}
              className="btn-ghost flex-1 justify-center"
            >
              Atras
            </button>
            <button
              onClick={handleConnect}
              disabled={connecting || !selectedWaba}
              className="btn-primary flex-1 justify-center"
            >
              Conectar cuenta
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="glass-card p-6 space-y-5">
        <div>
          <h3 className="text-base font-semibold text-white">Conectar cuenta existente</h3>
          <p className="text-sm text-slate-400 mt-1">
            Ingresa el Access Token de tu WhatsApp Business Account para conectarlo con la app.
          </p>
        </div>

        <div>
          <label className="block text-sm font-medium text-slate-300 mb-1.5">
            <span className="flex items-center gap-1.5">
              <Key className="w-3.5 h-3.5" />
              Access Token
            </span>
          </label>
          <textarea
            value={accessToken}
            onChange={e => setAccessToken(e.target.value)}
            placeholder="EAAxxxxxxx..."
            rows={3}
            className="w-full glass-input font-mono text-xs resize-none"
          />
          <p className="text-xs text-slate-500 mt-1.5">
            Genera un token permanente desde{' '}
            <a
              href="https://business.facebook.com/settings/system-users"
              target="_blank"
              rel="noopener noreferrer"
              className="text-emerald-400 hover:text-emerald-300 inline-flex items-center gap-1"
            >
              Meta Business Suite &gt; System Users <ExternalLink className="w-3 h-3" />
            </a>
            {' '}con permisos de <span className="text-slate-300">whatsapp_business_management</span> y <span className="text-slate-300">whatsapp_business_messaging</span>.
          </p>
        </div>

        <button
          onClick={() => setShowAdvanced(!showAdvanced)}
          className="flex items-center gap-1.5 text-xs text-slate-500 hover:text-slate-300 transition-colors"
        >
          {showAdvanced ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
          Configuracion manual (opcional)
        </button>

        {showAdvanced && (
          <div className="space-y-4 p-4 rounded-xl bg-white/[0.02] border border-white/[0.04]">
            <p className="text-xs text-slate-500">
              Si conoces los IDs de tu cuenta, puedes ingresarlos directamente. Si no, los descubriremos automaticamente del token.
            </p>
            <div>
              <label className="block text-sm font-medium text-slate-300 mb-1.5">WABA ID</label>
              <input
                type="text"
                value={manualWabaId}
                onChange={e => setManualWabaId(e.target.value)}
                placeholder="123456789012345"
                className="w-full glass-input font-mono"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-300 mb-1.5">Phone Number ID</label>
              <input
                type="text"
                value={manualPhoneId}
                onChange={e => setManualPhoneId(e.target.value)}
                placeholder="123456789012345"
                className="w-full glass-input font-mono"
              />
            </div>
          </div>
        )}

        <div className="pt-2">
          {manualWabaId.trim() ? (
            <button
              onClick={handleConnect}
              disabled={connecting || !accessToken.trim()}
              className="btn-primary w-full justify-center"
            >
              {connecting ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Conectando...
                </>
              ) : (
                'Conectar directamente'
              )}
            </button>
          ) : (
            <button
              onClick={handleValidateToken}
              disabled={validating || !accessToken.trim()}
              className="btn-primary w-full justify-center"
            >
              {validating ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Verificando token...
                </>
              ) : (
                'Verificar y buscar cuentas'
              )}
            </button>
          )}
        </div>
      </div>

      <div className="glass-card p-5">
        <h4 className="text-sm font-medium text-slate-300 mb-3">Como obtener el Access Token</h4>
        <div className="space-y-3 text-sm text-slate-400">
          <div className="flex items-start gap-3">
            <span className="w-6 h-6 rounded-full bg-emerald-500/10 text-emerald-400 flex items-center justify-center text-xs font-bold flex-shrink-0">1</span>
            <p>
              Ve a{' '}
              <a href="https://business.facebook.com/settings" target="_blank" rel="noopener noreferrer" className="text-emerald-400 hover:text-emerald-300">
                Meta Business Suite
              </a>
              {' '}&gt; Configuracion &gt; Usuarios del sistema
            </p>
          </div>
          <div className="flex items-start gap-3">
            <span className="w-6 h-6 rounded-full bg-emerald-500/10 text-emerald-400 flex items-center justify-center text-xs font-bold flex-shrink-0">2</span>
            <p>Crea un usuario del sistema (o usa uno existente) con rol de Administrador</p>
          </div>
          <div className="flex items-start gap-3">
            <span className="w-6 h-6 rounded-full bg-emerald-500/10 text-emerald-400 flex items-center justify-center text-xs font-bold flex-shrink-0">3</span>
            <p>Asigna el activo de WhatsApp Business Account al usuario del sistema</p>
          </div>
          <div className="flex items-start gap-3">
            <span className="w-6 h-6 rounded-full bg-emerald-500/10 text-emerald-400 flex items-center justify-center text-xs font-bold flex-shrink-0">4</span>
            <p>Genera un token permanente con los permisos <span className="text-slate-300 font-mono text-xs">whatsapp_business_management</span> y <span className="text-slate-300 font-mono text-xs">whatsapp_business_messaging</span></p>
          </div>
        </div>
      </div>
    </div>
  );
}
