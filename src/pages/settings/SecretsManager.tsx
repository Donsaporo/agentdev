import { useEffect, useState, useCallback } from 'react';
import { Key, Eye, EyeOff, Save, CheckCircle2, AlertCircle, Clock, Loader2 } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { useToast } from '../../contexts/ToastContext';
import type { AgentSecret } from '../../lib/types';
import { formatDistanceToNow } from 'date-fns';

const STATUS_CONFIG = {
  connected: { color: 'text-emerald-400', bg: 'bg-emerald-500/10', icon: CheckCircle2, label: 'Connected' },
  error: { color: 'text-red-400', bg: 'bg-red-500/10', icon: AlertCircle, label: 'Error' },
  untested: { color: 'text-slate-500', bg: 'bg-slate-800/30', icon: Clock, label: 'Untested' },
} as const;

interface SecretRow {
  secret: AgentSecret;
  editing: boolean;
  inputValue: string;
  saving: boolean;
  showValue: boolean;
}

export default function SecretsManager() {
  const toast = useToast();
  const [rows, setRows] = useState<SecretRow[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchSecrets = useCallback(async () => {
    const { data, error } = await supabase
      .from('agent_secrets')
      .select('*')
      .order('service_name');

    if (error) {
      toast.error('Failed to load secrets');
      setLoading(false);
      return;
    }

    setRows((data || []).map((s: AgentSecret) => ({
      secret: s,
      editing: false,
      inputValue: '',
      saving: false,
      showValue: false,
    })));
    setLoading(false);
  }, [toast]);

  useEffect(() => {
    fetchSecrets();
  }, [fetchSecrets]);

  function startEditing(index: number) {
    setRows(prev => prev.map((r, i) =>
      i === index ? { ...r, editing: true, inputValue: '', showValue: false } : r
    ));
  }

  function cancelEditing(index: number) {
    setRows(prev => prev.map((r, i) =>
      i === index ? { ...r, editing: false, inputValue: '' } : r
    ));
  }

  function updateInput(index: number, value: string) {
    setRows(prev => prev.map((r, i) =>
      i === index ? { ...r, inputValue: value } : r
    ));
  }

  function toggleShowValue(index: number) {
    setRows(prev => prev.map((r, i) =>
      i === index ? { ...r, showValue: !r.showValue } : r
    ));
  }

  async function saveSecret(index: number) {
    const row = rows[index];
    if (!row.inputValue.trim()) return;

    setRows(prev => prev.map((r, i) =>
      i === index ? { ...r, saving: true } : r
    ));

    const { error } = await supabase
      .from('agent_secrets')
      .update({ secret_value: row.inputValue.trim(), status: 'untested', status_message: '' })
      .eq('id', row.secret.id);

    if (error) {
      toast.error(`Failed to save ${row.secret.service_label}`);
      setRows(prev => prev.map((r, i) =>
        i === index ? { ...r, saving: false } : r
      ));
      return;
    }

    toast.success(`${row.secret.service_label} saved`);
    await fetchSecrets();
  }

  if (loading) {
    return (
      <div className="bg-slate-900/60 border border-slate-800/60 rounded-xl p-6">
        <div className="flex items-center justify-center py-8">
          <div className="w-6 h-6 border-2 border-emerald-500/30 border-t-emerald-500 rounded-full animate-spin" />
        </div>
      </div>
    );
  }

  const configuredCount = rows.filter(r => r.secret.masked_value && r.secret.masked_value !== '****').length;

  return (
    <div className="bg-slate-900/60 border border-slate-800/60 rounded-xl p-6 space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-white">API Keys & Secrets</h2>
          <p className="text-sm text-slate-400 mt-0.5">
            {configuredCount}/{rows.length} services configured. Keys are stored encrypted in the database.
          </p>
        </div>
      </div>

      <div className="space-y-3">
        {rows.map((row, index) => {
          const statusCfg = STATUS_CONFIG[row.secret.status as keyof typeof STATUS_CONFIG] || STATUS_CONFIG.untested;
          const StatusIcon = statusCfg.icon;
          const hasValue = row.secret.masked_value && row.secret.masked_value !== '****';

          return (
            <div
              key={row.secret.id}
              className="bg-slate-800/30 border border-slate-700/40 rounded-xl p-4 transition-all hover:border-slate-600/50"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-center gap-3 min-w-0">
                  <div className={`p-2 rounded-lg ${statusCfg.bg}`}>
                    <Key className={`w-4 h-4 ${statusCfg.color}`} />
                  </div>
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-slate-200">{row.secret.service_label}</p>
                    <p className="text-xs text-slate-500 font-mono">{row.secret.service_name}</p>
                  </div>
                </div>

                <div className="flex items-center gap-2 flex-shrink-0">
                  <div className="flex items-center gap-1.5">
                    <StatusIcon className={`w-3.5 h-3.5 ${statusCfg.color}`} />
                    <span className={`text-xs ${statusCfg.color}`}>{statusCfg.label}</span>
                  </div>
                </div>
              </div>

              {hasValue && !row.editing && (
                <div className="mt-3 flex items-center gap-2">
                  <div className="flex-1 bg-slate-900/60 rounded-lg px-3 py-2 font-mono text-sm text-slate-400">
                    {row.showValue ? row.secret.masked_value : row.secret.masked_value}
                  </div>
                  <button
                    onClick={() => startEditing(index)}
                    className="px-3 py-2 text-xs font-medium text-slate-300 bg-slate-700/50 hover:bg-slate-700 rounded-lg transition-colors"
                  >
                    Update
                  </button>
                </div>
              )}

              {!hasValue && !row.editing && (
                <div className="mt-3">
                  <button
                    onClick={() => startEditing(index)}
                    className="w-full px-3 py-2.5 border border-dashed border-slate-600 hover:border-emerald-500/40 rounded-lg text-sm text-slate-400 hover:text-emerald-400 transition-all text-center"
                  >
                    Click to configure
                  </button>
                </div>
              )}

              {row.editing && (
                <div className="mt-3 space-y-2">
                  <div className="relative">
                    <input
                      type={row.showValue ? 'text' : 'password'}
                      value={row.inputValue}
                      onChange={e => updateInput(index, e.target.value)}
                      placeholder={hasValue ? 'Enter new value to replace...' : 'Paste your API key here...'}
                      autoFocus
                      className="w-full bg-slate-900/80 border border-slate-600 rounded-lg pl-3 pr-10 py-2.5 text-sm text-white font-mono placeholder-slate-600 focus:outline-none focus:ring-2 focus:ring-emerald-500/50 focus:border-emerald-500 transition-colors"
                    />
                    <button
                      type="button"
                      onClick={() => toggleShowValue(index)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300 transition-colors"
                    >
                      {row.showValue ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </button>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => saveSecret(index)}
                      disabled={!row.inputValue.trim() || row.saving}
                      className="inline-flex items-center gap-1.5 px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-medium rounded-lg transition-all disabled:opacity-40"
                    >
                      {row.saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
                      Save
                    </button>
                    <button
                      onClick={() => cancelEditing(index)}
                      className="px-4 py-2 text-xs text-slate-400 hover:text-slate-200 transition-colors"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}

              {row.secret.status_message && (
                <p className={`mt-2 text-xs ${row.secret.status === 'error' ? 'text-red-400' : 'text-slate-500'}`}>
                  {row.secret.status_message}
                </p>
              )}

              {row.secret.last_tested && (
                <p className="mt-1 text-xs text-slate-600">
                  Last tested {formatDistanceToNow(new Date(row.secret.last_tested), { addSuffix: true })}
                </p>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
