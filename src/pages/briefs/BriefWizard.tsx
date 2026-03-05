import { useState, useRef, useCallback } from 'react';
import { Upload, X, FileText, Image, FileSpreadsheet, Send, Loader2, ChevronRight, ChevronLeft, Palette, Globe, Paperclip, File as FileEdit } from 'lucide-react';
import { supabase } from '../../lib/supabase';
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
  attachment_urls: string[];
}

interface UploadedFile {
  id: string;
  name: string;
  size: number;
  type: string;
  url: string;
  uploading: boolean;
}

const STEPS = [
  { id: 'project', label: 'Project', icon: FileEdit },
  { id: 'brief', label: 'Brief', icon: FileText },
  { id: 'design', label: 'Design', icon: Palette },
  { id: 'assets', label: 'Assets', icon: Paperclip },
];

const STYLE_OPTIONS = ['Modern & Minimal', 'Bold & Vibrant', 'Corporate & Professional', 'Playful & Creative', 'Elegant & Luxury', 'Tech & Futuristic'];

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function fileIcon(type: string) {
  if (type.includes('pdf')) return <FileText className="w-4 h-4 text-red-400" />;
  if (type.includes('image')) return <Image className="w-4 h-4 text-cyan-400" />;
  if (type.includes('sheet') || type.includes('excel') || type.includes('csv')) return <FileSpreadsheet className="w-4 h-4 text-emerald-400" />;
  return <FileText className="w-4 h-4 text-slate-400" />;
}

