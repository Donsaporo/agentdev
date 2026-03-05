import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { FileText, Search, MessageSquareMore, Send, Rocket, Loader2 } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useToast } from '../contexts/ToastContext';
import type { Brief, Project, Client } from '../lib/types';
import Modal from '../components/Modal';
import StatusBadge from '../components/StatusBadge';
import { formatDistanceToNow } from 'date-fns';
import BriefWizard, { type BriefFormData } from './briefs/BriefWizard';

export default function BriefsPage() {
  const toast = useToast();
  const [briefs, setBriefs] = useState<(Brief & { projects: Project & { clients: Client } })[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [showModal, setShowModal] = useState(false);
  const [sendingId, setSendingId] = useState<string | null>(null);

  useEffect(() => {
    loadData();
  }, []);

  async function loadData() {
    const [briefsRes, projRes] = await Promise.all([
      supabase.from('briefs').select('*, projects(*, clients(name))').order('created_at', { ascending: false }),
      supabase.from('projects').select('*').order('name'),
    ]);
    if (briefsRes.error) toast.error('Failed to load briefs: ' + briefsRes.error.message);
    setBriefs((briefsRes.data || []) as never[]);
    setProjects(projRes.data || []);
    setLoading(false);
  }

  async function handleCreate(data: BriefFormData) {
    const { data: brief, error } = await supabase.from('briefs').insert({
      project_id: data.project_id,
      original_content: data.original_content,
      pages_screens: [],
      features: [],
    }).select('id').maybeSingle();

    if (error || !brief) {
      toast.error('Failed to submit brief: ' + (error?.message || 'Unknown error'));
      return;
    }

    if (data.attachment_urls.length > 0) {
      const attachments = data.attachment_urls.map(url => {
        const name = decodeURIComponent(url.split('/').pop() || 'file').replace(/^\d+-/, '');
        const ext = name.split('.').pop()?.toLowerCase() || '';
        let fileType = 'document';
        if (['pdf'].includes(ext)) fileType = 'pdf';
        else if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(ext)) fileType = 'image';
        else if (['xlsx', 'xls', 'csv'].includes(ext)) fileType = 'spreadsheet';
        return {
          brief_id: brief.id,
          file_name: name,
          file_url: url,
          file_type: fileType,
          file_size: 0,
        };
      });
      await supabase.from('brief_attachments').insert(attachments);
    }

    setShowModal(false);
    await handleSendToAgent(brief.id, data.project_id);
  }

  async function handleSendToAgent(briefId: string, projectId: string) {
    setSendingId(briefId);
    const { error: updateError } = await supabase.from('briefs').update({ status: 'in_progress' }).eq('id', briefId);
    if (updateError) {
      toast.error('Failed to send brief: ' + updateError.message);
      setSendingId(null);
      return;
    }

    const { data: existingConv } = await supabase
      .from('agent_conversations')
      .select('id')
      .eq('project_id', projectId)
      .eq('status', 'active')
      .maybeSingle();

    let conversationId = existingConv?.id;
    if (!conversationId) {
      const { data: newConv } = await supabase
        .from('agent_conversations')
        .insert({ project_id: projectId, title: 'Brief Processing' })
        .select('id')
        .maybeSingle();
      conversationId = newConv?.id;
    }

    if (conversationId) {
      await supabase.from('agent_messages').insert({
        conversation_id: conversationId,
        role: 'system',
        content: 'Brief approved and sent for processing. Starting development pipeline.',
      });
    }

    toast.success('Brief sent to agent');
    setSendingId(null);
    loadData();
  }

  const filtered = briefs.filter(b =>
    b.projects?.name?.toLowerCase().includes(search.toLowerCase()) ||
    b.original_content?.toLowerCase().includes(search.toLowerCase())
  );

  if (loading) {
    return (
      <div className="animate-fade-in space-y-6">
        <div className="flex justify-between items-center">
          <div><div className="skeleton h-7 w-20 mb-2" /><div className="skeleton h-4 w-44" /></div>
          <div className="skeleton h-10 w-32 rounded-lg" />
        </div>
        <div className="skeleton h-11 rounded-lg" />
        <div className="space-y-3">
          {[1, 2, 3].map(i => <div key={i} className="skeleton h-32 rounded-xl" />)}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6 animate-fade-in">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-white">Briefs</h1>
          <p className="text-slate-400 mt-1">Client requirements and project briefs</p>
        </div>
        <button onClick={() => setShowModal(true)} className="inline-flex items-center gap-2 bg-gradient-to-r from-emerald-600 to-cyan-600 hover:from-emerald-500 hover:to-cyan-500 text-white text-sm font-medium rounded-lg px-4 py-2.5 transition-all active:scale-[0.97]">
          <Send className="w-4 h-4" />
          Submit Brief
        </button>
      </div>

      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
        <input
          type="text"
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search briefs..."
          className="w-full bg-slate-900/60 border border-slate-800/60 rounded-lg pl-10 pr-4 py-2.5 text-sm text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-emerald-500/50 focus:border-emerald-500 transition-colors"
        />
      </div>

      {filtered.length === 0 ? (
        <div className="bg-slate-900/40 border border-slate-800/40 border-dashed rounded-2xl p-16 text-center animate-fade-in-up">
          <div className="w-14 h-14 rounded-2xl bg-slate-800/50 flex items-center justify-center mx-auto mb-4">
            <FileText className="w-7 h-7 text-slate-600" />
          </div>
          <p className="text-slate-300 font-medium">No briefs submitted yet</p>
          <button onClick={() => setShowModal(true)} className="mt-3 text-sm text-emerald-400 hover:text-emerald-300 transition-colors">
            Submit your first brief
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          {filtered.map((brief, i) => (
            <div
              key={brief.id}
              className={`bg-slate-900/60 border border-slate-800/60 rounded-xl p-5 hover:border-slate-700/60 transition-all animate-fade-in-up stagger-${Math.min(i % 4 + 1, 5)}`}
            >
              <div className="flex items-start justify-between gap-4">
                <Link to={`/projects/${brief.project_id}`} className="min-w-0 flex-1">
                  <div className="flex items-center gap-3 mb-1.5">
                    <h3 className="text-sm font-semibold text-white truncate">{brief.projects?.name || 'Unlinked Brief'}</h3>
                    <StatusBadge status={brief.status} />
                  </div>
                  <p className="text-sm text-slate-400 line-clamp-2">{brief.original_content || 'No content'}</p>
                  <div className="flex items-center gap-4 mt-3">
                    <span className="text-xs text-slate-500">{brief.projects?.clients?.name}</span>
                    {brief.pages_screens.length > 0 && (
                      <span className="text-xs text-slate-500">{brief.pages_screens.length} pages</span>
                    )}
                    {brief.features.length > 0 && (
                      <span className="text-xs text-slate-500">{brief.features.length} features</span>
                    )}
                    {brief.questions.length > 0 && (
                      <span className="inline-flex items-center gap-1 text-xs text-amber-400">
                        <MessageSquareMore className="w-3 h-3" />
                        {brief.questions.filter(q => !q.answered).length} questions
                      </span>
                    )}
                    <span className="text-xs text-slate-600">
                      {formatDistanceToNow(new Date(brief.created_at), { addSuffix: true })}
                    </span>
                  </div>
                </Link>
                {(brief.status === 'approved' || brief.status === 'pending_review') && (
                  <button
                    onClick={() => handleSendToAgent(brief.id, brief.project_id)}
                    disabled={sendingId === brief.id}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-emerald-500/10 text-emerald-400 text-xs font-medium rounded-lg hover:bg-emerald-500/20 transition-colors flex-shrink-0 disabled:opacity-50"
                  >
                    {sendingId === brief.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Rocket className="w-3.5 h-3.5" />}
                    Send to Agent
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      <Modal open={showModal} onClose={() => setShowModal(false)} title="Submit Brief" maxWidth="max-w-3xl">
        <BriefWizard
          projects={projects}
          onSubmit={handleCreate}
          onClose={() => setShowModal(false)}
        />
      </Modal>
    </div>
  );
}
