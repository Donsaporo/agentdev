import { useState, useEffect, useCallback, useRef } from 'react';
import { Loader2, ExternalLink, AlertCircle } from 'lucide-react';
import { useToast } from '../../contexts/ToastContext';
import { supabase } from '../../lib/supabase';

declare global {
  interface Window {
    FB: {
      init: (params: Record<string, unknown>) => void;
      login: (
        callback: (response: FBLoginResponse) => void,
        params: Record<string, unknown>
      ) => void;
    };
    fbAsyncInit: () => void;
  }
}

interface FBLoginResponse {
  authResponse?: {
    code?: string;
    accessToken?: string;
    userID?: string;
  };
  status: string;
}

interface SessionData {
  waba_id?: string;
  phone_number_id?: string;
}

interface EmbeddedSignupProps {
  onSuccess: () => void;
}

const META_APP_ID = '1393977296081412';
const META_CONFIG_ID = '1576966270086532';
const FB_SDK_VERSION = 'v25.0';

export default function EmbeddedSignup({ onSuccess }: EmbeddedSignupProps) {
  const toast = useToast();
  const [sdkLoaded, setSdkLoaded] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [statusText, setStatusText] = useState('');
  const sessionRef = useRef<SessionData>({});

  const loadFBSDK = useCallback(() => {
    if (window.FB) {
      window.FB.init({
        appId: META_APP_ID,
        autoLogAppEvents: true,
        xfbml: true,
        version: FB_SDK_VERSION,
      });
      setSdkLoaded(true);
      return;
    }

    window.fbAsyncInit = () => {
      window.FB.init({
        appId: META_APP_ID,
        autoLogAppEvents: true,
        xfbml: true,
        version: FB_SDK_VERSION,
      });
      setSdkLoaded(true);
    };

    if (!document.getElementById('facebook-jssdk')) {
      const script = document.createElement('script');
      script.id = 'facebook-jssdk';
      script.src = 'https://connect.facebook.net/en_US/sdk.js';
      script.async = true;
      script.defer = true;
      script.crossOrigin = 'anonymous';
      document.body.appendChild(script);
    }
  }, []);

  useEffect(() => {
    loadFBSDK();

    function handleMessage(event: MessageEvent) {
      if (event.origin !== 'https://www.facebook.com' && event.origin !== 'https://web.facebook.com') return;

      try {
        const data = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
        if (data.type === 'WA_EMBEDDED_SIGNUP') {
          if (data.event === 'FINISH') {
            const { phone_number_id, waba_id } = data.data;
            sessionRef.current = { waba_id, phone_number_id };
          } else if (data.event === 'CANCEL') {
            setConnecting(false);
            toast.warning('Flujo cancelado en paso: ' + (data.data?.current_step || 'desconocido'));
          } else if (data.event === 'ERROR') {
            setConnecting(false);
            toast.error('Error en Embedded Signup: ' + (data.data?.error_message || 'Error desconocido'));
          }
        }
      } catch {
        // non-JSON message
      }
    }

    window.addEventListener('message', handleMessage);
    return () => {
      window.removeEventListener('message', handleMessage);
    };
  }, [loadFBSDK, toast]);

  function launchSignup() {
    if (!window.FB) {
      toast.error('Facebook SDK aun no esta cargado. Espera un momento.');
      return;
    }

    setConnecting(true);
    setStatusText('Esperando autorizacion...');
    sessionRef.current = {};

    window.FB.login(
      (response: FBLoginResponse) => {
        if (response.authResponse?.code) {
          exchangeCode(response.authResponse.code);
        } else {
          setConnecting(false);
          setStatusText('');
          if (response.status === 'not_authorized') {
            toast.error('Necesitas autorizar la app para continuar');
          }
        }
      },
      {
        config_id: META_CONFIG_ID,
        response_type: 'code',
        override_default_response_type: true,
        extras: {
          version: 'v3',
        },
      }
    );
  }

  async function exchangeCode(code: string) {
    setStatusText('Intercambiando token...');

    try {
      const { data: authData } = await supabase.auth.getSession();
      const token = authData.session?.access_token;

      const apiUrl = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/whatsapp-embedded-signup`;

      const resp = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
          'apikey': import.meta.env.VITE_SUPABASE_ANON_KEY,
        },
        body: JSON.stringify({
          code,
          app_id: META_APP_ID,
          configuration_id: META_CONFIG_ID,
          waba_id: sessionRef.current.waba_id || '',
          phone_number_id: sessionRef.current.phone_number_id || '',
        }),
      });

      const result = await resp.json();

      if (!resp.ok || result.error) {
        throw new Error(result.error || 'Fallo al completar el signup');
      }

      toast.success('Cuenta de WhatsApp Business conectada correctamente');
      onSuccess();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Conexion fallida';
      toast.error(message);
    } finally {
      setConnecting(false);
      setStatusText('');
    }
  }

  return (
    <div className="space-y-5">
      <div className="glass-card p-6">
        <div className="mb-5">
          <h3 className="text-base font-semibold text-white">Embedded Signup de Meta</h3>
          <p className="text-sm text-slate-400 mt-1">
            Conecta tu cuenta de WhatsApp Business existente a traves del flujo de Meta.
            Podras seleccionar tu cuenta y numero ya verificados, o escanear el QR desde WhatsApp Business para migrar tu numero.
          </p>
        </div>

        <div className="bg-white/[0.02] rounded-xl border border-white/[0.06] p-4 mb-5">
          <div className="flex items-center gap-3 text-sm">
            <div className="w-8 h-8 rounded-lg bg-sky-500/10 flex items-center justify-center flex-shrink-0">
              <svg viewBox="0 0 24 24" className="w-4 h-4 text-sky-400" fill="currentColor">
                <path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z"/>
              </svg>
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-slate-300 font-medium">Meta App <span className="font-mono text-xs text-slate-500">{META_APP_ID}</span></p>
              <p className="text-xs text-slate-500">Config: {META_CONFIG_ID}</p>
            </div>
            <div className={`w-2 h-2 rounded-full flex-shrink-0 ${sdkLoaded ? 'bg-emerald-400' : 'bg-amber-400 animate-pulse'}`} />
          </div>
        </div>

        {connecting ? (
          <div className="flex flex-col items-center py-6">
            <div className="w-10 h-10 border-2 border-emerald-500/30 border-t-emerald-500 rounded-full animate-spin mb-3" />
            <p className="text-sm text-slate-300 font-medium">{statusText || 'Conectando...'}</p>
            <p className="text-xs text-slate-500 mt-1">No cierres esta ventana</p>
          </div>
        ) : (
          <button
            onClick={launchSignup}
            disabled={!sdkLoaded}
            className="w-full flex items-center justify-center gap-3 bg-[#1877F2] hover:bg-[#166FE5] disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-semibold rounded-xl px-5 py-3.5 transition-all active:scale-[0.98] shadow-lg shadow-[#1877F2]/20"
          >
            <svg viewBox="0 0 175.216 175.552" className="w-5 h-5" fill="currentColor">
              <path d="M87.184 0C39.04 0 0 39.04 0 87.184c0 16.368 4.528 31.68 12.4 44.784L0 175.552l45.024-11.808c12.592 6.864 27.008 10.768 42.16 10.768 48.144 0 87.184-39.04 87.184-87.184S135.328 0 87.184 0zm0 159.072c-14.336 0-27.632-4.16-38.912-11.328l-2.784-1.664-28.928 7.584 7.712-28.192-1.824-2.912c-7.92-12.592-12.096-27.136-12.096-42.368 0-39.648 32.256-71.904 71.904-71.904s71.904 32.256 71.904 71.904-32.384 71.904-72.032 71.904z" fill="white"/>
              <path d="M126.848 105.312c-2.176-1.088-12.864-6.352-14.864-7.072-2-0.72-3.456-1.088-4.912 1.088-1.456 2.176-5.632 7.072-6.912 8.528-1.264 1.456-2.544 1.632-4.72 0.544-2.176-1.088-9.184-3.392-17.488-10.8-6.464-5.76-10.832-12.88-12.096-15.056-1.264-2.176-0.128-3.344 0.96-4.432 0.976-0.976 2.176-2.544 3.264-3.808 1.088-1.264 1.456-2.176 2.176-3.632 0.72-1.456 0.352-2.72-0.176-3.808-0.544-1.088-4.912-11.84-6.736-16.192-1.776-4.256-3.584-3.68-4.912-3.744-1.264-0.064-2.72-0.08-4.176-0.08-1.456 0-3.808 0.544-5.808 2.72-2 2.176-7.616 7.44-7.616 18.144 0 10.704 7.808 21.04 8.896 22.496 1.088 1.456 15.36 23.44 37.216 32.864 5.2 2.24 9.264 3.584 12.432 4.592 5.232 1.664 9.984 1.424 13.744 0.864 4.192-0.624 12.864-5.264 14.688-10.336 1.824-5.072 1.824-9.408 1.264-10.336-0.528-0.896-1.984-1.456-4.16-2.544z" fill="white"/>
            </svg>
            Login with Facebook
          </button>
        )}

        {!sdkLoaded && (
          <div className="flex items-center gap-2 mt-3 text-xs text-amber-400">
            <Loader2 className="w-3 h-3 animate-spin" />
            Cargando Facebook SDK...
          </div>
        )}
      </div>

      <div className="glass-card p-5">
        <h4 className="text-sm font-medium text-slate-300 mb-3">Como funciona</h4>
        <div className="space-y-3 text-sm text-slate-400">
          <div className="flex items-start gap-3">
            <span className="w-6 h-6 rounded-full bg-sky-500/10 text-sky-400 flex items-center justify-center text-xs font-bold flex-shrink-0">1</span>
            <p>Se abre el popup de Meta donde inicias sesion con Facebook y seleccionas tu negocio</p>
          </div>
          <div className="flex items-start gap-3">
            <span className="w-6 h-6 rounded-full bg-sky-500/10 text-sky-400 flex items-center justify-center text-xs font-bold flex-shrink-0">2</span>
            <p>Seleccionas tu WhatsApp Business Account existente y el numero verificado</p>
          </div>
          <div className="flex items-start gap-3">
            <span className="w-6 h-6 rounded-full bg-sky-500/10 text-sky-400 flex items-center justify-center text-xs font-bold flex-shrink-0">3</span>
            <p>Si tu numero esta en la app de WhatsApp Business, escaneas el QR para migrar al Cloud API</p>
          </div>
          <div className="flex items-start gap-3">
            <span className="w-6 h-6 rounded-full bg-sky-500/10 text-sky-400 flex items-center justify-center text-xs font-bold flex-shrink-0">4</span>
            <p>Al confirmar, se intercambia el codigo por un token y tu cuenta queda conectada</p>
          </div>
        </div>
      </div>

      <div className="glass-card p-4 border-amber-500/20">
        <div className="flex items-start gap-3">
          <AlertCircle className="w-4 h-4 text-amber-400 flex-shrink-0 mt-0.5" />
          <div className="text-xs text-slate-400">
            <p className="text-amber-400 font-medium mb-1">Requisitos previos</p>
            <ul className="space-y-1">
              <li>- El secreto <span className="text-slate-300 font-mono">META_APP_SECRET</span> debe estar configurado en los Edge Function secrets</li>
              <li>- Tu dominio debe estar en la lista de dominios permitidos de la app de Meta</li>
              <li>
                - Tu app de Meta necesita{' '}
                <a href="https://developers.facebook.com/apps/1393977296081412/app-review/" target="_blank" rel="noopener noreferrer" className="text-emerald-400 hover:text-emerald-300 inline-flex items-center gap-0.5">
                  App Review <ExternalLink className="w-3 h-3" />
                </a>
                {' '}completado para produccion
              </li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}
