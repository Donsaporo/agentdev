import { useEffect, useState } from 'react';
import { Plus, Search, Globe, Shield, Server, ExternalLink, Loader2 } from 'lucide-react';
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
          <div className="skeleton h-10 w-32 rounded-lg" />
        </div>
        <div className="skeleton h-11 rounded-lg" />
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {[1, 2, 3].map(i => <div key={i} className="skeleton h-44 rounded-xl" />)}
        </div>
      </div>
    );
  }

  function DomainCard({ domain }: { domain: Domain }) {
    return (
      <div className="bg-slate-900/60 border border-slate-800/60 rounded-xl p-5 hover:border-slate-700/60 transition-colors">
        <div className="flex items-start justify-between mb-3">
          <div className="flex items-center gap-2">
            <Globe className="w-4 h-4 text-emerald-400" />
            <a
              href={`https://${domain.domain_name}`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm font-semibold text-white hover:text-emerald-400 transition-colors flex items-center gap-1"
            >
              {domain.domain_name}
              <ExternalLink className="w-3 h-3" />
            </a>
          </div>
          {domain.is_demo && (
            <span className="text-xs bg-cyan-500/10 text-cyan-400 px-2 py-0.5 rounded ring-1 ring-cyan-500/20">Demo</span>
          )}
        </div>

        <div className="space-y-2">
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

        <div className="mt-3 pt-3 border-t border-slate-800/40 flex items-center justify-between">
          <span className="text-xs text-slate-600 capitalize">{domain.registrar}</span>
          <span className="text-xs text-slate-600">{formatDistanceToNow(new Date(domain.created_at), { addSuffix: true })}</span>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6 animate-fade-in">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-white">Domains</h1>
          <p className="text-slate-400 mt-1">{domains.length} domains managed</p>
        </div>
        <button onClick={() => setShowModal(true)} className="inline-flex items-center gap-2 bg-gradient-to-r from-emerald-600 to-cyan-600 hover:from-emerald-500 hover:to-cyan-500 text-white text-sm font-medium rounded-lg px-4 py-2.5 transition-all active:scale-[0.97]">
          <Plus className="w-4 h-4" />
          Add Domain
        </button>
      </div>

      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
        <input
          type="text"
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search domains..."
          className="w-full bg-slate-900/60 border border-slate-800/60 rounded-lg pl-10 pr-4 py-2.5 text-sm text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-emerald-500/50 focus:border-emerald-500 transition-colors"
        />
      </div>

      {filtered.length === 0 ? (
        <div className="bg-slate-900/40 border border-slate-800/40 border-dashed rounded-2xl p-16 text-center animate-fade-in-up">
          <div className="w-14 h-14 rounded-2xl bg-slate-800/50 flex items-center justify-center mx-auto mb-4">
            <Globe className="w-7 h-7 text-slate-600" />
          </div>
          <p className="text-slate-300 font-medium">No domains configured yet</p>
          <button onClick={() => setShowModal(true)} className="mt-3 text-sm text-emerald-400 hover:text-emerald-300 transition-colors">
            Add your first domain
          </button>
        </div>
      ) : (
        <div className="space-y-6">
          {demoDomains.length > 0 && (
            <div>
              <h2 className="text-sm font-semibold text-slate-400 mb-3">Demo Subdomains (*.obzide.com)</h2>
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                {demoDomains.map(d => <DomainCard key={d.id} domain={d} />)}
              </div>
            </div>
          )}
          {productionDomains.length > 0 && (
            <div>
              <h2 className="text-sm font-semibold text-slate-400 mb-3">Production Domains</h2>
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
            <select
              value={form.client_id}
              onChange={e => setForm({ ...form, client_id: e.target.value })}
              required
              className="w-full bg-slate-800 border border-slate-700 rounded-lg px-4 py-2.5 text-white focus:outline-none focus:ring-2 focus:ring-emerald-500/50 focus:border-emerald-500 transition-colors"
            >
              <option value="">Select client</option>
              {clients.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-300 mb-1.5">Project (optional)</label>
            <select
              value={form.project_id}
              onChange={e => setForm({ ...form, project_id: e.target.value })}
              className="w-full bg-slate-800 border border-slate-700 rounded-lg px-4 py-2.5 text-white focus:outline-none focus:ring-2 focus:ring-emerald-500/50 focus:border-emerald-500 transition-colors"
            >
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
                className={`flex-1 px-4 py-3 rounded-lg border text-sm font-medium transition-all ${form.is_demo ? 'border-emerald-500 bg-emerald-500/10 text-emerald-400' : 'border-slate-700 text-slate-400 hover:border-slate-600'}`}
              >
                Demo (*.obzide.com)
              </button>
              <button
                type="button"
                onClick={() => setForm({ ...form, is_demo: false })}
                className={`flex-1 px-4 py-3 rounded-lg border text-sm font-medium transition-all ${!form.is_demo ? 'border-emerald-500 bg-emerald-500/10 text-emerald-400' : 'border-slate-700 text-slate-400 hover:border-slate-600'}`}
              >
                Production
              </button>
            </div>
          </div>
          {form.is_demo ? (
            <div>
              <label className="block text-sm font-medium text-slate-300 mb-1.5">Subdomain</label>
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={form.subdomain}
                  onChange={e => setForm({ ...form, subdomain: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '') })}
                  required
                  className="flex-1 bg-slate-800 border border-slate-700 rounded-lg px-4 py-2.5 text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-emerald-500/50 focus:border-emerald-500 transition-colors"
                  placeholder="clientname"
                />
                <span className="text-sm text-slate-500">.obzide.com</span>
              </div>
            </div>
          ) : (
            <div>
              <label className="block text-sm font-medium text-slate-300 mb-1.5">Domain Name</label>
              <input
                type="text"
                value={form.domain_name}
                onChange={e => setForm({ ...form, domain_name: e.target.value })}
                required
                className="w-full bg-slate-800 border border-slate-700 rounded-lg px-4 py-2.5 text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-emerald-500/50 focus:border-emerald-500 transition-colors"
                placeholder="example.com"
              />
            </div>
          )}
          <div className="flex justify-end gap-3 pt-2">
            <button type="button" onClick={() => setShowModal(false)} className="px-4 py-2.5 text-sm text-slate-400 hover:text-slate-200 transition-colors">
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="inline-flex items-center gap-2 px-6 py-2.5 bg-gradient-to-r from-emerald-600 to-cyan-600 hover:from-emerald-500 hover:to-cyan-500 text-white text-sm font-medium rounded-lg transition-all disabled:opacity-50 active:scale-[0.97]"
            >
              {submitting && <Loader2 className="w-4 h-4 animate-spin" />}
              Add Domain
            </button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
