import { useState, useEffect } from 'react';
import {
  X,
  Phone,
  Mail,
  Building2,
  StickyNote,
  Tag,
  Bot,
  UserRound,
  Save,
  ChevronDown,
  ChevronRight,
  Eye,
  Calendar,
} from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { useToast } from '../../contexts/ToastContext';
import type { WhatsAppConversation, WhatsAppContact, SalesAgentPersona, ConversationCategory, LeadStage } from '../../lib/types';

const LEAD_STAGES: { value: LeadStage; label: string; color: string }[] = [
  { value: 'nuevo', label: 'Nuevo', color: 'bg-slate-500/20 text-slate-400' },
  { value: 'interesado', label: 'Interesado', color: 'bg-blue-500/20 text-blue-400' },
  { value: 'calificado', label: 'Calificado', color: 'bg-cyan-500/20 text-cyan-400' },
  { value: 'reunion_agendada', label: 'Reunion Agendada', color: 'bg-amber-500/20 text-amber-400' },
  { value: 'reunion_completada', label: 'Post-Reunion', color: 'bg-teal-500/20 text-teal-400' },
  { value: 'propuesta_enviada', label: 'Propuesta', color: 'bg-sky-500/20 text-sky-400' },
  { value: 'negociacion', label: 'Negociacion', color: 'bg-orange-500/20 text-orange-400' },
  { value: 'cerrado_ganado', label: 'Ganado', color: 'bg-emerald-500/20 text-emerald-400' },
  { value: 'cerrado_perdido', label: 'Perdido', color: 'bg-red-500/20 text-red-400' },
  { value: 'inactivo', label: 'Inactivo', color: 'bg-slate-600/20 text-slate-500' },
];

const CATEGORIES: { value: ConversationCategory; label: string }[] = [
  { value: 'new_lead', label: 'Nuevo Lead' },
  { value: 'active_client', label: 'Cliente Activo' },
  { value: 'support', label: 'Soporte' },
  { value: 'escalated', label: 'Escalado' },
  { value: 'archived', label: 'Archivado' },
];

interface Props {
  conversation: WhatsAppConversation;
  contact: WhatsAppContact | undefined;
  personas: SalesAgentPersona[];
  onClose: () => void;
}

