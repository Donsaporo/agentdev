import { useEffect, useState } from 'react';
import { Plus, Search, Globe, Shield, Server, ExternalLink, Loader2, Trash2 } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useToast } from '../contexts/ToastContext';
import type { Domain, Client, Project } from '../lib/types';
import Modal from '../components/Modal';
import StatusBadge from '../components/StatusBadge';
import { formatDistanceToNow } from 'date-fns';

export default function DomainsPage() {
  const toast = useToast();
  const [domains, setDomains] = useState<Domain[]>([]);
  const [clients, setClients] = useState<Client[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [showModal, setShowModal] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [form, setForm] = useState({
    client_id: '',
    project_id: '',
    domain_name: '',
    subdomain: '',
    is_demo: true,
    registrar: 'namecheap',
  });

  useEffect(() => {
    loadData();
  }, []);

  async function loadData() {
    const [domRes, clientRes, projRes] = await Promise.all([
      supabase.from('domains').select('*, clients(name), projects(name)').order('created_at', { ascending: false }),
      supabase.from('clients').select('*').order('name'),
      supabase.from('projects').select('*').order('name'),
    ]);
    if (domRes.error) toast.error('Failed to load domains: ' + domRes.error.message);
    setDomains(domRes.data || []);
    setClients(clientRes.data || []);
    setProjects(projRes.data || []);
    setLoading(false);
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    const data: Record<string, unknown> = {
      client_id: form.client_id,
      domain_name: form.is_demo ? `${form.subdomain}.obzide.com` : form.domain_name,
      subdomain: form.is_demo ? form.subdomain : '',
      is_demo: form.is_demo,
      registrar: form.registrar,
    };
    if (form.project_id) data.project_id = form.project_id;
    const { error } = await supabase.from('domains').insert(data);
    if (error) {
      toast.error('Failed to add domain: ' + error.message);
      setSubmitting(false);
      return;
    }
    toast.success('Domain added');
    setSubmitting(false);
    setShowModal(false);
    setForm({ client_id: '', project_id: '', domain_name: '', subdomain: '', is_demo: true, registrar: 'namecheap' });
    loadData();
  }

  async function handleDelete(id: string) {
    if (!confirm('Delete this domain?')) return;
    const { error } = await supabase.from('domains').delete().eq('id', id);
    if (error) {
      toast.error('Failed to delete domain: ' + error.message);
      return;
    }
    toast.success('Domain deleted');
    loadData();
  }

  const filtered = domains.filter(d =>
    d.domain_name.toLowerCase().includes(search.toLowerCase()) ||
    d.clients?.name?.toLowerCase().includes(search.toLowerCase())
  );

  const demoDomains = filtered.filter(d => d.is_demo);
  const productionDomains = filtered.filter(d => !d.is_demo);

  if (loading) {
    return (
      <div className="animate-fade-in space-y-6">
        <div className="flex justify-between items-center">
          <div><div className="skeleton h-7 w-24 mb-2" /><div className="skeleton h-4 w-36" /></div>
          <div className="skeleton h-10 w-32 rounded-xl" />
        </div>
        <div className="skeleton h-11 rounded-xl" />
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {[1, 2, 3].map(i => <div key={i} className="skeleton h-44 rounded-2xl" />)}
        </div>
      </div>
    );
  }

  function DomainCard({ domain }: { domain: Domain }) {
    return (
      <div className="glass-card-hover p-5 group">
        <div className="flex items-start justify-between mb-3">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-emerald-500/10 flex items-center justify-center">
              <Globe className="w-4 h-4 text-emerald-400" />
            </div>
            <a
              href={`https://${domain.domain_name}`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm font-semibold text-white hover:text-emerald-400 transition-colors flex items-center gap-1.5"
            >
              {domain.domain_name}
              <ExternalLink className="w-3 h-3 opacity-50" />
            </a>
          </div>
          <div className="flex items-center gap-2">
            {domain.is_demo && (
              <span className="text-[11px] font-medium bg-teal-500/10 text-teal-400 px-2 py-0.5 rounded-md ring-1 ring-teal-500/15">Demo</span>
            )}
            <button
              onClick={() => handleDelete(domain.id)}
              className="text-slate-600 hover:text-red-400 p-1 rounded-lg opacity-0 group-hover:opacity-100 hover:bg-white/[0.04] transition-all"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        <div className="space-y-2.5 mt-4">
          <div className="flex items-center justify-between text-xs">
            <span className="text-slate-500">Client</span>
            <span className="text-slate-300">{domain.clients?.name || '-'}</span>
          </div>
          {domain.projects?.name && (
            <div className="flex items-center justify-between text-xs">
              <span className="text-slate-500">Project</span>
              <span className="text-slate-300">{domain.projects.name}</span>
            </div>
          )}
          <div className="flex items-center justify-between text-xs">
            <span className="text-slate-500 flex items-center gap-1"><Server className="w-3 h-3" /> DNS</span>
            <StatusBadge status={domain.dns_status} />
          </div>
          <div className="flex items-center justify-between text-xs">
            <span className="text-slate-500 flex items-center gap-1"><Shield className="w-3 h-3" /> SSL</span>
            <StatusBadge status={domain.ssl_status} />
          </div>
        </div>

        <div className="mt-4 pt-3 border-t border-white/[0.04] flex items-center justify-between">
          <span className="text-[11px] text-slate-600 capitalize">{domain.registrar}</span>
          <span className="text-[11px] text-slate-600">{formatDistanceToNow(new Date(domain.created_at), { addSuffix: true })}</span>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6 animate-fade-in">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-white tracking-tight">Domains</h1>
          <p className="text-slate-400 mt-1 text-sm">{domains.length} domains managed</p>
        </div>
        <button onClick={() => setShowModal(true)} className="btn-primary">
          <Plus className="w-4 h-4" />
          Add Domain
        </button>
      </div>

      <div className="relative">
        <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
        <input type="text" value={search} onChange={e => setSearch(e.target.value)} placeholder="Search domains..." className="w-full glass-input pl-10" />
      </div>

      {filtered.length === 0 ? (
        <div className="glass-card p-16 text-center border-dashed animate-fade-in-up">
          <div className="w-14 h-14 rounded-2xl bg-white/[0.04] flex items-center justify-center mx-auto mb-4">
            <Globe className="w-7 h-7 text-slate-600" />
          </div>
          <p className="text-slate-300 font-medium">No domains configured yet</p>
          <button onClick={() => setShowModal(true)} className="mt-3 text-sm text-emerald-400 hover:text-emerald-300 transition-colors">Add your first domain</button>
        </div>
      ) : (
        <div className="space-y-8">
          {demoDomains.length > 0 && (
            <div>
              <h2 className="text-[13px] font-semibold text-slate-400 mb-3 uppercase tracking-wider">Demo Subdomains (*.obzide.com)</h2>
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                {demoDomains.map(d => <DomainCard key={d.id} domain={d} />)}
              </div>
            </div>
          )}
          {productionDomains.length > 0 && (
            <div>
              <h2 className="text-[13px] font-semibold text-slate-400 mb-3 uppercase tracking-wider">Production Domains</h2>
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                {productionDomains.map(d => <DomainCard key={d.id} domain={d} />)}
              </div>
            </div>
          )}
        </div>
      )}

      <Modal open={showModal} onClose={() => setShowModal(false)} title="Add Domain">
        <form onSubmit={handleCreate} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-slate-300 mb-1.5">Client</label>
            <select value={form.client_id} onChange={e => setForm({ ...form, client_id: e.target.value })} required className="w-full glass-select">
              <option value="">Select client</option>
              {clients.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-300 mb-1.5">Project (optional)</label>
            <select value={form.project_id} onChange={e => setForm({ ...form, project_id: e.target.value })} className="w-full glass-select">
              <option value="">None</option>
              {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-300 mb-3">Domain Type</label>
            <div className="flex gap-3">
              <button
                type="button"
                onClick={() => setForm({ ...form, is_demo: true })}
                className={`flex-1 px-4 py-3 rounded-xl border text-sm font-medium transition-all ${form.is_demo ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-400' : 'border-white/[0.06] text-slate-400 hover:border-white/[0.1]'}`}
              >
                Demo (*.obzide.com)
              </button>
              <button
                type="button"
                onClick={() => setForm({ ...form, is_demo: false })}
                className={`flex-1 px-4 py-3 rounded-xl border text-sm font-medium transition-all ${!form.is_demo ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-400' : 'border-white/[0.06] text-slate-400 hover:border-white/[0.1]'}`}
              >
                Production
              </button>
            </div>
          </div>
          {form.is_demo ? (
            <div>
              <label className="block text-sm font-medium text-slate-300 mb-1.5">Subdomain</label>
              <div className="flex items-center gap-2">
                <input type="text" value={form.subdomain} onChange={e => setForm({ ...form, subdomain: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '') })} required className="flex-1 glass-input" placeholder="clientname" />
                <span className="text-sm text-slate-500">.obzide.com</span>
              </div>
            </div>
          ) : (
            <div>
              <label className="block text-sm font-medium text-slate-300 mb-1.5">Domain Name</label>
              <input type="text" value={form.domain_name} onChange={e => setForm({ ...form, domain_name: e.target.value })} required className="w-full glass-input" placeholder="example.com" />
            </div>
          )}
          <div className="flex justify-end gap-3 pt-2">
            <button type="button" onClick={() => setShowModal(false)} className="btn-ghost">Cancel</button>
            <button type="submit" disabled={submitting} className="btn-primary disabled:opacity-50">
              {submitting && <Loader2 className="w-4 h-4 animate-spin" />}
              Add Domain
            </button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
