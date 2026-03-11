import { useState, useEffect } from 'react';
import { MessageCircle, Plus, RefreshCw, Key, Smartphone } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useToast } from '../contexts/ToastContext';
import type { WhatsAppBusinessAccount } from '../lib/types';
import WhatsAppConnect from './whatsapp/WhatsAppConnect';
import EmbeddedSignup from './whatsapp/EmbeddedSignup';
import WhatsAppAccountCard from './whatsapp/WhatsAppAccountCard';

type SetupMode = null | 'connect' | 'embedded';

export default function WhatsAppPage() {
  const toast = useToast();
  const [accounts, setAccounts] = useState<WhatsAppBusinessAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [setupMode, setSetupMode] = useState<SetupMode>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  useEffect(() => {
    loadAccounts();
  }, []);

  async function loadAccounts() {
    setLoading(true);
    const { data, error } = await supabase
      .from('whatsapp_business_accounts')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) {
      toast.error('Failed to load WhatsApp accounts');
    } else {
      setAccounts(data || []);
    }
    setLoading(false);
  }

  async function handleDelete(id: string) {
    if (!confirm('Are you sure you want to remove this WhatsApp account? This will not affect your WhatsApp Business Account on Meta.')) return;

    setDeletingId(id);
    const { error } = await supabase
      .from('whatsapp_business_accounts')
      .delete()
      .eq('id', id);

    if (error) {
      toast.error('Failed to remove account');
    } else {
      setAccounts(prev => prev.filter(a => a.id !== id));
      toast.success('Account removed');
    }
    setDeletingId(null);
  }

  function handleSetupSuccess() {
    setSetupMode(null);
    loadAccounts();
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24">
        <div className="w-8 h-8 border-2 border-emerald-500/30 border-t-emerald-500 rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-6 animate-fade-in">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white tracking-tight">WhatsApp</h1>
          <p className="text-slate-400 mt-1 text-sm">
            Conecta y administra tus cuentas de WhatsApp Business
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={loadAccounts} className="btn-ghost flex items-center gap-2">
            <RefreshCw className="w-4 h-4" />
            <span className="hidden sm:inline">Refresh</span>
          </button>
          {!setupMode && (
            <button onClick={() => setSetupMode('connect')} className="btn-primary">
              <Plus className="w-4 h-4" />
              Conectar cuenta
            </button>
          )}
        </div>
      </div>

      {setupMode && (
        <div className="animate-fade-in-up">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-3">
              <button
                onClick={() => setSetupMode('connect')}
                className={`flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium transition-all ${
                  setupMode === 'connect'
                    ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/30'
                    : 'text-slate-400 hover:text-slate-300 border border-transparent'
                }`}
              >
                <Key className="w-4 h-4" />
                Cuenta existente
              </button>
              <button
                onClick={() => setSetupMode('embedded')}
                className={`flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium transition-all ${
                  setupMode === 'embedded'
                    ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/30'
                    : 'text-slate-400 hover:text-slate-300 border border-transparent'
                }`}
              >
                <Smartphone className="w-4 h-4" />
                Embedded Signup
              </button>
            </div>
            <button
              onClick={() => setSetupMode(null)}
              className="text-sm text-slate-500 hover:text-slate-300 transition-colors"
            >
              Cancelar
            </button>
          </div>

          {setupMode === 'connect' && <WhatsAppConnect onSuccess={handleSetupSuccess} />}
          {setupMode === 'embedded' && <EmbeddedSignup onSuccess={handleSetupSuccess} />}
        </div>
      )}

      {!setupMode && accounts.length === 0 && (
        <div className="glass-card flex flex-col items-center justify-center py-16 px-6 text-center">
          <div className="w-16 h-16 rounded-2xl bg-emerald-500/10 flex items-center justify-center mb-5">
            <MessageCircle className="w-8 h-8 text-emerald-400" />
          </div>
          <h3 className="text-lg font-semibold text-white mb-2">No hay cuentas de WhatsApp conectadas</h3>
          <p className="text-sm text-slate-400 max-w-md mb-6">
            Conecta tu cuenta de WhatsApp Business existente con su Access Token,
            o usa el Embedded Signup de Meta para crear una nueva.
          </p>
          <div className="flex items-center gap-3">
            <button onClick={() => setSetupMode('connect')} className="btn-primary">
              <Key className="w-4 h-4" />
              Conectar cuenta existente
            </button>
            <button onClick={() => setSetupMode('embedded')} className="btn-ghost">
              <Smartphone className="w-4 h-4" />
              Embedded Signup
            </button>
          </div>
        </div>
      )}

      {!setupMode && accounts.length > 0 && (
        <div className="space-y-3">
          {accounts.map(account => (
            <WhatsAppAccountCard
              key={account.id}
              account={account}
              onDelete={handleDelete}
              deleting={deletingId === account.id}
            />
          ))}
        </div>
      )}
    </div>
  );
}
