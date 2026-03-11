import { useState, useEffect } from 'react';
import { MessageCircle, Plus, Loader2, RefreshCw, Smartphone } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useToast } from '../contexts/ToastContext';
import type { WhatsAppBusinessAccount } from '../lib/types';
import EmbeddedSignup from './whatsapp/EmbeddedSignup';
import WhatsAppAccountCard from './whatsapp/WhatsAppAccountCard';

export default function WhatsAppPage() {
  const toast = useToast();
  const [accounts, setAccounts] = useState<WhatsAppBusinessAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [showSetup, setShowSetup] = useState(false);
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
    setShowSetup(false);
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
            Connect and manage your WhatsApp Business accounts
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={loadAccounts} className="btn-ghost flex items-center gap-2">
            <RefreshCw className="w-4 h-4" />
            <span className="hidden sm:inline">Refresh</span>
          </button>
          {!showSetup && (
            <button onClick={() => setShowSetup(true)} className="btn-primary">
              <Plus className="w-4 h-4" />
              Connect Account
            </button>
          )}
        </div>
      </div>

      {showSetup && (
        <div className="animate-fade-in-up">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold text-white flex items-center gap-2">
              <Smartphone className="w-5 h-5 text-emerald-400" />
              Connect WhatsApp via Meta Embedded Signup
            </h2>
            <button
              onClick={() => setShowSetup(false)}
              className="text-sm text-slate-500 hover:text-slate-300 transition-colors"
            >
              Cancel
            </button>
          </div>
          <EmbeddedSignup onSuccess={handleSetupSuccess} />
        </div>
      )}

      {!showSetup && accounts.length === 0 && (
        <div className="glass-card flex flex-col items-center justify-center py-16 px-6 text-center">
          <div className="w-16 h-16 rounded-2xl bg-emerald-500/10 flex items-center justify-center mb-5">
            <MessageCircle className="w-8 h-8 text-emerald-400" />
          </div>
          <h3 className="text-lg font-semibold text-white mb-2">No WhatsApp accounts connected</h3>
          <p className="text-sm text-slate-400 max-w-md mb-6">
            Connect your WhatsApp Business account using Meta's Embedded Signup flow.
            You can use an existing WhatsApp Business App number or register a new one.
          </p>
          <button onClick={() => setShowSetup(true)} className="btn-primary">
            <Plus className="w-4 h-4" />
            Connect Your First Account
          </button>
        </div>
      )}

      {!showSetup && accounts.length > 0 && (
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
