import { useEffect, useState } from 'react';
import { Plus, Search, Mail, Phone, Building2, MoreHorizontal, Pencil, Trash2, Loader2 } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from '../contexts/ToastContext';
import type { Client } from '../lib/types';
import Modal from '../components/Modal';
import { formatDistanceToNow } from 'date-fns';

export default function ClientsPage() {
  const { user } = useAuth();
  const toast = useToast();
  const [clients, setClients] = useState<Client[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [showModal, setShowModal] = useState(false);
  const [editing, setEditing] = useState<Client | null>(null);
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [projectCounts, setProjectCounts] = useState<Record<string, number>>({});
  const [form, setForm] = useState({
    name: '',
    contact_name: '',
    contact_email: '',
    contact_phone: '',
    industry: '',
    notes: '',
  });

  useEffect(() => {
    loadClients();
  }, []);

  async function loadClients() {
    const { data, error } = await supabase
      .from('clients')
      .select('*')
      .order('created_at', { ascending: false });
    if (error) {
      toast.error('Failed to load clients: ' + error.message);
      setLoading(false);
      return;
    }
    setClients(data || []);
    setLoading(false);

    if (data && data.length > 0) {
      const { data: projects } = await supabase.from('projects').select('client_id');
      if (projects) {
        const counts: Record<string, number> = {};
        projects.forEach(p => {
          counts[p.client_id] = (counts[p.client_id] || 0) + 1;
        });
        setProjectCounts(counts);
      }
    }
  }

  function openCreate() {
    setEditing(null);
    setForm({ name: '', contact_name: '', contact_email: '', contact_phone: '', industry: '', notes: '' });
    setShowModal(true);
  }

  function openEdit(client: Client) {
    setEditing(client);
    setForm({
      name: client.name,
      contact_name: client.contact_name,
      contact_email: client.contact_email,
      contact_phone: client.contact_phone,
      industry: client.industry,
      notes: client.notes,
    });
    setShowModal(true);
    setOpenMenu(null);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    if (editing) {
      const { error } = await supabase.from('clients').update(form).eq('id', editing.id);
      if (error) {
        toast.error('Failed to update client: ' + error.message);
        setSubmitting(false);
        return;
      }
      toast.success('Client updated');
    } else {
      const { error } = await supabase.from('clients').insert({ ...form, created_by: user?.id });
      if (error) {
        toast.error('Failed to create client: ' + error.message);
        setSubmitting(false);
        return;
      }
      toast.success('Client created');
    }
    setSubmitting(false);
    setShowModal(false);
    loadClients();
  }

  async function handleDelete(id: string) {
    if (!confirm('Delete this client? All associated projects will also be removed.')) return;
    const { error } = await supabase.from('clients').delete().eq('id', id);
    if (error) {
      toast.error('Failed to delete client: ' + error.message);
      return;
    }
    toast.success('Client deleted');
    setOpenMenu(null);
    loadClients();
  }

  const filtered = clients.filter(c =>
    c.name.toLowerCase().includes(search.toLowerCase()) ||
    c.contact_name.toLowerCase().includes(search.toLowerCase()) ||
    c.industry.toLowerCase().includes(search.toLowerCase())
  );

  if (loading) {
    return (
      <div className="animate-fade-in space-y-6">
        <div className="flex justify-between items-center">
          <div><div className="skeleton h-7 w-24 mb-2" /><div className="skeleton h-4 w-32" /></div>
          <div className="skeleton h-10 w-28 rounded-lg" />
        </div>
        <div className="skeleton h-11 rounded-lg" />
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {[1, 2, 3].map(i => <div key={i} className="skeleton h-48 rounded-xl" />)}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6 animate-fade-in">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-white">Clients</h1>
          <p className="text-slate-400 mt-1">{clients.length} total clients</p>
        </div>
        <button onClick={openCreate} className="inline-flex items-center gap-2 bg-gradient-to-r from-emerald-600 to-cyan-600 hover:from-emerald-500 hover:to-cyan-500 text-white text-sm font-medium rounded-lg px-4 py-2.5 transition-all active:scale-[0.97]">
          <Plus className="w-4 h-4" />
          Add Client
        </button>
      </div>

      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
        <input
          type="text"
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search clients..."
          className="w-full bg-slate-900/60 border border-slate-800/60 rounded-lg pl-10 pr-4 py-2.5 text-sm text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-emerald-500/50 focus:border-emerald-500 transition-colors"
        />
      </div>

      {filtered.length === 0 ? (
        <div className="bg-slate-900/40 border border-slate-800/40 border-dashed rounded-2xl p-16 text-center animate-fade-in-up">
          <div className="w-14 h-14 rounded-2xl bg-slate-800/50 flex items-center justify-center mx-auto mb-4">
            <Building2 className="w-7 h-7 text-slate-600" />
          </div>
          <p className="text-slate-300 font-medium">{search ? 'No clients match your search' : 'No clients yet'}</p>
          {!search && (
            <button onClick={openCreate} className="mt-3 text-sm text-emerald-400 hover:text-emerald-300 transition-colors">
              Add your first client
            </button>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {filtered.map((client, i) => (
            <div
              key={client.id}
              className={`bg-slate-900/60 border border-slate-800/60 rounded-xl p-5 hover:border-slate-700/60 transition-all group animate-fade-in-up stagger-${Math.min(i % 3 + 1, 5)}`}
            >
              <div className="flex items-start justify-between">
                <div className="min-w-0 flex-1">
                  <h3 className="text-sm font-semibold text-white truncate">{client.name}</h3>
                  <div className="flex items-center gap-2 mt-1.5">
                    {client.industry && (
                      <span className="inline-block text-xs text-slate-500 bg-slate-800/50 px-2 py-0.5 rounded">{client.industry}</span>
                    )}
                    {projectCounts[client.id] > 0 && (
                      <span className="text-xs text-emerald-400/70">{projectCounts[client.id]} project{projectCounts[client.id] !== 1 ? 's' : ''}</span>
                    )}
                  </div>
                </div>
                <div className="relative">
                  <button
                    onClick={() => setOpenMenu(openMenu === client.id ? null : client.id)}
                    className="text-slate-500 hover:text-slate-300 p-1 rounded opacity-0 group-hover:opacity-100 transition-all"
                  >
                    <MoreHorizontal className="w-4 h-4" />
                  </button>
                  {openMenu === client.id && (
                    <>
                      <div className="fixed inset-0 z-10" onClick={() => setOpenMenu(null)} />
                      <div className="absolute right-0 top-8 z-20 w-36 bg-slate-800 border border-slate-700 rounded-lg shadow-xl py-1 animate-scale-in">
                        <button onClick={() => openEdit(client)} className="w-full flex items-center gap-2 px-3 py-2 text-sm text-slate-300 hover:bg-slate-700/50 transition-colors">
                          <Pencil className="w-3.5 h-3.5" /> Edit
                        </button>
                        <button onClick={() => handleDelete(client.id)} className="w-full flex items-center gap-2 px-3 py-2 text-sm text-red-400 hover:bg-slate-700/50 transition-colors">
                          <Trash2 className="w-3.5 h-3.5" /> Delete
                        </button>
                      </div>
                    </>
                  )}
                </div>
              </div>

              <div className="mt-4 space-y-2">
                {client.contact_name && (
                  <p className="text-sm text-slate-300">{client.contact_name}</p>
                )}
                {client.contact_email && (
                  <div className="flex items-center gap-2 text-xs text-slate-400">
                    <Mail className="w-3.5 h-3.5 flex-shrink-0" />
                    <span className="truncate">{client.contact_email}</span>
                  </div>
                )}
                {client.contact_phone && (
                  <div className="flex items-center gap-2 text-xs text-slate-400">
                    <Phone className="w-3.5 h-3.5 flex-shrink-0" />
                    <span>{client.contact_phone}</span>
                  </div>
                )}
              </div>

              <div className="mt-4 pt-3 border-t border-slate-800/40">
                <span className="text-xs text-slate-600">
                  Added {formatDistanceToNow(new Date(client.created_at), { addSuffix: true })}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}

      <Modal open={showModal} onClose={() => setShowModal(false)} title={editing ? 'Edit Client' : 'New Client'}>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-slate-300 mb-1.5">Company / Client Name</label>
            <input
              type="text"
              value={form.name}
              onChange={e => setForm({ ...form, name: e.target.value })}
              required
              className="w-full bg-slate-800 border border-slate-700 rounded-lg px-4 py-2.5 text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-emerald-500/50 focus:border-emerald-500 transition-colors"
              placeholder="Acme Corp"
            />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-slate-300 mb-1.5">Contact Name</label>
              <input
                type="text"
                value={form.contact_name}
                onChange={e => setForm({ ...form, contact_name: e.target.value })}
                className="w-full bg-slate-800 border border-slate-700 rounded-lg px-4 py-2.5 text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-emerald-500/50 focus:border-emerald-500 transition-colors"
                placeholder="John Doe"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-300 mb-1.5">Industry</label>
              <input
                type="text"
                value={form.industry}
                onChange={e => setForm({ ...form, industry: e.target.value })}
                className="w-full bg-slate-800 border border-slate-700 rounded-lg px-4 py-2.5 text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-emerald-500/50 focus:border-emerald-500 transition-colors"
                placeholder="Real Estate"
              />
            </div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-slate-300 mb-1.5">Email</label>
              <input
                type="email"
                value={form.contact_email}
                onChange={e => setForm({ ...form, contact_email: e.target.value })}
                className="w-full bg-slate-800 border border-slate-700 rounded-lg px-4 py-2.5 text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-emerald-500/50 focus:border-emerald-500 transition-colors"
                placeholder="john@acme.com"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-300 mb-1.5">Phone</label>
              <input
                type="tel"
                value={form.contact_phone}
                onChange={e => setForm({ ...form, contact_phone: e.target.value })}
                className="w-full bg-slate-800 border border-slate-700 rounded-lg px-4 py-2.5 text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-emerald-500/50 focus:border-emerald-500 transition-colors"
                placeholder="+507 6000-0000"
              />
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-300 mb-1.5">Notes</label>
            <textarea
              value={form.notes}
              onChange={e => setForm({ ...form, notes: e.target.value })}
              rows={3}
              className="w-full bg-slate-800 border border-slate-700 rounded-lg px-4 py-2.5 text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-emerald-500/50 focus:border-emerald-500 transition-colors resize-none"
              placeholder="Additional notes about this client..."
            />
          </div>
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
              {editing ? 'Update' : 'Create'}
            </button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
