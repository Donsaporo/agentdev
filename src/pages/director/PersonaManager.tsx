import { useState, useEffect } from 'react';
import { Users, ToggleLeft, ToggleRight, CreditCard as Edit2, Save, X, Loader2 } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { useToast } from '../../contexts/ToastContext';
import type { SalesAgentPersona } from '../../lib/types';

export default function PersonaManager() {
  const toast = useToast();
  const [personas, setPersonas] = useState<SalesAgentPersona[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState({
    communication_style: '',
    greeting_template: '',
    farewell_template: '',
  });

  useEffect(() => {
    loadPersonas();
  }, []);

  async function loadPersonas() {
    setLoading(true);
    const { data } = await supabase
      .from('sales_agent_personas')
      .select('*')
      .order('created_at', { ascending: true });

    setPersonas(data || []);
    setLoading(false);
  }

  async function toggleActive(id: string, currentActive: boolean) {
    const { error } = await supabase
      .from('sales_agent_personas')
      .update({ is_active: !currentActive })
      .eq('id', id);

    if (error) {
      toast.error('Error al actualizar');
    } else {
      setPersonas((prev) =>
        prev.map((p) => (p.id === id ? { ...p, is_active: !currentActive } : p))
      );
    }
  }

  function startEdit(persona: SalesAgentPersona) {
    setEditingId(persona.id);
    setEditForm({
      communication_style: persona.communication_style,
      greeting_template: persona.greeting_template,
      farewell_template: persona.farewell_template,
    });
  }

  async function saveEdit() {
    if (!editingId) return;
    const { error } = await supabase
      .from('sales_agent_personas')
      .update({
        communication_style: editForm.communication_style,
        greeting_template: editForm.greeting_template,
        farewell_template: editForm.farewell_template,
        updated_at: new Date().toISOString(),
      })
      .eq('id', editingId);

    if (error) {
      toast.error('Error al guardar');
    } else {
      toast.success('Persona actualizada');
      setEditingId(null);
      loadPersonas();
    }
  }

  if (loading) {
    return (
      <div className="flex justify-center py-12">
        <Loader2 className="w-5 h-5 text-emerald-500 animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <p className="text-xs text-slate-400">
        {personas.filter((p) => p.is_active).length} agentes activos de {personas.length}
      </p>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {personas.map((persona) => {
          const isEditing = editingId === persona.id;
          const initials = `${persona.first_name[0]}${persona.last_name[0]}`;

          return (
            <div
              key={persona.id}
              className={`glass-card p-5 transition-opacity ${!persona.is_active ? 'opacity-40' : ''}`}
            >
              <div className="flex items-start justify-between mb-4">
                <div className="flex items-center gap-3">
                  <div className="w-12 h-12 rounded-full bg-gradient-to-br from-emerald-600/30 to-teal-600/30 flex items-center justify-center text-sm font-bold text-emerald-300 ring-2 ring-emerald-500/20">
                    {initials}
                  </div>
                  <div>
                    <h4 className="text-sm font-semibold text-white">{persona.full_name}</h4>
                    <p className="text-xs text-slate-400">{persona.job_title}</p>
                  </div>
                </div>

                <div className="flex items-center gap-1">
                  {!isEditing && (
                    <button
                      onClick={() => startEdit(persona)}
                      className="p-1.5 rounded-lg text-slate-500 hover:text-slate-200 hover:bg-white/[0.04] transition-all"
                    >
                      <Edit2 className="w-3.5 h-3.5" />
                    </button>
                  )}
                  <button
                    onClick={() => toggleActive(persona.id, persona.is_active)}
                    title={persona.is_active ? 'Desactivar' : 'Activar'}
                  >
                    {persona.is_active ? (
                      <ToggleRight className="w-6 h-6 text-emerald-400" />
                    ) : (
                      <ToggleLeft className="w-6 h-6 text-slate-500" />
                    )}
                  </button>
                </div>
              </div>

              <div className="flex flex-wrap gap-1.5 mb-3">
                {persona.personality_traits.map((trait, i) => (
                  <span key={i} className="px-2 py-0.5 rounded-md bg-white/[0.04] text-[10px] text-slate-400">
                    {trait}
                  </span>
                ))}
              </div>

              <div className="grid grid-cols-3 gap-3 text-center mb-3">
                <div>
                  <p className="text-sm font-semibold text-white">{persona.total_conversations}</p>
                  <p className="text-[10px] text-slate-500">Conversaciones</p>
                </div>
                <div>
                  <p className="text-sm font-semibold text-white">{persona.total_messages_sent}</p>
                  <p className="text-[10px] text-slate-500">Mensajes</p>
                </div>
                <div>
                  <p className="text-sm font-semibold text-white capitalize">{persona.response_length_preference}</p>
                  <p className="text-[10px] text-slate-500">Longitud</p>
                </div>
              </div>

              {isEditing && (
                <div className="space-y-3 mt-4 pt-4 border-t border-white/[0.06] animate-fade-in">
                  <div>
                    <label className="text-[10px] text-slate-500 uppercase tracking-wider mb-1 block">
                      Estilo de comunicacion
                    </label>
                    <textarea
                      value={editForm.communication_style}
                      onChange={(e) => setEditForm({ ...editForm, communication_style: e.target.value })}
                      rows={2}
                      className="w-full bg-white/[0.04] border border-white/[0.08] rounded-lg px-3 py-2 text-xs text-white placeholder-slate-500 focus:outline-none focus:ring-1 focus:ring-emerald-500/30 resize-none"
                      placeholder="Describe como se comunica esta persona..."
                    />
                  </div>
                  <div>
                    <label className="text-[10px] text-slate-500 uppercase tracking-wider mb-1 block">
                      Saludo
                    </label>
                    <input
                      value={editForm.greeting_template}
                      onChange={(e) => setEditForm({ ...editForm, greeting_template: e.target.value })}
                      className="w-full bg-white/[0.04] border border-white/[0.08] rounded-lg px-3 py-2 text-xs text-white placeholder-slate-500 focus:outline-none focus:ring-1 focus:ring-emerald-500/30"
                      placeholder="Ej: Hola, soy {nombre} de Obzide Tech..."
                    />
                  </div>
                  <div>
                    <label className="text-[10px] text-slate-500 uppercase tracking-wider mb-1 block">
                      Despedida
                    </label>
                    <input
                      value={editForm.farewell_template}
                      onChange={(e) => setEditForm({ ...editForm, farewell_template: e.target.value })}
                      className="w-full bg-white/[0.04] border border-white/[0.08] rounded-lg px-3 py-2 text-xs text-white placeholder-slate-500 focus:outline-none focus:ring-1 focus:ring-emerald-500/30"
                      placeholder="Ej: Fue un gusto atenderte, quedo atenta..."
                    />
                  </div>
                  <div className="flex justify-end gap-2">
                    <button
                      onClick={() => setEditingId(null)}
                      className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs text-slate-400 hover:text-slate-200 transition-all"
                    >
                      <X className="w-3 h-3" />
                      Cancelar
                    </button>
                    <button
                      onClick={saveEdit}
                      className="flex items-center gap-1 px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-medium rounded-lg transition-all"
                    >
                      <Save className="w-3 h-3" />
                      Guardar
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
