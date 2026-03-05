import { useState, useRef, useCallback } from 'react';
import { Upload, X, FileText, Image, FileSpreadsheet, Send, Loader2 } from 'lucide-react';
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
  const [projectId, setProjectId] = useState('');
  const [content, setContent] = useState('');
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
    const droppedFiles = Array.from(e.dataTransfer.files);
    droppedFiles.forEach(uploadFile);
  }

  function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const selected = Array.from(e.target.files || []);
    selected.forEach(uploadFile);
    if (inputRef.current) inputRef.current.value = '';
  }

  function removeFile(id: string) {
    setFiles(prev => prev.filter(f => f.id !== id));
  }

  async function handleSubmit() {
    if (!projectId || !content.trim()) return;
    setSubmitting(true);

    onSubmit({
      project_id: projectId,
      original_content: content,
      pages_screens: [],
      features: [],
      design_notes: '',
      integrations: [],
      attachment_urls: files.filter(f => !f.uploading).map(f => f.url),
    });
    setSubmitting(false);
  }

  const isUploading = files.some(f => f.uploading);
  const canSubmit = projectId && content.trim() && !isUploading && !submitting;

  return (
    <div className="space-y-5">
      <div>
        <label className="block text-sm font-medium text-slate-300 mb-1.5">Project</label>
        <select
          value={projectId}
          onChange={e => setProjectId(e.target.value)}
          className="w-full bg-slate-800 border border-slate-700 rounded-lg px-4 py-2.5 text-white focus:outline-none focus:ring-2 focus:ring-emerald-500/50 focus:border-emerald-500 transition-colors"
        >
          <option value="">Select project</option>
          {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </div>

      <div>
        <label className="block text-sm font-medium text-slate-300 mb-1.5">Brief</label>
        <p className="text-xs text-slate-500 mb-2">
          Describe everything about the project. The AI agent will analyze it and decide the pages, features, tech stack, and everything else.
        </p>
        <textarea
          value={content}
          onChange={e => setContent(e.target.value)}
          rows={10}
          className="w-full bg-slate-800 border border-slate-700 rounded-lg px-4 py-3 text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-emerald-500/50 focus:border-emerald-500 transition-colors resize-none text-sm leading-relaxed"
          placeholder="Describe the project in full detail: what it is, who it's for, what it should look like, what features it needs, colors, fonts, references, integrations -- everything. The more detail, the better the result."
        />
      </div>

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

      <div className="flex items-center justify-between pt-2 border-t border-slate-800/40">
        <button onClick={onClose} className="px-4 py-2.5 text-sm text-slate-400 hover:text-slate-200 transition-colors">
          Cancel
        </button>
        <button
          onClick={handleSubmit}
          disabled={!canSubmit}
          className="inline-flex items-center gap-2 px-6 py-2.5 bg-gradient-to-r from-emerald-600 to-cyan-600 hover:from-emerald-500 hover:to-cyan-500 text-white text-sm font-medium rounded-lg transition-all disabled:opacity-40 active:scale-[0.97]"
        >
          {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
          Submit Brief
        </button>
      </div>
    </div>
  );
}
