import { useState } from 'react';
import { ChevronLeft, ChevronRight, Plus, X, Check, Send } from 'lucide-react';
import type { Project } from '../../lib/types';

interface BriefWizardProps {
  projects: Project[];
  onSubmit: (data: BriefFormData) => void;
  onClose: () => void;
}

export interface BriefFormData {
  project_id: string;
  original_content: string;
  pages_screens: string[];
  features: string[];
  design_notes: string;
  integrations: string[];
}

const FEATURE_OPTIONS = [
  'Contact Form', 'Blog', 'E-commerce', 'User Login', 'Newsletter Signup',
  'Gallery', 'Testimonials', 'FAQ Section', 'Live Chat', 'Analytics',
  'Search', 'Multi-language', 'CMS', 'Booking System', 'Payment Processing',
];

const INTEGRATION_OPTIONS = [
  'Stripe', 'Resend (Email)', 'Google Analytics', 'WhatsApp', 'Calendly',
  'HubSpot CRM', 'Mailchimp', 'Social Media Feeds', 'Google Maps',
];

const steps = [
  { num: 1, label: 'Project' },
  { num: 2, label: 'Pages' },
  { num: 3, label: 'Features' },
  { num: 4, label: 'Design' },
  { num: 5, label: 'Integrations' },
  { num: 6, label: 'Review' },
];

