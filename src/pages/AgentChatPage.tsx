import { useEffect, useState, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { PanelRightClose, PanelRightOpen } from 'lucide-react';
import { supabase } from '../lib/supabase';
import type { Project, AgentMessage, AgentConversation, ProjectTask, Brief } from '../lib/types';
import { useRealtimeSubscription } from '../hooks/useRealtimeSubscription';
import ChatProjectList from './chat/ChatProjectList';
import ChatMessageList from './chat/ChatMessageList';
import ChatInput from './chat/ChatInput';
import ChatContextPanel from './chat/ChatContextPanel';

export default function AgentChatPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const navigate = useNavigate();
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProject, setSelectedProject] = useState<Project | null>(null);
  const [conversation, setConversation] = useState<AgentConversation | null>(null);
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [tasks, setTasks] = useState<ProjectTask[]>([]);
  const [brief, setBrief] = useState<Brief | null>(null);
  const [loading, setLoading] = useState(true);
  const [showContext, setShowContext] = useState(true);

  useEffect(() => {
    loadProjects();
  }, []);

  useEffect(() => {
    if (projectId && projects.length > 0) {
      const proj = projects.find(p => p.id === projectId);
      if (proj) handleSelectProject(proj.id);
    }
  }, [projectId, projects]);

  async function loadProjects() {
    const { data } = await supabase
      .from('projects')
      .select('*, clients(name)')
      .order('updated_at', { ascending: false });
    setProjects(data || []);
    setLoading(false);
  }

  async function handleSelectProject(id: string) {
    if (selectedProject?.id === id) return;
    navigate(`/chat/${id}`, { replace: true });

    const [projRes, convRes, tasksRes, briefRes] = await Promise.all([
      supabase.from('projects').select('*, clients(name)').eq('id', id).maybeSingle(),
      supabase.from('agent_conversations').select('*').eq('project_id', id).eq('status', 'active').order('updated_at', { ascending: false }).limit(1).maybeSingle(),
      supabase.from('project_tasks').select('*').eq('project_id', id).order('order_index'),
      supabase.from('briefs').select('*').eq('project_id', id).order('created_at', { ascending: false }).maybeSingle(),
    ]);

    setSelectedProject(projRes.data);
    setTasks(tasksRes.data || []);
    setBrief(briefRes.data);

    if (convRes.data) {
      setConversation(convRes.data);
      const { data: msgs } = await supabase
        .from('agent_messages')
        .select('*')
        .eq('conversation_id', convRes.data.id)
        .order('created_at');
      setMessages(msgs || []);
    } else {
      setConversation(null);
      setMessages([]);
    }
  }

  const handleNewMessage = useCallback(
    (payload: { new: Record<string, unknown> }) => {
      const msg = payload.new as unknown as AgentMessage;
      if (msg.conversation_id === conversation?.id) {
        setMessages(prev => {
          if (prev.some(m => m.id === msg.id)) return prev;
          return [...prev, msg];
        });
      }
    },
    [conversation?.id],
  );

  useRealtimeSubscription({
    table: 'agent_messages',
    event: 'INSERT',
    filter: conversation ? `conversation_id=eq.${conversation.id}` : undefined,
    onInsert: handleNewMessage,
    enabled: !!conversation,
  });

  useRealtimeSubscription({
    table: 'projects',
    event: 'UPDATE',
    filter: selectedProject ? `id=eq.${selectedProject.id}` : undefined,
    onUpdate: (payload) => {
      const updated = payload.new as unknown as Project;
      setSelectedProject(prev => prev ? { ...prev, ...updated } : null);
      setProjects(prev => prev.map(p => p.id === updated.id ? { ...p, ...updated } : p));
    },
    enabled: !!selectedProject,
  });

  async function handleSend(content: string) {
    if (!selectedProject) return;

    let conv = conversation;
    if (!conv) {
      const { data } = await supabase
        .from('agent_conversations')
        .insert({ project_id: selectedProject.id, title: selectedProject.name })
        .select()
        .maybeSingle();
      if (!data) return;
      conv = data;
      setConversation(data);
    }

    const newMsg: AgentMessage = {
      id: crypto.randomUUID(),
      conversation_id: conv.id,
      role: 'user',
      content,
      metadata: {},
      created_at: new Date().toISOString(),
    };

    setMessages(prev => [...prev, newMsg]);

    await supabase.from('agent_messages').insert({
      conversation_id: conv.id,
      role: 'user',
      content,
      metadata: {},
    });
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-[calc(100vh-4rem)]">
        <div className="w-8 h-8 border-2 border-emerald-500/30 border-t-emerald-500 rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="h-[calc(100vh-4rem)] lg:h-[calc(100vh-2rem)] flex rounded-xl overflow-hidden border border-slate-800/60 bg-slate-900/40 -m-4 lg:-m-8">
      <div className="hidden lg:block w-60 flex-shrink-0">
        <ChatProjectList
          projects={projects}
          selectedId={selectedProject?.id || null}
          onSelect={id => handleSelectProject(id)}
        />
      </div>

      <div className="flex-1 flex flex-col min-w-0 border-x border-slate-800/40">
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-800/40 bg-slate-950/60">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-white truncate">
              {selectedProject ? selectedProject.name : 'Agent Chat'}
            </h2>
            {selectedProject && (
              <p className="text-xs text-slate-500">
                {selectedProject.agent_status === 'working' ? 'Agent is working...' : 'Send a message to interact with the agent'}
              </p>
            )}
          </div>
          <button
            onClick={() => setShowContext(!showContext)}
            className="hidden lg:flex p-2 text-slate-400 hover:text-slate-200 hover:bg-slate-800/50 rounded-lg transition-all"
            title={showContext ? 'Hide context' : 'Show context'}
          >
            {showContext ? <PanelRightClose className="w-4 h-4" /> : <PanelRightOpen className="w-4 h-4" />}
          </button>
        </div>

        <ChatMessageList
          messages={messages}
          isAgentWorking={selectedProject?.agent_status === 'working'}
        />

        <ChatInput
          onSend={handleSend}
          disabled={!selectedProject}
          placeholder={selectedProject ? `Message about ${selectedProject.name}...` : 'Select a project first'}
        />
      </div>

      {showContext && selectedProject && (
        <div className="hidden xl:block w-72 flex-shrink-0">
          <ChatContextPanel
            project={selectedProject}
            tasks={tasks}
            brief={brief}
          />
        </div>
      )}
    </div>
  );
}