export default function ContactPanel({ conversation, contact, personas, onClose }: Props) {
  const toast = useToast();
  const [editMode, setEditMode] = useState(false);
  const [showDetails, setShowDetails] = useState(true);
  const [showAgent, setShowAgent] = useState(true);
  const [showDirector, setShowDirector] = useState(false);
  const [form, setForm] = useState({
    email: '',
    company: '',
    notes: '',
    lead_stage: 'nuevo' as string,
  });
  const [directorNotes, setDirectorNotes] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setForm({
      email: contact?.email || '',
      company: contact?.company || '',
      notes: contact?.notes || '',
      lead_stage: contact?.lead_stage || 'nuevo',
    });
  }, [contact?.id, contact?.email, contact?.company, contact?.notes, contact?.lead_stage]);

  useEffect(() => {
    setDirectorNotes(conversation.director_notes || '');
  }, [conversation.director_notes]);

  async function handleSave() {
    if (!contact) return;
    setSaving(true);
    const { error } = await supabase
      .from('whatsapp_contacts')
      .update({
        email: form.email,
        company: form.company,
        notes: form.notes,
        lead_stage: form.lead_stage,
      })
      .eq('id', contact.id);

    if (error) {
      toast.error('Error al guardar');
    } else {
      toast.success('Contacto actualizado');
      setEditMode(false);
    }
    setSaving(false);
  }

  async function updateCategory(category: ConversationCategory) {
    await supabase
      .from('whatsapp_conversations')
      .update({ category })
      .eq('id', conversation.id);
    toast.success('Categoria actualizada');
  }

  async function updatePersona(personaId: string) {
    await supabase
      .from('whatsapp_conversations')
      .update({ agent_persona_id: personaId || null })
      .eq('id', conversation.id);
    toast.success('Agente asignado');
  }

  async function markAsReviewed() {
    await supabase
      .from('whatsapp_conversations')
      .update({
        director_reviewed_at: new Date().toISOString(),
        needs_director_attention: false,
      })
      .eq('id', conversation.id);
    toast.success('Marcado como revisado');
  }

  async function saveDirectorNotes() {
    await supabase
      .from('whatsapp_conversations')
      .update({ director_notes: directorNotes })
      .eq('id', conversation.id);
    toast.success('Notas guardadas');
  }

  const name = contact?.display_name || contact?.profile_name || 'Desconocido';
  const currentStage = LEAD_STAGES.find((s) => s.value === (contact?.lead_stage || 'nuevo'));

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-4 py-3 border-b border-white/[0.06] flex-shrink-0">
        <h3 className="text-sm font-semibold text-white">Contacto</h3>
        <button
          onClick={onClose}
          className="p-1.5 rounded-lg hover:bg-white/[0.04] text-slate-400 hover:text-slate-200 transition-all"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="flex flex-col items-center py-6 px-4">
          <div className="w-16 h-16 rounded-full bg-gradient-to-br from-slate-700 to-slate-800 flex items-center justify-center text-lg font-bold text-white ring-2 ring-white/[0.06]">
            {name.split(' ').map((w) => w[0]).join('').toUpperCase().slice(0, 2)}
          </div>
          <h4 className="text-base font-semibold text-white mt-3">{name}</h4>
          {contact?.company && (
            <p className="text-xs text-slate-400 mt-0.5">{contact.company}</p>
          )}
          <div className="mt-2">
            <span className={`px-2.5 py-1 rounded-lg text-xs font-medium ${currentStage?.color || 'bg-slate-500/20 text-slate-400'}`}>
              {currentStage?.label || 'Nuevo'}
            </span>
          </div>
        </div>

        {conversation.needs_director_attention && (
          <div className="mx-4 mb-3">
            <button
              onClick={markAsReviewed}
              className="w-full flex items-center justify-center gap-2 px-3 py-2.5 bg-amber-500/10 hover:bg-amber-500/15 border border-amber-500/20 text-amber-400 text-xs font-medium rounded-lg transition-all"
            >
              <Eye className="w-3.5 h-3.5" />
              Marcar como revisado
            </button>
          </div>
        )}

        <div className="px-4 space-y-1">
          <button
            onClick={() => setShowDetails(!showDetails)}
            className="w-full flex items-center justify-between py-2 text-xs font-medium text-slate-400 hover:text-slate-200 transition-colors"
          >
            <span>Informacion</span>
            {showDetails ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
          </button>

          {showDetails && (
            <div className="space-y-3 pb-4 animate-fade-in">
              <div className="flex items-center gap-3 text-sm">
                <Phone className="w-4 h-4 text-slate-500 flex-shrink-0" />
                <span className="text-slate-300">{contact?.phone_number || '--'}</span>
              </div>

              {editMode ? (
                <div className="space-y-3">
                  <div>
                    <label className="text-[10px] text-slate-500 uppercase tracking-wider mb-1 block">Email</label>
                    <input
                      value={form.email}
                      onChange={(e) => setForm({ ...form, email: e.target.value })}
                      className="w-full bg-white/[0.04] border border-white/[0.08] rounded-lg px-3 py-2 text-sm text-white placeholder-slate-500 focus:outline-none focus:ring-1 focus:ring-emerald-500/30"
                      placeholder="email@ejemplo.com"
                    />
                  </div>
                  <div>
                    <label className="text-[10px] text-slate-500 uppercase tracking-wider mb-1 block">Empresa</label>
                    <input
                      value={form.company}
                      onChange={(e) => setForm({ ...form, company: e.target.value })}
                      className="w-full bg-white/[0.04] border border-white/[0.08] rounded-lg px-3 py-2 text-sm text-white placeholder-slate-500 focus:outline-none focus:ring-1 focus:ring-emerald-500/30"
                      placeholder="Nombre de la empresa"
                    />
                  </div>
                  <div>
                    <label className="text-[10px] text-slate-500 uppercase tracking-wider mb-1 block">Etapa</label>
                    <select
                      value={form.lead_stage}
                      onChange={(e) => setForm({ ...form, lead_stage: e.target.value })}
                      className="w-full bg-white/[0.04] border border-white/[0.08] rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:ring-1 focus:ring-emerald-500/30"
                    >
                      {LEAD_STAGES.map((s) => (
                        <option key={s.value} value={s.value}>{s.label}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="text-[10px] text-slate-500 uppercase tracking-wider mb-1 block">Notas</label>
                    <textarea
                      value={form.notes}
                      onChange={(e) => setForm({ ...form, notes: e.target.value })}
                      rows={4}
                      className="w-full bg-white/[0.04] border border-white/[0.08] rounded-lg px-3 py-2 text-sm text-white placeholder-slate-500 focus:outline-none focus:ring-1 focus:ring-emerald-500/30 resize-none font-mono text-xs"
                      placeholder="Notas sobre este contacto..."
                    />
                  </div>
                  <div className="flex gap-2">
                    <button
                      onClick={handleSave}
                      disabled={saving}
                      className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-medium rounded-lg transition-all"
                    >
                      <Save className="w-3.5 h-3.5" />
                      {saving ? 'Guardando...' : 'Guardar'}
                    </button>
                    <button
                      onClick={() => setEditMode(false)}
                      className="px-3 py-2 text-slate-400 hover:text-slate-200 text-xs font-medium rounded-lg hover:bg-white/[0.04] transition-all"
                    >
                      Cancelar
                    </button>
                  </div>
                </div>
              ) : (
                <div className="space-y-3">
                  <div className="flex items-center gap-3 text-sm">
                    <Mail className="w-4 h-4 text-slate-500 flex-shrink-0" />
                    <span className="text-slate-300">{contact?.email || '--'}</span>
                  </div>
                  <div className="flex items-center gap-3 text-sm">
                    <Building2 className="w-4 h-4 text-slate-500 flex-shrink-0" />
                    <span className="text-slate-300">{contact?.company || '--'}</span>
                  </div>
                  {contact?.notes && (
                    <div className="flex items-start gap-3 text-sm">
                      <StickyNote className="w-4 h-4 text-slate-500 flex-shrink-0 mt-0.5" />
                      <pre className="text-slate-300 text-xs whitespace-pre-wrap font-sans leading-relaxed">
                        {contact.notes}
                      </pre>
                    </div>
                  )}
                  <button
                    onClick={() => setEditMode(true)}
                    className="w-full px-3 py-2 text-xs font-medium text-slate-400 hover:text-emerald-400 border border-white/[0.06] hover:border-emerald-500/20 rounded-lg transition-all"
                  >
                    Editar informacion
                  </button>
                </div>
              )}
            </div>
          )}

          <div className="h-px bg-white/[0.04]" />

          <button
            onClick={() => setShowAgent(!showAgent)}
            className="w-full flex items-center justify-between py-2 text-xs font-medium text-slate-400 hover:text-slate-200 transition-colors"
          >
            <span>Agente & Categoria</span>
            {showAgent ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
          </button>

          {showAgent && (
            <div className="space-y-3 pb-4 animate-fade-in">
              <div>
                <label className="text-[10px] text-slate-500 uppercase tracking-wider mb-1.5 block">Modo</label>
                <div className="flex items-center gap-2">
                  {conversation.agent_mode === 'ai' ? (
                    <div className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-emerald-500/10 text-emerald-400 text-xs font-medium">
                      <Bot className="w-3.5 h-3.5" />
                      IA Activa
                    </div>
                  ) : (
                    <div className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-blue-500/10 text-blue-400 text-xs font-medium">
                      <UserRound className="w-3.5 h-3.5" />
                      Control Manual
                    </div>
                  )}
                </div>
              </div>

              <div>
                <label className="text-[10px] text-slate-500 uppercase tracking-wider mb-1.5 block">Agente asignado</label>
                <select
                  value={conversation.agent_persona_id || ''}
                  onChange={(e) => updatePersona(e.target.value)}
                  className="w-full bg-white/[0.04] border border-white/[0.08] rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:ring-1 focus:ring-emerald-500/30"
                >
                  <option value="">Auto (aleatorio)</option>
                  {personas.map((p) => (
                    <option key={p.id} value={p.id}>{p.full_name} - {p.job_title}</option>
                  ))}
                </select>
              </div>

              <div>
                <label className="text-[10px] text-slate-500 uppercase tracking-wider mb-1.5 block">Categoria</label>
                <div className="flex flex-wrap gap-1.5">
                  {CATEGORIES.map((cat) => (
                    <button
                      key={cat.value}
                      onClick={() => updateCategory(cat.value)}
                      className={`px-2.5 py-1 rounded-lg text-[11px] font-medium transition-all ${
                        conversation.category === cat.value
                          ? 'bg-emerald-500/15 text-emerald-400 ring-1 ring-emerald-500/30'
                          : 'bg-white/[0.04] text-slate-400 hover:text-slate-200 hover:bg-white/[0.06]'
                      }`}
                    >
                      {cat.label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="flex items-center gap-3 text-sm">
                <Tag className="w-4 h-4 text-slate-500 flex-shrink-0" />
                <span className="text-slate-300 text-xs">
                  ID: {conversation.id.slice(0, 8)}
                </span>
              </div>
            </div>
          )}

          <div className="h-px bg-white/[0.04]" />

          <button
            onClick={() => setShowDirector(!showDirector)}
            className="w-full flex items-center justify-between py-2 text-xs font-medium text-slate-400 hover:text-slate-200 transition-colors"
          >
            <div className="flex items-center gap-1.5">
              <Calendar className="w-3.5 h-3.5" />
              <span>Notas del Director</span>
            </div>
            {showDirector ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
          </button>

          {showDirector && (
            <div className="space-y-3 pb-4 animate-fade-in">
              <textarea
                value={directorNotes}
                onChange={(e) => setDirectorNotes(e.target.value)}
                rows={4}
                className="w-full bg-white/[0.04] border border-white/[0.08] rounded-lg px-3 py-2 text-sm text-white placeholder-slate-500 focus:outline-none focus:ring-1 focus:ring-emerald-500/30 resize-none"
                placeholder="Notas privadas del director sobre esta conversacion..."
              />
              <button
                onClick={saveDirectorNotes}
                className="w-full flex items-center justify-center gap-1.5 px-3 py-2 bg-white/[0.06] hover:bg-white/[0.08] text-slate-300 text-xs font-medium rounded-lg transition-all"
              >
                <Save className="w-3.5 h-3.5" />
                Guardar notas
              </button>
              {conversation.director_reviewed_at && (
                <p className="text-[10px] text-slate-600">
                  Ultima revision: {new Date(conversation.director_reviewed_at).toLocaleString('es-PA')}
                </p>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
