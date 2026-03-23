import { useState } from 'react';
import { Shield, MessageSquareQuote, AlertTriangle, Users, Brain, BarChart3, MessageCircle, Calendar } from 'lucide-react';
import DirectorMetrics from './director/DirectorMetrics';
import EscalationQueue from './director/EscalationQueue';
import FeedbackHistory from './director/FeedbackHistory';
import InstructionManager from './director/InstructionManager';
import PersonaManager from './director/PersonaManager';
import DirectorChat from './director/DirectorChat';
import MeetingsOverview from './director/MeetingsOverview';

type Tab = 'chat' | 'meetings' | 'metrics' | 'escalations' | 'feedback' | 'instructions' | 'personas';

const TABS: { id: Tab; label: string; icon: typeof Shield }[] = [
  { id: 'chat', label: 'Chat Agente', icon: MessageCircle },
  { id: 'meetings', label: 'Reuniones', icon: Calendar },
  { id: 'metrics', label: 'Metricas', icon: BarChart3 },
  { id: 'escalations', label: 'Escalaciones', icon: AlertTriangle },
  { id: 'feedback', label: 'Historial', icon: MessageSquareQuote },
  { id: 'instructions', label: 'Instrucciones', icon: Brain },
  { id: 'personas', label: 'Agentes', icon: Users },
];

export default function DirectorPage() {
  const [activeTab, setActiveTab] = useState<Tab>('chat');

  return (
    <div className="space-y-6 animate-fade-in">
      <div>
        <div className="flex items-center gap-3 mb-1">
          <Shield className="w-6 h-6 text-emerald-400" />
          <h1 className="text-2xl font-bold text-white tracking-tight">Director de Ventas</h1>
        </div>
        <p className="text-slate-400 text-sm">
          Panel de control para supervisar agentes IA, dar feedback, y gestionar escalaciones
        </p>
      </div>

      <div className="flex items-center gap-1 overflow-x-auto pb-1">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium whitespace-nowrap transition-all ${
              activeTab === tab.id
                ? 'bg-emerald-500/10 text-emerald-400 shadow-sm shadow-emerald-500/5'
                : 'text-slate-400 hover:text-slate-200 hover:bg-white/[0.04]'
            }`}
          >
            <tab.icon className="w-4 h-4" />
            {tab.label}
          </button>
        ))}
      </div>

      <div className="animate-fade-in-up">
        {activeTab === 'chat' && <DirectorChat />}
        {activeTab === 'meetings' && <MeetingsOverview />}
        {activeTab === 'metrics' && <DirectorMetrics />}
        {activeTab === 'escalations' && <EscalationQueue />}
        {activeTab === 'feedback' && <FeedbackHistory />}
        {activeTab === 'instructions' && <InstructionManager />}
        {activeTab === 'personas' && <PersonaManager />}
      </div>
    </div>
  );
}