export default function BriefWizard({ projects, onSubmit, onClose }: BriefWizardProps) {
  const [step, setStep] = useState(0);
  const [projectId, setProjectId] = useState('');
  const [content, setContent] = useState('');
  const [designStyle, setDesignStyle] = useState('');
  const [referenceUrls, setReferenceUrls] = useState('');
  const [colorNotes, setColorNotes] = useState('');
  const [fontNotes, setFontNotes] = useState('');
  const [files, setFiles] = useState<UploadedFile[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const uploadFile = useCallback(async (file: File) => {
    const tempId = crypto.randomUUID();
    const newFile: UploadedFile = {
      id: tempId,
      name: file.name,
      size: file.size,
      type: file.type,
      url: '',
      uploading: true,
    };
    setFiles(prev => [...prev, newFile]);

    const path = `uploads/${Date.now()}-${file.name.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
    const { error } = await supabase.storage.from('brief-attachments').upload(path, file, { contentType: file.type, upsert: false });

    if (error) {
      setFiles(prev => prev.filter(f => f.id !== tempId));
      return;
    }

    const { data: urlData } = supabase.storage.from('brief-attachments').getPublicUrl(path);
    setFiles(prev => prev.map(f => f.id === tempId ? { ...f, url: urlData.publicUrl, uploading: false } : f));
  }, []);

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);
    Array.from(e.dataTransfer.files).forEach(uploadFile);
  }

  function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    Array.from(e.target.files || []).forEach(uploadFile);
    if (inputRef.current) inputRef.current.value = '';
  }

  function removeFile(id: string) {
    setFiles(prev => prev.filter(f => f.id !== id));
  }

  async function handleSubmit() {
    if (!projectId || !content.trim()) return;
    setSubmitting(true);

    const designSection = [
      designStyle && `Design style: ${designStyle}`,
      colorNotes && `Color preferences: ${colorNotes}`,
      fontNotes && `Font preferences: ${fontNotes}`,
      referenceUrls && `Reference websites:\n${referenceUrls}`,
    ].filter(Boolean).join('\n');

    const fullContent = designSection
      ? `${content}\n\n--- DESIGN PREFERENCES ---\n${designSection}`
      : content;

    onSubmit({
      project_id: projectId,
      original_content: fullContent,
      pages_screens: [],
      features: [],
      design_notes: designSection,
      integrations: [],
      attachment_urls: files.filter(f => !f.uploading).map(f => f.url),
    });
    setSubmitting(false);
  }

  const isUploading = files.some(f => f.uploading);
  const canGoNext = step === 0 ? !!projectId : step === 1 ? content.trim().length > 0 : true;
  const canSubmit = projectId && content.trim() && !isUploading && !submitting;
  const isLastStep = step === STEPS.length - 1;

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-1 px-1">
        {STEPS.map((s, i) => {
          const StepIcon = s.icon;
          const isActive = i === step;
          const isCompleted = i < step;
          return (
            <div key={s.id} className="flex items-center flex-1">
              <button
                onClick={() => i <= step && setStep(i)}
                className={`flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-medium transition-all w-full ${
                  isActive
                    ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
                    : isCompleted
                    ? 'bg-slate-800/30 text-emerald-400/60 cursor-pointer hover:bg-slate-800/50'
                    : 'text-slate-600 cursor-default'
                }`}
              >
                <StepIcon className="w-3.5 h-3.5 flex-shrink-0" />
                <span className="hidden sm:inline">{s.label}</span>
              </button>
              {i < STEPS.length - 1 && (
                <ChevronRight className="w-3.5 h-3.5 text-slate-700 flex-shrink-0 mx-0.5" />
              )}
            </div>
          );
        })}
      </div>

      {step === 0 && (
        <div className="space-y-4 animate-fade-in">
          <div>
            <label className="block text-sm font-medium text-slate-300 mb-1.5">Project</label>
            <p className="text-xs text-slate-500 mb-2">Select which project this brief is for.</p>
            <select
              value={projectId}
              onChange={e => setProjectId(e.target.value)}
              className="w-full bg-slate-800 border border-slate-700 rounded-lg px-4 py-2.5 text-white focus:outline-none focus:ring-2 focus:ring-emerald-500/50 focus:border-emerald-500 transition-colors"
            >
              <option value="">Select project</option>
              {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>
        </div>
      )}

      {step === 1 && (
        <div className="space-y-4 animate-fade-in">
          <div>
            <label className="block text-sm font-medium text-slate-300 mb-1.5">Project Brief</label>
            <p className="text-xs text-slate-500 mb-2">
              Describe everything about the project. The AI agent will analyze it and plan the pages, features, tech stack, and design automatically.
            </p>
            <textarea
              value={content}
              onChange={e => setContent(e.target.value)}
              rows={12}
              autoFocus
              className="w-full bg-slate-800 border border-slate-700 rounded-lg px-4 py-3 text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-emerald-500/50 focus:border-emerald-500 transition-colors resize-none text-sm leading-relaxed"
              placeholder={"Describe the project in full detail:\n\n- What is it? (website, e-commerce store, dashboard, etc.)\n- Who is it for? (target audience)\n- What pages does it need?\n- What features are required?\n- Any specific integrations? (payments, email, analytics)\n- Content details (text, images, products)\n- Any reference sites to draw inspiration from?\n\nThe more detail you provide, the better the result."}
            />
            <div className="flex items-center justify-between mt-1">
              <span className="text-xs text-slate-600">{content.length} characters</span>
              {content.length > 100 && content.length < 300 && (
                <span className="text-xs text-amber-500">Consider adding more detail for best results</span>
              )}
              {content.length >= 300 && (
                <span className="text-xs text-emerald-500">Good level of detail</span>
              )}
            </div>
          </div>
        </div>
      )}

      {step === 2 && (
        <div className="space-y-4 animate-fade-in">
          <div>
            <label className="block text-sm font-medium text-slate-300 mb-1.5">Design Style</label>
            <p className="text-xs text-slate-500 mb-2">Pick the overall feel. The agent uses this plus client brand info.</p>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
              {STYLE_OPTIONS.map(style => (
                <button
                  key={style}
                  onClick={() => setDesignStyle(designStyle === style ? '' : style)}
                  className={`px-3 py-2.5 text-xs font-medium rounded-lg border transition-all text-left ${
                    designStyle === style
                      ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-400'
                      : 'border-slate-700 bg-slate-800/30 text-slate-400 hover:border-slate-600 hover:text-slate-300'
                  }`}
                >
                  {style}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-300 mb-1.5">Color Preferences</label>
            <input
              type="text"
              value={colorNotes}
              onChange={e => setColorNotes(e.target.value)}
              placeholder="e.g., Navy blue and gold, or match the client's logo"
              className="w-full bg-slate-800 border border-slate-700 rounded-lg px-4 py-2.5 text-white text-sm placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-emerald-500/50 focus:border-emerald-500 transition-colors"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-300 mb-1.5">Font Preferences</label>
            <input
              type="text"
              value={fontNotes}
              onChange={e => setFontNotes(e.target.value)}
              placeholder="e.g., Modern sans-serif, or Inter/Poppins"
              className="w-full bg-slate-800 border border-slate-700 rounded-lg px-4 py-2.5 text-white text-sm placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-emerald-500/50 focus:border-emerald-500 transition-colors"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-300 mb-1.5">
              <Globe className="w-3.5 h-3.5 inline mr-1.5 -mt-0.5" />
              Reference Websites
            </label>
            <p className="text-xs text-slate-500 mb-2">URLs of sites the agent should study for inspiration (one per line).</p>
            <textarea
              value={referenceUrls}
              onChange={e => setReferenceUrls(e.target.value)}
              rows={3}
              placeholder={"https://example.com\nhttps://inspiration-site.com"}
              className="w-full bg-slate-800 border border-slate-700 rounded-lg px-4 py-2.5 text-white text-sm placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-emerald-500/50 focus:border-emerald-500 transition-colors resize-none font-mono"
            />
          </div>
        </div>
      )}

      {step === 3 && (
        <div className="space-y-4 animate-fade-in">
          <div>
            <label className="block text-sm font-medium text-slate-300 mb-1.5">Attachments</label>
            <p className="text-xs text-slate-500 mb-2">
              Upload PDFs (brand manuals, specs), images (logos, screenshots, references), spreadsheets -- anything the agent needs.
            </p>

            <div
              onDragOver={e => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onDrop={handleDrop}
              onClick={() => inputRef.current?.click()}
              className={`border-2 border-dashed rounded-xl p-8 text-center cursor-pointer transition-all ${
                dragOver
                  ? 'border-emerald-500 bg-emerald-500/5'
                  : 'border-slate-700 hover:border-slate-600 hover:bg-slate-800/20'
              }`}
            >
              <Upload className={`w-8 h-8 mx-auto mb-3 ${dragOver ? 'text-emerald-400' : 'text-slate-500'}`} />
              <p className="text-sm text-slate-300 font-medium">Drop files here or click to browse</p>
              <p className="text-xs text-slate-500 mt-1">PDF, Images, Excel, CSV, or any document</p>
              <input
                ref={inputRef}
                type="file"
                multiple
                accept=".pdf,.png,.jpg,.jpeg,.gif,.webp,.svg,.xlsx,.xls,.csv,.doc,.docx,.txt"
                onChange={handleFileSelect}
                className="hidden"
              />
            </div>

            {files.length > 0 && (
              <div className="mt-3 space-y-2">
                {files.map(file => (
                  <div key={file.id} className="flex items-center gap-3 bg-slate-800/30 rounded-lg px-3 py-2.5">
                    {fileIcon(file.type)}
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-slate-200 truncate">{file.name}</p>
                      <p className="text-xs text-slate-500">{formatSize(file.size)}</p>
                    </div>
                    {file.uploading ? (
                      <Loader2 className="w-4 h-4 text-emerald-400 animate-spin flex-shrink-0" />
                    ) : (
                      <button onClick={() => removeFile(file.id)} className="text-slate-500 hover:text-red-400 transition-colors flex-shrink-0">
                        <X className="w-4 h-4" />
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      <div className="flex items-center justify-between pt-2 border-t border-slate-800/40">
        {step === 0 ? (
          <button onClick={onClose} className="px-4 py-2.5 text-sm text-slate-400 hover:text-slate-200 transition-colors">
            Cancel
          </button>
        ) : (
          <button
            onClick={() => setStep(s => s - 1)}
            className="inline-flex items-center gap-1.5 px-4 py-2.5 text-sm text-slate-400 hover:text-slate-200 transition-colors"
          >
            <ChevronLeft className="w-4 h-4" /> Back
          </button>
        )}

        {isLastStep ? (
          <button
            onClick={handleSubmit}
            disabled={!canSubmit}
            className="inline-flex items-center gap-2 px-6 py-2.5 bg-gradient-to-r from-emerald-600 to-cyan-600 hover:from-emerald-500 hover:to-cyan-500 text-white text-sm font-medium rounded-lg transition-all disabled:opacity-40 active:scale-[0.97]"
          >
            {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
            Submit Brief
          </button>
        ) : (
          <button
            onClick={() => setStep(s => s + 1)}
            disabled={!canGoNext}
            className="inline-flex items-center gap-2 px-5 py-2.5 bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-medium rounded-lg transition-all disabled:opacity-40 active:scale-[0.97]"
          >
            Next <ChevronRight className="w-4 h-4" />
          </button>
        )}
      </div>
    </div>
  );
}
