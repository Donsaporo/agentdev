import { useEffect, useState } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import {
  ArrowLeft, ExternalLink, GitBranch, Globe, Pencil, Trash2,
  CheckCircle2, Circle, AlertCircle, Clock, Loader2, MessageSquare, Save,
  Layout, Palette, Type, Puzzle, Layers,
} from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useToast } from '../contexts/ToastContext';
import type { Project, ProjectTask, Integration, Brief } from '../lib/types';
import StatusBadge from '../components/StatusBadge';
import AgentStatusIndicator from '../components/AgentStatusIndicator';
import PhaseIndicator from '../components/PhaseIndicator';
import Modal from '../components/Modal';
import { useRealtimeSubscription } from '../hooks/useRealtimeSubscription';
import { formatDistanceToNow } from 'date-fns';

export default function ProjectDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const toast = useToast();
  const [project, setProject] = useState<Project | null>(null);
  const [tasks, setTasks] = useState<ProjectTask[]>([]);
  const [integrations, setIntegrations] = useState<Integration[]>([]);
  const [brief, setBrief] = useState<Brief | null>(null);
  const [loading, setLoading] = useState(true);
  const [showEdit, setShowEdit] = useState(false);
  const [editForm, setEditForm] = useState({ name: '', description: '', demo_url: '', production_url: '' });
  const [editSaving, setEditSaving] = useState(false);

  useEffect(() => {
    if (id) loadProject(id);
  }, [id]);

  async function loadProject(projectId: string) {
    const [projRes, tasksRes, intRes, briefRes] = await Promise.all([
      supabase.from('projects').select('*, clients(name, contact_email)').eq('id', projectId).maybeSingle(),
      supabase.from('project_tasks').select('*').eq('project_id', projectId).order('order_index'),
      supabase.from('integrations').select('*').eq('project_id', projectId).order('created_at'),
      supabase.from('briefs').select('*').eq('project_id', projectId).order('created_at', { ascending: false }).maybeSingle(),
    ]);
    setProject(projRes.data);
    setTasks(tasksRes.data || []);
    setIntegrations(intRes.data || []);
    setBrief(briefRes.data);
    setLoading(false);
  }

  useRealtimeSubscription({
    table: 'project_tasks',
    event: '*',
    filter: id ? `project_id=eq.${id}` : undefined,
    onChange: () => {
      if (id) {
        supabase.from('project_tasks').select('*').eq('project_id', id).order('order_index').then(({ data }) => {
          setTasks(data || []);
        });
      }
    },
    enabled: !!id && !loading,
  });

  useRealtimeSubscription({
    table: 'projects',
    event: 'UPDATE',
    filter: id ? `id=eq.${id}` : undefined,
    onUpdate: (payload) => {
      const updated = payload.new as unknown as Project;
      setProject(prev => prev ? { ...prev, ...updated } : null);
    },
    enabled: !!id && !loading,
  });

  function openEdit() {
    if (!project) return;
    setEditForm({ name: project.name, description: project.description || '', demo_url: project.demo_url || '', production_url: project.production_url || '' });
    setShowEdit(true);
  }

  async function handleSaveEdit(e: React.FormEvent) {
    e.preventDefault();
    if (!project) return;
    setEditSaving(true);
    const { error } = await supabase.from('projects').update({
      name: editForm.name,
      description: editForm.description,
      demo_url: editForm.demo_url,
      production_url: editForm.production_url,
    }).eq('id', project.id);
    setEditSaving(false);
    if (error) {
      toast.error('Failed to update: ' + error.message);
      return;
    }
    setProject(prev => prev ? { ...prev, ...editForm } : null);
    toast.success('Project updated');
    setShowEdit(false);
  }

  async function handleAnswerQuestion(briefId: string, questionId: string, answer: string) {
    if (!brief) return;
    const updatedQuestions = brief.questions.map(q => q.id === questionId ? { ...q, answered: true } : q);
    const updatedAnswers = [...(brief.answers || []), { question_id: questionId, answer, answered_by: 'team', answered_at: new Date().toISOString() }];
    const allAnswered = updatedQuestions.every(q => q.answered);
    const { error } = await supabase.from('briefs').update({
      questions: updatedQuestions,
      answers: updatedAnswers,
      status: allAnswered ? 'approved' : 'questions_pending',
    }).eq('id', briefId);
    if (error) {
      toast.error('Failed to save answer');
      return;
    }
    setBrief(prev => prev ? { ...prev, questions: updatedQuestions, answers: updatedAnswers, status: allAnswered ? 'approved' : 'questions_pending' } : null);
    toast.success(allAnswered ? 'All questions answered -- brief ready to send to agent' : 'Answer saved');
  }

  async function handleDelete() {
    if (!confirm('Delete this project and all its data?')) return;
    const { error } = await supabase.from('projects').delete().eq('id', id!);
    if (error) {
      toast.error('Failed to delete project: ' + error.message);
      return;
    }
    toast.success('Project deleted');
    navigate('/projects');
  }

  const taskIcon: Record<string, JSX.Element> = {
    pending: <Circle className="w-4 h-4 text-slate-500" />,
    in_progress: <Loader2 className="w-4 h-4 text-amber-400 animate-spin" />,
    completed: <CheckCircle2 className="w-4 h-4 text-emerald-400" />,
    failed: <AlertCircle className="w-4 h-4 text-red-400" />,
    blocked: <AlertCircle className="w-4 h-4 text-rose-400" />,
  };

  if (loading) {
    return (
      <div className="animate-fade-in space-y-6">
        <div className="flex items-center gap-3">
          <div className="skeleton w-5 h-5 rounded" />
          <div className="flex-1"><div className="skeleton h-7 w-48 mb-2" /><div className="skeleton h-4 w-64" /></div>
        </div>
        <div className="skeleton h-16 rounded-xl" />
        <div className="grid grid-cols-3 gap-4">
          {[1, 2, 3].map(i => <div key={i} className="skeleton h-20 rounded-xl" />)}
        </div>
        <div className="skeleton h-32 rounded-xl" />
        <div className="skeleton h-48 rounded-xl" />
      </div>
    );
  }

  if (!project) {
    return (
      <div className="text-center py-16">
        <p className="text-slate-400">Project not found</p>
        <Link to="/projects" className="text-emerald-400 text-sm mt-2 inline-block">Back to projects</Link>
      </div>
    );
  }

  const completedTasks = tasks.filter(t => t.status === 'completed').length;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Link to="/projects" className="text-slate-400 hover:text-slate-200 transition-colors">
          <ArrowLeft className="w-5 h-5" />
        </Link>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-3 flex-wrap">
            <h1 className="text-2xl font-bold text-white truncate">{project.name}</h1>
            <StatusBadge status={project.status} size="md" />
            <AgentStatusIndicator status={project.agent_status} showLabel />
          </div>
          <p className="text-sm text-slate-400 mt-1">
            {project.clients?.name} &middot; {project.type.replace('_', ' ')} &middot; Updated {formatDistanceToNow(new Date(project.updated_at), { addSuffix: true })}
          </p>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <Link
            to={`/chat/${project.id}`}
            className="p-2 text-slate-400 hover:text-emerald-400 hover:bg-slate-800/50 rounded-lg transition-all"
            title="Chat with Agent"
          >
            <MessageSquare className="w-4 h-4" />
          </Link>
          <button onClick={openEdit} className="p-2 text-slate-400 hover:text-slate-200 hover:bg-slate-800/50 rounded-lg transition-all">
            <Pencil className="w-4 h-4" />
          </button>
          <button onClick={handleDelete} className="p-2 text-slate-400 hover:text-red-400 hover:bg-slate-800/50 rounded-lg transition-all">
            <Trash2 className="w-4 h-4" />
          </button>
        </div>
      </div>

      <div className="bg-slate-900/60 border border-slate-800/60 rounded-xl p-4">
        <PhaseIndicator currentPhase={project.current_phase} />
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="bg-slate-900/60 border border-slate-800/60 rounded-xl p-4">
          <p className="text-xs text-slate-500 mb-1">Progress</p>
          <div className="flex items-center gap-3">
            <div className="flex-1 h-2 bg-slate-800 rounded-full overflow-hidden">
              <div className="h-full bg-gradient-to-r from-emerald-500 to-cyan-500 rounded-full transition-all" style={{ width: `${project.progress}%` }} />
            </div>
            <span className="text-lg font-bold text-white">{project.progress}%</span>
          </div>
        </div>
        <div className="bg-slate-900/60 border border-slate-800/60 rounded-xl p-4">
          <p className="text-xs text-slate-500 mb-1">Tasks</p>
          <p className="text-lg font-bold text-white">{completedTasks} <span className="text-sm font-normal text-slate-500">/ {tasks.length}</span></p>
        </div>
        <div className="bg-slate-900/60 border border-slate-800/60 rounded-xl p-4">
          <p className="text-xs text-slate-500 mb-1">Integrations</p>
          <p className="text-lg font-bold text-white">{integrations.length}</p>
        </div>
      </div>

      <div className="flex flex-wrap gap-3">
        {project.demo_url && (
          <a href={project.demo_url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-2 text-sm text-emerald-400 bg-emerald-500/10 px-3 py-1.5 rounded-lg hover:bg-emerald-500/20 transition-colors">
            <ExternalLink className="w-3.5 h-3.5" /> Demo
          </a>
        )}
        {project.production_url && (
          <a href={project.production_url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-2 text-sm text-cyan-400 bg-cyan-500/10 px-3 py-1.5 rounded-lg hover:bg-cyan-500/20 transition-colors">
            <Globe className="w-3.5 h-3.5" /> Production
          </a>
        )}
        {project.git_repo_url && (
          <a href={project.git_repo_url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-2 text-sm text-slate-400 bg-slate-800/50 px-3 py-1.5 rounded-lg hover:bg-slate-800 transition-colors">
            <GitBranch className="w-3.5 h-3.5" /> Repository
          </a>
        )}
      </div>

      {project.description && (
        <div className="bg-slate-900/60 border border-slate-800/60 rounded-xl p-5">
          <h2 className="text-sm font-semibold text-white mb-2">Description</h2>
          <p className="text-sm text-slate-300 leading-relaxed whitespace-pre-wrap">{project.description}</p>
        </div>
      )}

      {brief && (
        <div className="bg-slate-900/60 border border-slate-800/60 rounded-xl p-5">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold text-white">Brief</h2>
            <StatusBadge status={brief.status} />
          </div>
          {brief.original_content && (
            <p className="text-sm text-slate-300 leading-relaxed whitespace-pre-wrap line-clamp-6">{brief.original_content}</p>
          )}
          {brief.pages_screens.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-1">
              {brief.pages_screens.map((p, i) => (
                <span key={i} className="text-xs px-2 py-0.5 bg-slate-800 text-slate-400 rounded">{p}</span>
              ))}
            </div>
          )}
          {brief.questions.length > 0 && (
            <BriefQuestionsUI brief={brief} onAnswer={(qId, answer) => handleAnswerQuestion(brief.id, qId, answer)} />
          )}
        </div>
      )}

      {brief?.architecture_plan && Object.keys(brief.architecture_plan).length > 0 && (
        <ArchitecturePlanDisplay architecture={brief.architecture_plan} />
      )}

      <div className="bg-slate-900/60 border border-slate-800/60 rounded-xl">
        <div className="px-5 py-4 border-b border-slate-800/40">
          <h2 className="text-sm font-semibold text-white">Tasks ({tasks.length})</h2>
        </div>
        {tasks.length === 0 ? (
          <div className="p-8 text-center text-sm text-slate-500">No tasks yet. The agent will create tasks when processing the brief.</div>
        ) : (
          <div className="divide-y divide-slate-800/40">
            {tasks.map(task => (
              <div key={task.id} className="flex items-start gap-3 px-5 py-3.5">
                <div className="mt-0.5">{taskIcon[task.status] || taskIcon.pending}</div>
                <div className="min-w-0 flex-1">
                  <p className={`text-sm ${task.status === 'completed' ? 'text-slate-500 line-through' : 'text-slate-200'}`}>{task.title}</p>
                  {task.description && <p className="text-xs text-slate-500 mt-0.5 truncate">{task.description}</p>}
                  {task.error_log && <p className="text-xs text-red-400 mt-1 font-mono">{task.error_log}</p>}
                </div>
                <div className="flex items-center gap-2 flex-shrink-0">
                  <StatusBadge status={task.status} />
                  {task.duration_seconds > 0 && (
                    <span className="text-xs text-slate-600">{Math.round(task.duration_seconds / 60)}m</span>
                  )}
                  {task.completed_at && (
                    <span className="text-xs text-slate-600 flex items-center gap-1">
                      <Clock className="w-3 h-3" />
                      {formatDistanceToNow(new Date(task.completed_at), { addSuffix: true })}
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {integrations.length > 0 && (
        <div className="bg-slate-900/60 border border-slate-800/60 rounded-xl">
          <div className="px-5 py-4 border-b border-slate-800/40">
            <h2 className="text-sm font-semibold text-white">Integrations</h2>
          </div>
          <div className="divide-y divide-slate-800/40">
            {integrations.map(integ => (
              <div key={integ.id} className="flex items-center justify-between px-5 py-3.5">
                <div>
                  <p className="text-sm font-medium text-slate-200">{integ.service_name}</p>
                  <p className="text-xs text-slate-500 capitalize">{integ.service_type}</p>
                </div>
                <StatusBadge status={integ.status} />
              </div>
            ))}
          </div>
        </div>
      )}

      <Modal open={showEdit} onClose={() => setShowEdit(false)} title="Edit Project">
        <form onSubmit={handleSaveEdit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-slate-300 mb-1.5">Name</label>
            <input type="text" value={editForm.name} onChange={e => setEditForm({ ...editForm, name: e.target.value })} required className="w-full bg-slate-800 border border-slate-700 rounded-lg px-4 py-2.5 text-white focus:outline-none focus:ring-2 focus:ring-emerald-500/50 focus:border-emerald-500 transition-colors" />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-300 mb-1.5">Description</label>
            <textarea value={editForm.description} onChange={e => setEditForm({ ...editForm, description: e.target.value })} rows={3} className="w-full bg-slate-800 border border-slate-700 rounded-lg px-4 py-2.5 text-white focus:outline-none focus:ring-2 focus:ring-emerald-500/50 focus:border-emerald-500 transition-colors resize-none text-sm" />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-300 mb-1.5">Demo URL</label>
            <input type="url" value={editForm.demo_url} onChange={e => setEditForm({ ...editForm, demo_url: e.target.value })} className="w-full bg-slate-800 border border-slate-700 rounded-lg px-4 py-2.5 text-white focus:outline-none focus:ring-2 focus:ring-emerald-500/50 focus:border-emerald-500 transition-colors" />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-300 mb-1.5">Production URL</label>
            <input type="url" value={editForm.production_url} onChange={e => setEditForm({ ...editForm, production_url: e.target.value })} className="w-full bg-slate-800 border border-slate-700 rounded-lg px-4 py-2.5 text-white focus:outline-none focus:ring-2 focus:ring-emerald-500/50 focus:border-emerald-500 transition-colors" />
          </div>
          <div className="flex justify-end gap-3 pt-2">
            <button type="button" onClick={() => setShowEdit(false)} className="px-4 py-2.5 text-sm text-slate-400 hover:text-slate-200 transition-colors">Cancel</button>
            <button type="submit" disabled={editSaving} className="inline-flex items-center gap-2 px-5 py-2.5 bg-gradient-to-r from-emerald-600 to-cyan-600 hover:from-emerald-500 hover:to-cyan-500 text-white text-sm font-medium rounded-lg transition-all disabled:opacity-50">
              {editSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />} Save
            </button>
          </div>
        </form>
      </Modal>
    </div>
  );
}

function BriefQuestionsUI({ brief, onAnswer }: { brief: Brief; onAnswer: (questionId: string, answer: string) => void }) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const unanswered = brief.questions.filter(q => !q.answered);

  if (unanswered.length === 0) {
    return (
      <div className="mt-4 pt-4 border-t border-slate-800/40">
        <p className="text-xs text-emerald-400">All questions answered</p>
      </div>
    );
  }

  return (
    <div className="mt-4 pt-4 border-t border-slate-800/40 space-y-3">
      <p className="text-xs font-medium text-amber-400">{unanswered.length} unanswered questions from the agent</p>
      {unanswered.map(q => (
        <div key={q.id} className="bg-slate-800/30 rounded-lg p-3 space-y-2">
          <p className="text-sm text-slate-200">{q.question}</p>
          <span className="text-[10px] text-slate-500 uppercase tracking-wider">{q.category}</span>
          <div className="flex gap-2">
            <input
              type="text"
              value={answers[q.id] || ''}
              onChange={e => setAnswers(prev => ({ ...prev, [q.id]: e.target.value }))}
              placeholder="Type your answer..."
              className="flex-1 bg-slate-900/60 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-emerald-500/50 transition-colors"
            />
            <button
              onClick={() => { if (answers[q.id]?.trim()) { onAnswer(q.id, answers[q.id].trim()); setAnswers(prev => { const n = { ...prev }; delete n[q.id]; return n; }); } }}
              disabled={!answers[q.id]?.trim()}
              className="px-3 py-2 bg-emerald-500/10 text-emerald-400 text-xs font-medium rounded-lg hover:bg-emerald-500/20 transition-colors disabled:opacity-40"
            >
              Answer
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

function ArchitecturePlanDisplay({ architecture }: { architecture: Record<string, unknown> }) {
  const arch = architecture as {
    pages?: { name: string; route: string; description: string }[];
    components?: { name: string; description: string }[];
    designSystem?: { primaryColor?: string; secondaryColor?: string; accentColor?: string; fonts?: { heading?: string; body?: string }; style?: string };
    integrations?: string[];
    framework?: string;
    styling?: string;
  };

  return (
    <div className="bg-slate-900/60 border border-slate-800/60 rounded-xl p-5 space-y-5">
      <h2 className="text-sm font-semibold text-white">Architecture Plan</h2>

      {arch.designSystem && (
        <div className="space-y-3">
          <div className="flex items-center gap-2 text-xs font-medium text-slate-400">
            <Palette className="w-3.5 h-3.5" />
            Design System
            {arch.designSystem.style && <span className="text-slate-500 capitalize">({arch.designSystem.style})</span>}
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            {[arch.designSystem.primaryColor, arch.designSystem.secondaryColor, arch.designSystem.accentColor].filter(Boolean).map((color, i) => (
              <div key={i} className="flex items-center gap-2 bg-slate-800/50 rounded-lg px-3 py-1.5">
                <div className="w-4 h-4 rounded-full border border-slate-600" style={{ backgroundColor: color }} />
                <span className="text-xs text-slate-300 font-mono">{color}</span>
              </div>
            ))}
          </div>
          {arch.designSystem.fonts && (
            <div className="flex items-center gap-3">
              <Type className="w-3.5 h-3.5 text-slate-500" />
              {arch.designSystem.fonts.heading && <span className="text-xs text-slate-400">Heading: <span className="text-slate-300">{arch.designSystem.fonts.heading}</span></span>}
              {arch.designSystem.fonts.body && <span className="text-xs text-slate-400">Body: <span className="text-slate-300">{arch.designSystem.fonts.body}</span></span>}
            </div>
          )}
        </div>
      )}

      {arch.pages && arch.pages.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-xs font-medium text-slate-400">
            <Layout className="w-3.5 h-3.5" />
            Pages ({arch.pages.length})
          </div>
          <div className="grid gap-2">
            {arch.pages.map((page, i) => (
              <div key={i} className="bg-slate-800/30 rounded-lg px-3 py-2.5">
                <div className="flex items-center gap-2 mb-0.5">
                  <span className="text-sm font-medium text-slate-200">{page.name}</span>
                  <span className="text-xs font-mono text-slate-500 bg-slate-800/60 px-1.5 py-0.5 rounded">{page.route}</span>
                </div>
                {page.description && <p className="text-xs text-slate-400 line-clamp-2">{page.description}</p>}
              </div>
            ))}
          </div>
        </div>
      )}

      {arch.integrations && arch.integrations.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-xs font-medium text-slate-400">
            <Puzzle className="w-3.5 h-3.5" />
            Integrations
          </div>
          <div className="flex flex-wrap gap-1.5">
            {arch.integrations.map((integ, i) => (
              <span key={i} className="text-xs px-2.5 py-1 bg-cyan-500/10 text-cyan-400 rounded-md capitalize">{integ}</span>
            ))}
          </div>
        </div>
      )}

      {arch.framework && (
        <div className="flex items-center gap-2 text-xs text-slate-500">
          <Layers className="w-3.5 h-3.5" />
          Stack: <span className="text-slate-400">{arch.framework}</span>
          {arch.styling && <span className="text-slate-400">+ {arch.styling}</span>}
        </div>
      )}
    </div>
  );
}
