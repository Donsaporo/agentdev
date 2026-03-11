import { useState, useEffect, useCallback, useRef } from 'react';
import { Loader2, ExternalLink } from 'lucide-react';
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
      getLoginStatus: (callback: (response: FBLoginResponse) => void) => void;
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

interface SignupSessionInfo {
  waba_id?: string;
  phone_number_id?: string;
}

interface EmbeddedSignupProps {
  onSuccess: () => void;
}

export default function EmbeddedSignup({ onSuccess }: EmbeddedSignupProps) {
  const toast = useToast();
  const [appId, setAppId] = useState('');
  const [configId, setConfigId] = useState('');
  const [sdkLoaded, setSdkLoaded] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [step, setStep] = useState<'config' | 'ready'>('config');
  const sessionInfoRef = useRef<SignupSessionInfo>({});

  const initFacebookSDK = useCallback((fbAppId: string) => {
    if (window.FB) {
      window.FB.init({
        appId: fbAppId,
        cookie: true,
        xfbml: true,
        version: 'v21.0',
      });
      setSdkLoaded(true);
      return;
    }

    window.fbAsyncInit = () => {
      window.FB.init({
        appId: fbAppId,
        cookie: true,
        xfbml: true,
        version: 'v21.0',
      });
      setSdkLoaded(true);
    };

    if (!document.getElementById('facebook-jssdk')) {
      const script = document.createElement('script');
      script.id = 'facebook-jssdk';
      script.src = 'https://connect.facebook.net/en_US/sdk.js';
      script.async = true;
      script.defer = true;
      document.body.appendChild(script);
    }
  }, []);

  useEffect(() => {
    function handleMessage(event: MessageEvent) {
      if (event.origin !== 'https://www.facebook.com' && event.origin !== 'https://web.facebook.com') return;

      try {
        const data = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
        if (data.type === 'WA_EMBEDDED_SIGNUP') {
          const info = data.data || {};
          sessionInfoRef.current = {
            waba_id: info.waba_id,
            phone_number_id: info.phone_number_id,
          };
        }
      } catch {
        // not a JSON message we care about
      }
    }

    window.addEventListener('message', handleMessage);
    return () => {
      window.removeEventListener('message', handleMessage);
      const script = document.getElementById('facebook-jssdk');
      if (script) script.remove();
    };
  }, []);

  function handleConfigure() {
    if (!appId.trim()) {
      toast.error('Enter your Meta App ID');
      return;
    }
    initFacebookSDK(appId.trim());
    setStep('ready');
  }

  function launchEmbeddedSignup() {
    if (!window.FB) {
      toast.error('Facebook SDK not loaded yet. Wait a moment and try again.');
      return;
    }

    setConnecting(true);
    sessionInfoRef.current = {};

    const trimmedConfigId = configId.trim();

    const loginParams: Record<string, unknown> = {
      response_type: 'code',
      override_default_response_type: true,
      extras: {
        setup: {},
        featureType: '',
        sessionInfoVersion: '3',
      },
    };

    if (trimmedConfigId) {
      loginParams.config_id = trimmedConfigId;
    } else {
      loginParams.scope = 'whatsapp_business_management,whatsapp_business_messaging';
    }

    window.FB.login((response: FBLoginResponse) => {
      if (response.authResponse?.code) {
        handleSignupCode(response.authResponse.code);
      } else {
        setConnecting(false);
        if (response.status === 'not_authorized') {
          toast.error('You need to authorize the app to continue');
        } else {
          toast.warning('Connection cancelled');
        }
      }
    }, loginParams);
  }

  async function handleSignupCode(code: string) {
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData.session?.access_token;

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
          app_id: appId.trim(),
          configuration_id: configId.trim(),
          waba_id: sessionInfoRef.current.waba_id || '',
          phone_number_id: sessionInfoRef.current.phone_number_id || '',
        }),
      });

      const result = await resp.json();

      if (!resp.ok || result.error) {
        throw new Error(result.error || 'Failed to complete signup');
      }

      toast.success('WhatsApp Business account connected successfully');
      onSuccess();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Connection failed';
      toast.error(message);
    } finally {
      setConnecting(false);
    }
  }

  if (step === 'config') {
    return (
      <div className="space-y-6">
        <div className="glass-card p-6 space-y-5">
          <div>
            <h3 className="text-base font-semibold text-white">Meta App Configuration</h3>
            <p className="text-sm text-slate-400 mt-1">
              Enter your Meta App credentials to enable the WhatsApp Embedded Signup flow.
            </p>
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-300 mb-1.5">Meta App ID</label>
            <input
              type="text"
              value={appId}
              onChange={e => setAppId(e.target.value)}
              placeholder="123456789012345"
              className="w-full glass-input font-mono"
            />
            <p className="text-xs text-slate-500 mt-1.5">
              From your{' '}
              <a
                href="https://developers.facebook.com/apps/"
                target="_blank"
                rel="noopener noreferrer"
                className="text-emerald-400 hover:text-emerald-300 inline-flex items-center gap-1"
              >
                Meta Developer Dashboard <ExternalLink className="w-3 h-3" />
              </a>
            </p>
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-300 mb-1.5">
              Configuration ID <span className="text-slate-500 font-normal">(optional)</span>
            </label>
            <input
              type="text"
              value={configId}
              onChange={e => setConfigId(e.target.value)}
              placeholder="123456789012345"
              className="w-full glass-input font-mono"
            />
            <p className="text-xs text-slate-500 mt-1.5">
              From WhatsApp &gt; Embedded Signup in your Meta App settings. If empty, uses the default flow.
            </p>
          </div>

          <div className="pt-2">
            <button onClick={handleConfigure} className="btn-primary w-full justify-center">
              Continue
            </button>
          </div>
        </div>

        <div className="glass-card p-5">
          <h4 className="text-sm font-medium text-slate-300 mb-3">Requirements</h4>
          <ul className="space-y-2.5 text-sm text-slate-400">
            <li className="flex items-start gap-2.5">
              <span className="w-5 h-5 rounded-full bg-emerald-500/10 text-emerald-400 flex items-center justify-center text-xs font-bold flex-shrink-0 mt-0.5">1</span>
              A Meta Business Account with WhatsApp product enabled
            </li>
            <li className="flex items-start gap-2.5">
              <span className="w-5 h-5 rounded-full bg-emerald-500/10 text-emerald-400 flex items-center justify-center text-xs font-bold flex-shrink-0 mt-0.5">2</span>
              A Meta App with Facebook Login configured (type: Business)
            </li>
            <li className="flex items-start gap-2.5">
              <span className="w-5 h-5 rounded-full bg-emerald-500/10 text-emerald-400 flex items-center justify-center text-xs font-bold flex-shrink-0 mt-0.5">3</span>
              Your Meta App Secret configured as META_APP_SECRET in Edge Function secrets
            </li>
          </ul>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="glass-card p-6">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h3 className="text-base font-semibold text-white">Connect WhatsApp Business</h3>
            <p className="text-sm text-slate-400 mt-1">
              Click below to open the Meta Embedded Signup. You can connect an existing WhatsApp Business number or register a new one.
            </p>
          </div>
          <button onClick={() => setStep('config')} className="text-xs text-slate-500 hover:text-slate-300 transition-colors">
            Change App
          </button>
        </div>

        <div className="bg-white/[0.02] rounded-xl border border-white/[0.06] p-5 mb-5">
          <div className="flex items-center gap-3 text-sm">
            <div className="w-8 h-8 rounded-lg bg-sky-500/10 flex items-center justify-center">
              <svg viewBox="0 0 24 24" className="w-4 h-4 text-sky-400" fill="currentColor">
                <path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z"/>
              </svg>
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-slate-300 font-medium">Meta App: <span className="font-mono text-emerald-400">{appId}</span></p>
              {configId && <p className="text-slate-500 text-xs mt-0.5">Config: {configId}</p>}
            </div>
            <div className={`w-2 h-2 rounded-full ${sdkLoaded ? 'bg-emerald-400' : 'bg-amber-400 animate-pulse'}`} />
          </div>
        </div>

        <button
          onClick={launchEmbeddedSignup}
          disabled={connecting || !sdkLoaded}
          className="w-full flex items-center justify-center gap-3 bg-[#1877F2] hover:bg-[#166FE5] disabled:opacity-50 disabled:hover:bg-[#1877F2] text-white text-sm font-semibold rounded-xl px-5 py-3.5 transition-all active:scale-[0.98] shadow-lg shadow-[#1877F2]/20"
        >
          {connecting ? (
            <>
              <Loader2 className="w-5 h-5 animate-spin" />
              Connecting...
            </>
          ) : (
            <>
              <svg viewBox="0 0 175.216 175.552" className="w-5 h-5" fill="currentColor">
                <path d="M87.184 0C39.04 0 0 39.04 0 87.184c0 16.368 4.528 31.68 12.4 44.784L0 175.552l45.024-11.808c12.592 6.864 27.008 10.768 42.16 10.768 48.144 0 87.184-39.04 87.184-87.184S135.328 0 87.184 0zm0 159.072c-14.336 0-27.632-4.16-38.912-11.328l-2.784-1.664-28.928 7.584 7.712-28.192-1.824-2.912c-7.92-12.592-12.096-27.136-12.096-42.368 0-39.648 32.256-71.904 71.904-71.904s71.904 32.256 71.904 71.904-32.384 71.904-72.032 71.904z" fill="white"/>
                <path d="M126.848 105.312c-2.176-1.088-12.864-6.352-14.864-7.072-2-0.72-3.456-1.088-4.912 1.088-1.456 2.176-5.632 7.072-6.912 8.528-1.264 1.456-2.544 1.632-4.72 0.544-2.176-1.088-9.184-3.392-17.488-10.8-6.464-5.76-10.832-12.88-12.096-15.056-1.264-2.176-0.128-3.344 0.96-4.432 0.976-0.976 2.176-2.544 3.264-3.808 1.088-1.264 1.456-2.176 2.176-3.632 0.72-1.456 0.352-2.72-0.176-3.808-0.544-1.088-4.912-11.84-6.736-16.192-1.776-4.256-3.584-3.68-4.912-3.744-1.264-0.064-2.72-0.08-4.176-0.08-1.456 0-3.808 0.544-5.808 2.72-2 2.176-7.616 7.44-7.616 18.144 0 10.704 7.808 21.04 8.896 22.496 1.088 1.456 15.36 23.44 37.216 32.864 5.2 2.24 9.264 3.584 12.432 4.592 5.232 1.664 9.984 1.424 13.744 0.864 4.192-0.624 12.864-5.264 14.688-10.336 1.824-5.072 1.824-9.408 1.264-10.336-0.528-0.896-1.984-1.456-4.16-2.544z" fill="white"/>
              </svg>
              Connect WhatsApp Business
            </>
          )}
        </button>
      </div>

      <div className="glass-card p-5">
        <h4 className="text-sm font-medium text-slate-300 mb-3">How it works</h4>
        <div className="space-y-3 text-sm text-slate-400">
          <div className="flex items-start gap-3">
            <span className="w-6 h-6 rounded-full bg-sky-500/10 text-sky-400 flex items-center justify-center text-xs font-bold flex-shrink-0">1</span>
            <p>A Meta popup will open asking you to log in with Facebook and select your business</p>
          </div>
          <div className="flex items-start gap-3">
            <span className="w-6 h-6 rounded-full bg-sky-500/10 text-sky-400 flex items-center justify-center text-xs font-bold flex-shrink-0">2</span>
            <p>Select or create your WhatsApp Business Account and add a phone number</p>
          </div>
          <div className="flex items-start gap-3">
            <span className="w-6 h-6 rounded-full bg-sky-500/10 text-sky-400 flex items-center justify-center text-xs font-bold flex-shrink-0">3</span>
            <p>If you already use WhatsApp Business App, you can scan the QR code to migrate your number</p>
          </div>
          <div className="flex items-start gap-3">
            <span className="w-6 h-6 rounded-full bg-sky-500/10 text-sky-400 flex items-center justify-center text-xs font-bold flex-shrink-0">4</span>
            <p>Once confirmed, your account will be connected and ready to send/receive messages</p>
          </div>
        </div>
      </div>
    </div>
  );
}
