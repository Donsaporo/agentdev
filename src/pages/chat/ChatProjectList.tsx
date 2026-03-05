import { Bot } from 'lucide-react';
import type { Project } from '../../lib/types';
import AgentStatusIndicator from '../../components/AgentStatusIndicator';

interface ChatProjectListProps {
  projects: Project[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}

export default function ChatProjectList({ projects, selectedId, onSelect }: ChatProjectListProps) {
  return (
    <div className="w-full h-full flex flex-col bg-[#0a0e17]/80 border-r border-white/[0.04]">
      <div className="px-4 py-4 border-b border-white/[0.04]">
        <h2 className="text-sm font-semibold text-white">Projects</h2>
        <p className="text-xs text-slate-500 mt-0.5">{projects.length} active</p>
      </div>
      <div className="flex-1 overflow-y-auto">
        {projects.length === 0 ? (
          <div className="p-6 text-center">
            <div className="w-10 h-10 rounded-xl bg-white/[0.04] flex items-center justify-center mx-auto mb-2">
              <Bot className="w-5 h-5 text-slate-600" />
            </div>
            <p className="text-xs text-slate-600">No projects yet</p>
          </div>
        ) : (
          <div className="py-1">
            {projects.map(project => (
              <button
                key={project.id}
                onClick={() => onSelect(project.id)}
                className={`w-full text-left px-4 py-3 transition-all relative ${
                  selectedId === project.id
                    ? 'bg-emerald-500/[0.06]'
                    : 'hover:bg-white/[0.03]'
                }`}
              >
                {selectedId === project.id && (
                  <div className="absolute left-0 top-1/2 -translate-y-1/2 w-[3px] h-5 bg-emerald-500 rounded-r-full" />
                )}
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-slate-200 truncate flex-1">{project.name}</span>
                  <AgentStatusIndicator status={project.agent_status} />
                </div>
                <div className="flex items-center gap-2 mt-1">
                  <span className="text-xs text-slate-500 truncate">{project.clients?.name}</span>
                  <span className="text-xs text-slate-600">{project.progress}%</span>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
