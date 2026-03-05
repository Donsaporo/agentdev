import { useEffect, useState } from 'react';
import { Save, User, Key, Server, Shield, CheckCircle2, AlertCircle, Loader2, Wifi, WifiOff } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from '../contexts/ToastContext';
import { supabase } from '../lib/supabase';
import { useAgentConfig } from '../hooks/useAgentConfig';
import { formatDistanceToNow } from 'date-fns';

interface SettingsSection {
  id: string;
  label: string;
  icon: typeof User;
}

const sections: SettingsSection[] = [
  { id: 'profile', label: 'Profile', icon: User },
  { id: 'api-keys', label: 'API Keys', icon: Key },
  { id: 'agent', label: 'Agent Config', icon: Server },
  { id: 'security', label: 'Security', icon: Shield },
];

const MODEL_OPTIONS = [
  { value: 'claude-sonnet-4-20250514', label: 'Claude Sonnet 4 (Balanced)' },
  { value: 'claude-opus-4-20250514', label: 'Claude Opus 4 (Complex tasks)' },
  { value: 'claude-haiku-3-20250515', label: 'Claude Haiku 3 (Fast/Simple)' },
];

const CORRECTION_OPTIONS = [
  { value: 3, label: '3 attempts' },
  { value: 5, label: '5 attempts' },
  { value: 10, label: '10 attempts' },
];

const apiServices = [
  { name: 'Claude API (Anthropic)', envVar: 'ANTHROPIC_API_KEY' },
  { name: 'GitHub PAT', envVar: 'GITHUB_TOKEN' },
  { name: 'Vercel API', envVar: 'VERCEL_TOKEN' },
  { name: 'Namecheap API', envVar: 'NAMECHEAP_API_KEY' },
  { name: 'Resend API', envVar: 'RESEND_API_KEY' },
];

