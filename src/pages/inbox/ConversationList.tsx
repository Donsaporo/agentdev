import { useState, useMemo } from 'react';
import { Search, Bot, User, Filter, MessageCircle } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { es } from 'date-fns/locale';
import type { WhatsAppConversation, ConversationCategory } from '../../lib/types';

const CATEGORY_LABELS: Record<ConversationCategory, string> = {
  new_lead: 'Nuevos',
  active_client: 'Clientes',
  support: 'Soporte',
  escalated: 'Escalados',
  archived: 'Archivados',
};

const CATEGORY_COLORS: Record<ConversationCategory, string> = {
  new_lead: 'bg-blue-500/20 text-blue-400',
  active_client: 'bg-emerald-500/20 text-emerald-400',
  support: 'bg-amber-500/20 text-amber-400',
  escalated: 'bg-red-500/20 text-red-400',
  archived: 'bg-slate-500/20 text-slate-400',
};

interface Props {
  conversations: WhatsAppConversation[];
  activeId: string | null;
  onSelect: (id: string) => void;
}

export default function ConversationList({ conversations, activeId, onSelect }: Props) {
  const [search, setSearch] = useState('');
  const [filterCategory, setFilterCategory] = useState<ConversationCategory | 'all'>('all');
  const [showFilters, setShowFilters] = useState(false);

  const filtered = useMemo(() => {
    let result = conversations;
    if (filterCategory !== 'all') {
      result = result.filter((c) => c.category === filterCategory);
    }
    if (search.trim()) {
      const q = search.toLowerCase();
      result = result.filter(
        (c) =>
          c.contact?.display_name?.toLowerCase().includes(q) ||
          c.contact?.profile_name?.toLowerCase().includes(q) ||
          c.contact?.phone_number?.includes(q) ||
          c.last_message_preview?.toLowerCase().includes(q)
      );
    }
    return result;
  }, [conversations, filterCategory, search]);

  const categoryCounts = useMemo(() => {
    const counts: Record<string, number> = { all: conversations.length };
    conversations.forEach((c) => {
      counts[c.category] = (counts[c.category] || 0) + 1;
    });
    return counts;
  }, [conversations]);

  function getInitials(name: string) {
    return name
      .split(' ')
      .map((w) => w[0])
      .join('')
      .toUpperCase()
      .slice(0, 2);
  }

  function formatTime(dateStr: string) {
    if (!dateStr) return '';
    try {
      return formatDistanceToNow(new Date(dateStr), { addSuffix: true, locale: es });
    } catch {
      return '';
    }
  }

  return (
    <div className="flex flex-col h-full">
      <div className="p-4 space-y-3 flex-shrink-0">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-bold text-white">Conversaciones</h2>
          <button
            onClick={() => setShowFilters(!showFilters)}
            className={`p-2 rounded-xl transition-all ${
              showFilters || filterCategory !== 'all'
                ? 'bg-emerald-500/10 text-emerald-400'
                : 'text-slate-400 hover:text-slate-200 hover:bg-white/[0.04]'
            }`}
          >
            <Filter className="w-4 h-4" />
          </button>
        </div>

        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar conversaciones..."
            className="w-full bg-white/[0.04] border border-white/[0.06] rounded-xl pl-10 pr-4 py-2.5 text-sm text-white placeholder-slate-500 focus:outline-none focus:ring-1 focus:ring-emerald-500/30 transition-all"
          />
        </div>

        {showFilters && (
          <div className="flex flex-wrap gap-1.5 animate-fade-in">
            <button
              onClick={() => setFilterCategory('all')}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                filterCategory === 'all'
                  ? 'bg-white/[0.08] text-white'
                  : 'text-slate-500 hover:text-slate-300 hover:bg-white/[0.04]'
              }`}
            >
              Todos ({categoryCounts.all || 0})
            </button>
            {(Object.keys(CATEGORY_LABELS) as ConversationCategory[]).map((cat) => (
              <button
                key={cat}
                onClick={() => setFilterCategory(cat)}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                  filterCategory === cat
                    ? CATEGORY_COLORS[cat]
                    : 'text-slate-500 hover:text-slate-300 hover:bg-white/[0.04]'
                }`}
              >
                {CATEGORY_LABELS[cat]} ({categoryCounts[cat] || 0})
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="flex-1 overflow-y-auto">
        {filtered.length === 0 && (
          <div className="flex flex-col items-center justify-center py-16 px-6 text-center">
            <MessageCircle className="w-10 h-10 text-slate-600 mb-3" />
            <p className="text-sm text-slate-500">
              {search ? 'Sin resultados' : 'No hay conversaciones'}
            </p>
          </div>
        )}

        {filtered.map((conv) => {
          const contact = conv.contact;
          const name = contact?.display_name || contact?.profile_name || contact?.phone_number || 'Desconocido';
          const isActive = conv.id === activeId;

          return (
            <button
              key={conv.id}
              onClick={() => onSelect(conv.id)}
              className={`w-full text-left px-4 py-3 flex items-start gap-3 transition-all border-l-2 ${
                isActive
                  ? 'bg-emerald-500/[0.07] border-emerald-500'
                  : 'border-transparent hover:bg-white/[0.03]'
              }`}
            >
              <div className="relative flex-shrink-0">
                <div className="w-11 h-11 rounded-full bg-gradient-to-br from-slate-700 to-slate-800 flex items-center justify-center text-xs font-bold text-white ring-1 ring-white/[0.06]">
                  {getInitials(name)}
                </div>
                {conv.agent_mode === 'ai' && (
                  <div className="absolute -bottom-0.5 -right-0.5 w-4 h-4 rounded-full bg-emerald-500/20 flex items-center justify-center border border-[#0d1117]">
                    <Bot className="w-2.5 h-2.5 text-emerald-400" />
                  </div>
                )}
                {conv.agent_mode === 'manual' && (
                  <div className="absolute -bottom-0.5 -right-0.5 w-4 h-4 rounded-full bg-blue-500/20 flex items-center justify-center border border-[#0d1117]">
                    <User className="w-2.5 h-2.5 text-blue-400" />
                  </div>
                )}
              </div>

              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-medium text-white truncate">{name}</span>
                  <span className="text-[10px] text-slate-500 flex-shrink-0">
                    {formatTime(conv.last_message_at)}
                  </span>
                </div>
                <div className="flex items-center justify-between gap-2 mt-0.5">
                  <p className="text-xs text-slate-400 truncate">
                    {conv.is_agent_typing ? (
                      <span className="text-emerald-400 italic">escribiendo...</span>
                    ) : (
                      conv.last_message_preview || 'Sin mensajes'
                    )}
                  </p>
                  <div className="flex items-center gap-1 flex-shrink-0">
                    {conv.category !== 'new_lead' && (
                      <span className={`px-1.5 py-0.5 rounded text-[9px] font-medium ${CATEGORY_COLORS[conv.category]}`}>
                        {CATEGORY_LABELS[conv.category]}
                      </span>
                    )}
                    {conv.unread_count > 0 && (
                      <span className="min-w-[18px] h-[18px] flex items-center justify-center rounded-full bg-emerald-500 text-white text-[10px] font-bold px-1">
                        {conv.unread_count}
                      </span>
                    )}
                  </div>
                </div>
                {conv.persona && (
                  <p className="text-[10px] text-slate-600 mt-0.5 truncate">
                    {conv.persona.full_name}
                  </p>
                )}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
