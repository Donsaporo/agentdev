import { useEffect, useState, useCallback } from 'react';
import { Key, Eye, EyeOff, Save, CheckCircle2, AlertCircle, Clock, Loader2, Plus, Trash2, RefreshCw } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { useToast } from '../../contexts/ToastContext';
import type { AgentSecret } from '../../lib/types';
import { formatDistanceToNow } from 'date-fns';

const STATUS_CONFIG = {
  connected: { color: 'text-emerald-400', bg: 'bg-emerald-500/10', icon: CheckCircle2, label: 'Connected' },
  error: { color: 'text-red-400', bg: 'bg-red-500/10', icon: AlertCircle, label: 'Error' },
  untested: { color: 'text-slate-500', bg: 'bg-white/[0.04]', icon: Clock, label: 'Untested' },
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
  const [showAddForm, setShowAddForm] = useState(false);
  const [newSecret, setNewSecret] = useState({ service_name: '', service_label: '', secret_value: '' });
  const [addingSaving, setAddingSaving] = useState(false);

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

    const { data, error } = await supabase
      .from('agent_secrets')
      .update({ secret_value: row.inputValue.trim(), status: 'untested', status_message: '' })
      .eq('id', row.secret.id)
      .select('id')
      .maybeSingle();

    if (error || !data) {
      toast.error(`Failed to save ${row.secret.service_label}${error ? ': ' + error.message : ' (no rows updated)'}`);
      setRows(prev => prev.map((r, i) =>
        i === index ? { ...r, saving: false } : r
      ));
      return;
    }

    toast.success(`${row.secret.service_label} saved`);
    await fetchSecrets();
  }

  async function deleteSecret(index: number) {
    const row = rows[index];
    const { error } = await supabase.from('agent_secrets').delete().eq('id', row.secret.id);
    if (error) {
      toast.error(`Failed to delete ${row.secret.service_label}`);
      return;
    }
    toast.success(`${row.secret.service_label} removed`);
    await fetchSecrets();
  }

  async function handleAddSecret(e: React.FormEvent) {
    e.preventDefault();
    if (!newSecret.service_name.trim() || !newSecret.service_label.trim()) return;
    setAddingSaving(true);
    const { error } = await supabase.from('agent_secrets').insert({
      service_name: newSecret.service_name.toLowerCase().replace(/\s+/g, '_'),
      service_label: newSecret.service_label,
      secret_value: newSecret.secret_value,
      status: 'untested',
    });
    if (error) {
      toast.error('Failed to add secret: ' + error.message);
      setAddingSaving(false);
      return;
    }
    toast.success('Secret added');
    setNewSecret({ service_name: '', service_label: '', secret_value: '' });
    setShowAddForm(false);
    setAddingSaving(false);
    await fetchSecrets();
  }

  if (loading) {
    return (
      <div className="glass-card p-6">
        <div className="flex items-center justify-center py-8">
          <div className="w-6 h-6 border-2 border-emerald-500/30 border-t-emerald-500 rounded-full animate-spin" />
        </div>
      </div>
    );
  }

  const configuredCount = rows.filter(r => r.secret.masked_value && r.secret.masked_value.length > 0).length;

  return (
    <div className="glass-card p-6 space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-white">API Keys & Secrets</h2>
          <p className="text-sm text-slate-400 mt-0.5">
            {configuredCount}/{rows.length} services configured
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => fetchSecrets()} className="p-2 text-slate-400 hover:text-slate-200 hover:bg-white/[0.04] rounded-xl transition-all" title="Refresh">
            <RefreshCw className="w-4 h-4" />
          </button>
          <button onClick={() => setShowAddForm(!showAddForm)} className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold text-emerald-400 hover:text-emerald-300 bg-emerald-500/10 hover:bg-emerald-500/15 rounded-xl transition-all">
            <Plus className="w-3.5 h-3.5" />
            Add
          </button>
        </div>
      </div>

      {showAddForm && (
        <form onSubmit={handleAddSecret} className="bg-white/[0.02] border border-white/[0.06] rounded-xl p-4 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-slate-400 mb-1">Service Key</label>
              <input type="text" value={newSecret.service_name} onChange={e => setNewSecret({ ...newSecret, service_name: e.target.value })} placeholder="e.g. openai" required className="w-full glass-input text-sm" />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-400 mb-1">Display Label</label>
              <input type="text" value={newSecret.service_label} onChange={e => setNewSecret({ ...newSecret, service_label: e.target.value })} placeholder="e.g. OpenAI API Key" required className="w-full glass-input text-sm" />
            </div>
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-400 mb-1">Value (optional)</label>
            <input type="password" value={newSecret.secret_value} onChange={e => setNewSecret({ ...newSecret, secret_value: e.target.value })} placeholder="Paste API key here..." className="w-full glass-input text-sm font-mono" />
          </div>
          <div className="flex items-center gap-2 pt-1">
            <button type="submit" disabled={addingSaving} className="inline-flex items-center gap-1.5 px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold rounded-xl transition-all disabled:opacity-40">
              {addingSaving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
              Add Secret
            </button>
            <button type="button" onClick={() => { setShowAddForm(false); setNewSecret({ service_name: '', service_label: '', secret_value: '' }); }} className="px-4 py-2 text-xs text-slate-400 hover:text-slate-200 transition-colors">
              Cancel
            </button>
          </div>
        </form>
      )}

      <div className="space-y-3">
        {rows.map((row, index) => {
          const statusCfg = STATUS_CONFIG[row.secret.status as keyof typeof STATUS_CONFIG] || STATUS_CONFIG.untested;
          const StatusIcon = statusCfg.icon;
          const hasValue = row.secret.masked_value && row.secret.masked_value.length > 0;

          return (
            <div
              key={row.secret.id}
              className="bg-white/[0.02] border border-white/[0.06] rounded-xl p-4 transition-all hover:border-white/[0.1]"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-center gap-3 min-w-0">
                  <div className={`p-2 rounded-xl ${statusCfg.bg}`}>
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
                  <button onClick={() => deleteSecret(index)} className="p-1.5 text-slate-600 hover:text-red-400 rounded-lg transition-colors" title="Remove">
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>

              {hasValue && !row.editing && (
                <div className="mt-3 flex items-center gap-2">
                  <div className="flex-1 bg-white/[0.02] border border-white/[0.04] rounded-xl px-3 py-2 font-mono text-sm text-slate-400 flex items-center gap-2">
                    {row.showValue ? row.secret.masked_value : '************************************'}
                    <button onClick={() => toggleShowValue(index)} className="text-slate-600 hover:text-slate-400 transition-colors flex-shrink-0">
                      {row.showValue ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                    </button>
                  </div>
                  <button
                    onClick={() => startEditing(index)}
                    className="px-3 py-2 text-xs font-medium text-slate-300 bg-white/[0.04] hover:bg-white/[0.06] rounded-xl transition-colors"
                  >
                    Update
                  </button>
                </div>
              )}

              {!hasValue && !row.editing && (
                <div className="mt-3">
                  <button
                    onClick={() => startEditing(index)}
                    className="w-full px-3 py-2.5 border border-dashed border-white/[0.08] hover:border-emerald-500/40 rounded-xl text-sm text-slate-400 hover:text-emerald-400 transition-all text-center"
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
                      className="w-full glass-input pr-10 text-sm font-mono"
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
                      className="inline-flex items-center gap-1.5 px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold rounded-xl transition-all disabled:opacity-40"
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