export default function SettingsPage() {
  const { teamMember, user, refreshProfile } = useAuth();
  const toast = useToast();
  const { getValue, setValue, loading: configLoading } = useAgentConfig();
  const [activeSection, setActiveSection] = useState('profile');
  const [saving, setSaving] = useState(false);

  const [profile, setProfile] = useState({ full_name: '', role: '' });
  const [passwords, setPasswords] = useState({ newPass: '', confirm: '' });
  const [agentStatus, setAgentStatus] = useState<{ online: boolean; lastSeen: string | null }>({ online: false, lastSeen: null });

  useEffect(() => {
    if (teamMember) {
      setProfile({ full_name: teamMember.full_name, role: teamMember.role });
    }
  }, [teamMember]);

  useEffect(() => {
    async function checkAgentHeartbeat() {
      const { data } = await supabase
        .from('agent_logs')
        .select('created_at')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (data) {
        const lastSeen = new Date(data.created_at);
        const diffMs = Date.now() - lastSeen.getTime();
        setAgentStatus({ online: diffMs < 120_000, lastSeen: data.created_at });
      }
    }
    checkAgentHeartbeat();
    const interval = setInterval(checkAgentHeartbeat, 30_000);
    return () => clearInterval(interval);
  }, []);

  async function handleSaveProfile(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    const { error } = await supabase.from('team_members').update({ full_name: profile.full_name }).eq('id', user!.id);
    if (error) {
      toast.error('Failed to save profile: ' + error.message);
      setSaving(false);
      return;
    }
    await refreshProfile();
    toast.success('Profile saved');
    setSaving(false);
  }

  async function handleChangePassword(e: React.FormEvent) {
    e.preventDefault();
    if (passwords.newPass !== passwords.confirm) {
      toast.error('Passwords do not match');
      return;
    }
    if (passwords.newPass.length < 6) {
      toast.error('Password must be at least 6 characters');
      return;
    }
    setSaving(true);
    const { error } = await supabase.auth.updateUser({ password: passwords.newPass });
    setSaving(false);
    if (error) {
      toast.error('Failed to update password: ' + error.message);
    } else {
      setPasswords({ newPass: '', confirm: '' });
      toast.success('Password updated');
    }
  }

  async function handleSaveConfig(key: string, value: unknown) {
    const { error } = await setValue(key, value);
    if (error) {
      toast.error('Failed to save setting');
    } else {
      toast.success('Setting saved');
    }
  }

  return (
    <div className="space-y-6 animate-fade-in">
      <div>
        <h1 className="text-2xl font-bold text-white">Settings</h1>
        <p className="text-slate-400 mt-1">Configure your profile and agent parameters</p>
      </div>

      <div className="flex flex-col lg:flex-row gap-6">
        <div className="lg:w-56 flex-shrink-0">
          <nav className="flex lg:flex-col gap-1 overflow-x-auto lg:overflow-x-visible pb-2 lg:pb-0">
            {sections.map(section => (
              <button
                key={section.id}
                onClick={() => setActiveSection(section.id)}
                className={`flex items-center gap-2.5 px-3 py-2.5 rounded-lg text-sm font-medium whitespace-nowrap transition-all ${
                  activeSection === section.id
                    ? 'bg-emerald-500/10 text-emerald-400'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/50'
                }`}
              >
                <section.icon className="w-4 h-4 flex-shrink-0" />
                {section.label}
              </button>
            ))}
          </nav>
        </div>

        <div className="flex-1 max-w-2xl">
          {activeSection === 'profile' && (
            <form onSubmit={handleSaveProfile} className="bg-slate-900/60 border border-slate-800/60 rounded-xl p-6 space-y-5">
              <h2 className="text-lg font-semibold text-white">Profile</h2>
              <div>
                <label className="block text-sm font-medium text-slate-300 mb-1.5">Full Name</label>
                <input
                  type="text"
                  value={profile.full_name}
                  onChange={e => setProfile({ ...profile, full_name: e.target.value })}
                  className="w-full bg-slate-800 border border-slate-700 rounded-lg px-4 py-2.5 text-white focus:outline-none focus:ring-2 focus:ring-emerald-500/50 focus:border-emerald-500 transition-colors"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-300 mb-1.5">Email</label>
                <input type="email" value={user?.email || ''} disabled className="w-full bg-slate-800/50 border border-slate-700/50 rounded-lg px-4 py-2.5 text-slate-500 cursor-not-allowed" />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-300 mb-1.5">Role</label>
                <input type="text" value={profile.role} disabled className="w-full bg-slate-800/50 border border-slate-700/50 rounded-lg px-4 py-2.5 text-slate-500 cursor-not-allowed capitalize" />
              </div>
              <div className="pt-2">
                <button type="submit" disabled={saving} className="inline-flex items-center gap-2 px-5 py-2.5 bg-gradient-to-r from-emerald-600 to-cyan-600 hover:from-emerald-500 hover:to-cyan-500 text-white text-sm font-medium rounded-lg transition-all disabled:opacity-50 active:scale-[0.97]">
                  {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                  Save
                </button>
              </div>
            </form>
          )}

          {activeSection === 'api-keys' && (
            <div className="bg-slate-900/60 border border-slate-800/60 rounded-xl p-6 space-y-5">
              <h2 className="text-lg font-semibold text-white">API Keys & Agent Status</h2>

              <div className={`flex items-center gap-3 p-4 rounded-lg border ${agentStatus.online ? 'bg-emerald-500/5 border-emerald-500/20' : 'bg-slate-800/30 border-slate-700/30'}`}>
                {agentStatus.online ? (
                  <Wifi className="w-5 h-5 text-emerald-400" />
                ) : (
                  <WifiOff className="w-5 h-5 text-slate-500" />
                )}
                <div>
                  <p className={`text-sm font-medium ${agentStatus.online ? 'text-emerald-400' : 'text-slate-400'}`}>
                    Agent {agentStatus.online ? 'Online' : 'Offline'}
                  </p>
                  <p className="text-xs text-slate-500">
                    {agentStatus.lastSeen
                      ? `Last seen ${formatDistanceToNow(new Date(agentStatus.lastSeen), { addSuffix: true })}`
                      : 'No activity recorded'}
                  </p>
                </div>
              </div>

              <p className="text-sm text-slate-400">
                API keys are configured as environment variables on the VPS agent server.
                {agentStatus.online ? ' Agent is running with all services connected.' : ' Start the agent to verify service connections.'}
              </p>

              <div className="space-y-3">
                {apiServices.map(service => (
                  <div key={service.name} className="flex items-center justify-between py-3 px-4 bg-slate-800/30 rounded-lg">
                    <div className="flex items-center gap-3">
                      <Key className="w-4 h-4 text-slate-500" />
                      <div>
                        <span className="text-sm text-slate-300">{service.name}</span>
                        <span className="block text-xs text-slate-600 font-mono">{service.envVar}</span>
                      </div>
                    </div>
                    <div className="flex items-center gap-1.5">
                      {agentStatus.online ? (
                        <>
                          <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                          <span className="text-xs text-emerald-400">Active</span>
                        </>
                      ) : (
                        <>
                          <AlertCircle className="w-3.5 h-3.5 text-amber-500" />
                          <span className="text-xs text-amber-500">Unknown</span>
                        </>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {activeSection === 'agent' && (
            <div className="bg-slate-900/60 border border-slate-800/60 rounded-xl p-6 space-y-5">
              <h2 className="text-lg font-semibold text-white">Agent Configuration</h2>
              <p className="text-sm text-slate-400">
                These settings control how the AI development agent operates.
              </p>
              {configLoading ? (
                <div className="flex items-center justify-center py-8">
                  <div className="w-6 h-6 border-2 border-emerald-500/30 border-t-emerald-500 rounded-full animate-spin" />
                </div>
              ) : (
                <div className="space-y-4">
                  <div>
                    <label className="block text-sm font-medium text-slate-300 mb-1.5">Default AI Model</label>
                    <select
                      value={(getValue('default_model', 'claude-sonnet-4-20250514') as string)}
                      onChange={e => handleSaveConfig('default_model', e.target.value)}
                      className="w-full bg-slate-800 border border-slate-700 rounded-lg px-4 py-2.5 text-white focus:outline-none focus:ring-2 focus:ring-emerald-500/50 focus:border-emerald-500 transition-colors"
                    >
                      {MODEL_OPTIONS.map(opt => (
                        <option key={opt.value} value={opt.value}>{opt.label}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-slate-300 mb-1.5">Auto-deploy to demo</label>
                    <select
                      value={String(getValue('auto_deploy', false))}
                      onChange={e => handleSaveConfig('auto_deploy', e.target.value === 'true')}
                      className="w-full bg-slate-800 border border-slate-700 rounded-lg px-4 py-2.5 text-white focus:outline-none focus:ring-2 focus:ring-emerald-500/50 focus:border-emerald-500 transition-colors"
                    >
                      <option value="true">Yes - Deploy after QA passes</option>
                      <option value="false">No - Wait for manual approval</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-slate-300 mb-1.5">Auto QA Screenshots</label>
                    <select
                      value={String(getValue('auto_qa', true))}
                      onChange={e => handleSaveConfig('auto_qa', e.target.value === 'true')}
                      className="w-full bg-slate-800 border border-slate-700 rounded-lg px-4 py-2.5 text-white focus:outline-none focus:ring-2 focus:ring-emerald-500/50 focus:border-emerald-500 transition-colors"
                    >
                      <option value="true">Yes - Auto capture after deploy</option>
                      <option value="false">No - Manual trigger only</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-slate-300 mb-1.5">Max auto-correction attempts</label>
                    <select
                      value={String(getValue('max_corrections', 3))}
                      onChange={e => handleSaveConfig('max_corrections', Number(e.target.value))}
                      className="w-full bg-slate-800 border border-slate-700 rounded-lg px-4 py-2.5 text-white focus:outline-none focus:ring-2 focus:ring-emerald-500/50 focus:border-emerald-500 transition-colors"
                    >
                      {CORRECTION_OPTIONS.map(opt => (
                        <option key={opt.value} value={opt.value}>{opt.label}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-slate-300 mb-1.5">Notification Email</label>
                    <input
                      type="email"
                      value={(getValue('notification_email', 'team@obzide.com') as string)}
                      onChange={e => handleSaveConfig('notification_email', e.target.value)}
                      className="w-full bg-slate-800 border border-slate-700 rounded-lg px-4 py-2.5 text-white focus:outline-none focus:ring-2 focus:ring-emerald-500/50 focus:border-emerald-500 transition-colors"
                    />
                  </div>
                </div>
              )}
            </div>
          )}

          {activeSection === 'security' && (
            <form onSubmit={handleChangePassword} className="bg-slate-900/60 border border-slate-800/60 rounded-xl p-6 space-y-5">
              <h2 className="text-lg font-semibold text-white">Change Password</h2>
              <div>
                <label className="block text-sm font-medium text-slate-300 mb-1.5">New Password</label>
                <input
                  type="password"
                  value={passwords.newPass}
                  onChange={e => setPasswords({ ...passwords, newPass: e.target.value })}
                  required
                  minLength={6}
                  className="w-full bg-slate-800 border border-slate-700 rounded-lg px-4 py-2.5 text-white focus:outline-none focus:ring-2 focus:ring-emerald-500/50 focus:border-emerald-500 transition-colors"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-300 mb-1.5">Confirm New Password</label>
                <input
                  type="password"
                  value={passwords.confirm}
                  onChange={e => setPasswords({ ...passwords, confirm: e.target.value })}
                  required
                  className="w-full bg-slate-800 border border-slate-700 rounded-lg px-4 py-2.5 text-white focus:outline-none focus:ring-2 focus:ring-emerald-500/50 focus:border-emerald-500 transition-colors"
                />
              </div>
              <div className="pt-2">
                <button type="submit" disabled={saving} className="inline-flex items-center gap-2 px-5 py-2.5 bg-gradient-to-r from-emerald-600 to-cyan-600 hover:from-emerald-500 hover:to-cyan-500 text-white text-sm font-medium rounded-lg transition-all disabled:opacity-50 active:scale-[0.97]">
                  {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Shield className="w-4 h-4" />}
                  Update Password
                </button>
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
