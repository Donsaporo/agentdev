import { useState, useEffect } from 'react';
import { Brain, Plus, Trash2, ToggleLeft, ToggleRight, Loader2 } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { useToast } from '../../contexts/ToastContext';
import type { SalesAgentInstruction } from '../../lib/types';

const PRIORITY_STYLES = {
  critical: { label: 'Critico', color: 'bg-red-500/20 text-red-400 border-red-500/20' },
  high: { label: 'Alto', color: 'bg-orange-500/20 text-orange-400 border-orange-500/20' },
  normal: { label: 'Normal', color: 'bg-slate-500/20 text-slate-400 border-slate-500/20' },
};

const CATEGORIES = ['general', 'ventas', 'soporte', 'precios', 'promesas', 'tono', 'productos', 'procesos'];

export default function InstructionManager() {
  const toast = useToast();
  const [instructions, setInstructions] = useState<SalesAgentInstruction[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [newInstruction, setNewInstruction] = useState({
    instruction: '',
    priority: 'normal' as SalesAgentInstruction['priority'],
    category: 'general',
  });

  useEffect(() => {
    loadInstructions();
  }, []);

  async function loadInstructions() {
    setLoading(true);
    const { data } = await supabase
      .from('sales_agent_instructions')
      .select('*')
      .order('priority', { ascending: true })
      .order('created_at', { ascending: false });

    setInstructions(data || []);
    setLoading(false);
  }

  async function addInstruction() {
    if (!newInstruction.instruction.trim()) return;

    const { error } = await supabase.from('sales_agent_instructions').insert({
      instruction: newInstruction.instruction.trim(),
      priority: newInstruction.priority,
      category: newInstruction.category,
    });

    if (error) {
      toast.error('Error al crear instruccion');
    } else {
      toast.success('Instruccion creada');
      setNewInstruction({ instruction: '', priority: 'normal', category: 'general' });
      setShowAdd(false);
      loadInstructions();
    }
  }

  async function toggleActive(id: string, currentActive: boolean) {
    const { error } = await supabase
      .from('sales_agent_instructions')
      .update({ is_active: !currentActive })
      .eq('id', id);

    if (error) {
      toast.error('Error al actualizar');
    } else {
      setInstructions((prev) =>
        prev.map((i) => (i.id === id ? { ...i, is_active: !currentActive } : i))
      );
    }
  }

  async function deleteInstruction(id: string) {
    if (!confirm('Eliminar esta instruccion?')) return;
    const { error } = await supabase.from('sales_agent_instructions').delete().eq('id', id);
    if (error) {
      toast.error('Error al eliminar');
    } else {
      setInstructions((prev) => prev.filter((i) => i.id !== id));
      toast.success('Instruccion eliminada');
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
      <div className="flex items-center justify-between">
        <p className="text-xs text-slate-400">
          {instructions.filter((i) => i.is_active).length} activas de {instructions.length} instrucciones
        </p>
        <button
          onClick={() => setShowAdd(!showAdd)}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-medium bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20 transition-all"
        >
          <Plus className="w-3.5 h-3.5" />
          Nueva instruccion
        </button>
      </div>

      {showAdd && (
        <div className="glass-card p-4 space-y-3 animate-fade-in-up">
          <textarea
            value={newInstruction.instruction}
            onChange={(e) => setNewInstruction({ ...newInstruction, instruction: e.target.value })}
            rows={3}
            className="w-full bg-white/[0.04] border border-white/[0.08] rounded-xl px-4 py-3 text-sm text-white placeholder-slate-500 focus:outline-none focus:ring-1 focus:ring-emerald-500/30 resize-none"
            placeholder="Ej: Nunca prometas entrega en menos de 3 semanas para proyectos web completos"
            autoFocus
          />
          <div className="flex items-center gap-3">
            <select
              value={newInstruction.priority}
              onChange={(e) => setNewInstruction({ ...newInstruction, priority: e.target.value as SalesAgentInstruction['priority'] })}
              className="bg-white/[0.04] border border-white/[0.08] rounded-lg px-3 py-2 text-xs text-white focus:outline-none"
            >
              <option value="normal">Prioridad Normal</option>
              <option value="high">Prioridad Alta</option>
              <option value="critical">Prioridad Critica</option>
            </select>
            <select
              value={newInstruction.category}
              onChange={(e) => setNewInstruction({ ...newInstruction, category: e.target.value })}
              className="bg-white/[0.04] border border-white/[0.08] rounded-lg px-3 py-2 text-xs text-white focus:outline-none"
            >
              {CATEGORIES.map((c) => (
                <option key={c} value={c}>{c.charAt(0).toUpperCase() + c.slice(1)}</option>
              ))}
            </select>
            <div className="flex-1" />
            <button
              onClick={() => setShowAdd(false)}
              className="px-3 py-2 text-xs text-slate-400 hover:text-slate-200 rounded-lg transition-all"
            >
              Cancelar
            </button>
            <button
              onClick={addInstruction}
              disabled={!newInstruction.instruction.trim()}
              className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 disabled:bg-slate-700 text-white text-xs font-medium rounded-lg transition-all"
            >
              Crear
            </button>
          </div>
        </div>
      )}

      {instructions.length === 0 && !showAdd ? (
        <div className="glass-card flex flex-col items-center justify-center py-16 text-center">
          <Brain className="w-10 h-10 text-slate-600 mb-3" />
          <p className="text-sm text-slate-400">No hay instrucciones configuradas</p>
          <p className="text-xs text-slate-600 mt-1">
            Las instrucciones guian el comportamiento del agente IA
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {instructions.map((inst) => {
            const priority = PRIORITY_STYLES[inst.priority];
            return (
              <div
                key={inst.id}
                className={`glass-card p-4 flex items-start gap-3 transition-opacity ${
                  !inst.is_active ? 'opacity-40' : ''
                }`}
              >
                <button
                  onClick={() => toggleActive(inst.id, inst.is_active)}
                  className="flex-shrink-0 mt-0.5"
                  title={inst.is_active ? 'Desactivar' : 'Activar'}
                >
                  {inst.is_active ? (
                    <ToggleRight className="w-5 h-5 text-emerald-400" />
                  ) : (
                    <ToggleLeft className="w-5 h-5 text-slate-500" />
                  )}
                </button>

                <div className="flex-1 min-w-0">
                  <p className="text-sm text-slate-200">{inst.instruction}</p>
                  <div className="flex items-center gap-2 mt-1.5">
                    <span className={`px-2 py-0.5 rounded text-[10px] font-medium ${priority.color}`}>
                      {priority.label}
                    </span>
                    <span className="text-[10px] text-slate-600">{inst.category}</span>
                  </div>
                </div>

                <button
                  onClick={() => deleteInstruction(inst.id)}
                  className="flex-shrink-0 p-1.5 rounded-lg text-slate-600 hover:text-red-400 hover:bg-red-500/10 transition-all"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