export default function BriefWizard({ projects, onSubmit, onClose }: BriefWizardProps) {
  const [step, setStep] = useState(1);
  const [form, setForm] = useState<BriefFormData>({
    project_id: '',
    original_content: '',
    pages_screens: ['Home'],
    features: [],
    design_notes: '',
    integrations: [],
  });
  const [newPage, setNewPage] = useState('');

  function addPage() {
    const trimmed = newPage.trim();
    if (trimmed && !form.pages_screens.includes(trimmed)) {
      setForm({ ...form, pages_screens: [...form.pages_screens, trimmed] });
    }
    setNewPage('');
  }

  function removePage(page: string) {
    setForm({ ...form, pages_screens: form.pages_screens.filter(p => p !== page) });
  }

  function toggleFeature(feature: string) {
    setForm({
      ...form,
      features: form.features.includes(feature)
        ? form.features.filter(f => f !== feature)
        : [...form.features, feature],
    });
  }

  function toggleIntegration(integ: string) {
    setForm({
      ...form,
      integrations: form.integrations.includes(integ)
        ? form.integrations.filter(i => i !== integ)
        : [...form.integrations, integ],
    });
  }

  const canProceed = () => {
    if (step === 1) return form.project_id && form.original_content.trim();
    if (step === 2) return form.pages_screens.length > 0;
    return true;
  };

  const selectedProject = projects.find(p => p.id === form.project_id);

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2 overflow-x-auto pb-2">
        {steps.map((s, i) => (
          <div key={s.num} className="flex items-center">
            <button
              onClick={() => step > s.num ? setStep(s.num) : undefined}
              className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-all whitespace-nowrap ${
                step === s.num
                  ? 'bg-emerald-500/10 text-emerald-400'
                  : step > s.num
                    ? 'text-emerald-400/60 cursor-pointer hover:bg-slate-800/30'
                    : 'text-slate-600'
              }`}
            >
              {step > s.num ? (
                <Check className="w-3.5 h-3.5" />
              ) : (
                <span className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold ${
                  step === s.num ? 'bg-emerald-500 text-white' : 'bg-slate-800 text-slate-500'
                }`}>
                  {s.num}
                </span>
              )}
              <span className="hidden sm:inline">{s.label}</span>
            </button>
            {i < steps.length - 1 && (
              <div className={`w-4 h-px mx-1 ${step > s.num ? 'bg-emerald-500/30' : 'bg-slate-800'}`} />
            )}
          </div>
        ))}
      </div>

      <div className="min-h-[320px]">
        {step === 1 && (
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-slate-300 mb-1.5">Project</label>
              <select
                value={form.project_id}
                onChange={e => setForm({ ...form, project_id: e.target.value })}
                className="w-full bg-slate-800 border border-slate-700 rounded-lg px-4 py-2.5 text-white focus:outline-none focus:ring-2 focus:ring-emerald-500/50 focus:border-emerald-500 transition-colors"
              >
                <option value="">Select project</option>
                {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-300 mb-1.5">Project Description</label>
              <textarea
                value={form.original_content}
                onChange={e => setForm({ ...form, original_content: e.target.value })}
                rows={8}
                className="w-full bg-slate-800 border border-slate-700 rounded-lg px-4 py-2.5 text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-emerald-500/50 focus:border-emerald-500 transition-colors resize-none text-sm"
                placeholder="Describe the project in detail. What is it for? Who is the target audience? What should it look and feel like?"
              />
            </div>
          </div>
        )}

        {step === 2 && (
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-slate-300 mb-1.5">Pages / Screens</label>
              <p className="text-xs text-slate-500 mb-3">List all the pages your project needs</p>
            </div>
            <div className="flex flex-wrap gap-2">
              {form.pages_screens.map(page => (
                <span key={page} className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-slate-800 border border-slate-700/60 rounded-lg text-sm text-white">
                  {page}
                  <button onClick={() => removePage(page)} className="text-slate-500 hover:text-red-400 transition-colors">
                    <X className="w-3 h-3" />
                  </button>
                </span>
              ))}
            </div>
            <div className="flex gap-2">
              <input
                type="text"
                value={newPage}
                onChange={e => setNewPage(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && (e.preventDefault(), addPage())}
                placeholder="Add a page..."
                className="flex-1 bg-slate-800 border border-slate-700 rounded-lg px-4 py-2.5 text-sm text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-emerald-500/50 transition-colors"
              />
              <button
                onClick={addPage}
                className="px-3 py-2.5 bg-slate-800 border border-slate-700 rounded-lg text-slate-300 hover:text-white hover:bg-slate-700 transition-colors"
              >
                <Plus className="w-4 h-4" />
              </button>
            </div>
          </div>
        )}

        {step === 3 && (
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-slate-300 mb-1.5">Features</label>
              <p className="text-xs text-slate-500 mb-3">Select the features this project needs</p>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
              {FEATURE_OPTIONS.map(feature => (
                <button
                  key={feature}
                  onClick={() => toggleFeature(feature)}
                  className={`text-left px-3 py-2.5 rounded-lg text-sm font-medium transition-all border ${
                    form.features.includes(feature)
                      ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400'
                      : 'bg-slate-800/30 border-slate-700/30 text-slate-400 hover:text-slate-200 hover:border-slate-600'
                  }`}
                >
                  {feature}
                </button>
              ))}
            </div>
          </div>
        )}

        {step === 4 && (
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-slate-300 mb-1.5">Design Preferences</label>
              <p className="text-xs text-slate-500 mb-3">Describe the visual style, colors, inspiration sites, etc.</p>
            </div>
            <textarea
              value={form.design_notes}
              onChange={e => setForm({ ...form, design_notes: e.target.value })}
              rows={8}
              className="w-full bg-slate-800 border border-slate-700 rounded-lg px-4 py-2.5 text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-emerald-500/50 focus:border-emerald-500 transition-colors resize-none text-sm"
              placeholder="Color scheme preferences, reference websites for inspiration, brand guidelines, typography preferences, etc."
            />
          </div>
        )}

        {step === 5 && (
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-slate-300 mb-1.5">Integrations</label>
              <p className="text-xs text-slate-500 mb-3">Select third-party services to integrate</p>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
              {INTEGRATION_OPTIONS.map(integ => (
                <button
                  key={integ}
                  onClick={() => toggleIntegration(integ)}
                  className={`text-left px-3 py-2.5 rounded-lg text-sm font-medium transition-all border ${
                    form.integrations.includes(integ)
                      ? 'bg-cyan-500/10 border-cyan-500/30 text-cyan-400'
                      : 'bg-slate-800/30 border-slate-700/30 text-slate-400 hover:text-slate-200 hover:border-slate-600'
                  }`}
                >
                  {integ}
                </button>
              ))}
            </div>
          </div>
        )}

        {step === 6 && (
          <div className="space-y-4">
            <h3 className="text-sm font-semibold text-white">Review Brief</h3>
            <div className="bg-slate-800/30 rounded-lg p-4 space-y-3 text-sm">
              <div>
                <span className="text-xs text-slate-500">Project</span>
                <p className="text-white">{selectedProject?.name || 'Unknown'}</p>
              </div>
              <div>
                <span className="text-xs text-slate-500">Description</span>
                <p className="text-slate-300 line-clamp-4">{form.original_content}</p>
              </div>
              <div>
                <span className="text-xs text-slate-500">Pages ({form.pages_screens.length})</span>
                <div className="flex flex-wrap gap-1 mt-1">
                  {form.pages_screens.map(p => (
                    <span key={p} className="text-xs px-2 py-0.5 bg-slate-700 text-slate-300 rounded">{p}</span>
                  ))}
                </div>
              </div>
              {form.features.length > 0 && (
                <div>
                  <span className="text-xs text-slate-500">Features ({form.features.length})</span>
                  <div className="flex flex-wrap gap-1 mt-1">
                    {form.features.map(f => (
                      <span key={f} className="text-xs px-2 py-0.5 bg-emerald-500/10 text-emerald-400 rounded">{f}</span>
                    ))}
                  </div>
                </div>
              )}
              {form.design_notes && (
                <div>
                  <span className="text-xs text-slate-500">Design Notes</span>
                  <p className="text-slate-300 line-clamp-3">{form.design_notes}</p>
                </div>
              )}
              {form.integrations.length > 0 && (
                <div>
                  <span className="text-xs text-slate-500">Integrations ({form.integrations.length})</span>
                  <div className="flex flex-wrap gap-1 mt-1">
                    {form.integrations.map(i => (
                      <span key={i} className="text-xs px-2 py-0.5 bg-cyan-500/10 text-cyan-400 rounded">{i}</span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      <div className="flex items-center justify-between pt-2 border-t border-slate-800/40">
        <button
          onClick={() => step > 1 ? setStep(step - 1) : onClose()}
          className="inline-flex items-center gap-1 px-4 py-2.5 text-sm text-slate-400 hover:text-slate-200 transition-colors"
        >
          <ChevronLeft className="w-4 h-4" />
          {step > 1 ? 'Back' : 'Cancel'}
        </button>
        {step < 6 ? (
          <button
            onClick={() => setStep(step + 1)}
            disabled={!canProceed()}
            className="inline-flex items-center gap-1 px-5 py-2.5 bg-gradient-to-r from-emerald-600 to-cyan-600 hover:from-emerald-500 hover:to-cyan-500 text-white text-sm font-medium rounded-lg transition-all disabled:opacity-40"
          >
            Next <ChevronRight className="w-4 h-4" />
          </button>
        ) : (
          <button
            onClick={() => onSubmit(form)}
            className="inline-flex items-center gap-2 px-6 py-2.5 bg-gradient-to-r from-emerald-600 to-cyan-600 hover:from-emerald-500 hover:to-cyan-500 text-white text-sm font-medium rounded-lg transition-all"
          >
            <Send className="w-4 h-4" /> Submit Brief
          </button>
        )}
      </div>
    </div>
  );
}
