import { useState, useRef } from 'react';
import { Upload, FileText, CheckCircle2, AlertCircle, Download, X, Loader2 } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useToast } from '../contexts/ToastContext';

interface ParsedRow {
  phone: string;
  name: string;
  email: string;
  company: string;
  notes: string;
}

interface ImportResult {
  total: number;
  created: number;
  skipped: number;
  errors: string[];
}

function parseCSV(text: string): ParsedRow[] {
  const lines = text.trim().split('\n');
  if (lines.length < 2) return [];

  const header = lines[0].toLowerCase().split(',').map((h) => h.trim().replace(/"/g, ''));

  const phoneIdx = header.findIndex((h) =>
    ['phone', 'telefono', 'numero', 'whatsapp', 'phone_number'].includes(h)
  );
  const nameIdx = header.findIndex((h) =>
    ['name', 'nombre', 'display_name', 'contact_name'].includes(h)
  );
  const emailIdx = header.findIndex((h) =>
    ['email', 'correo', 'e-mail'].includes(h)
  );
  const companyIdx = header.findIndex((h) =>
    ['company', 'empresa', 'company_name', 'organizacion'].includes(h)
  );
  const notesIdx = header.findIndex((h) =>
    ['notes', 'notas', 'observaciones', 'comentarios'].includes(h)
  );

  if (phoneIdx === -1) return [];

  const rows: ParsedRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',').map((c) => c.trim().replace(/^"|"$/g, ''));
    const phone = cols[phoneIdx]?.replace(/[\s\-\(\)]/g, '') || '';
    if (!phone) continue;

    rows.push({
      phone,
      name: nameIdx >= 0 ? cols[nameIdx] || '' : '',
      email: emailIdx >= 0 ? cols[emailIdx] || '' : '',
      company: companyIdx >= 0 ? cols[companyIdx] || '' : '',
      notes: notesIdx >= 0 ? cols[notesIdx] || '' : '',
    });
  }

  return rows;
}

export default function ImportPage() {
  const toast = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [parsed, setParsed] = useState<ParsedRow[]>([]);
  const [fileName, setFileName] = useState('');
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);

  function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    setFileName(file.name);
    setResult(null);

    const reader = new FileReader();
    reader.onload = (ev) => {
      const text = ev.target?.result as string;
      const rows = parseCSV(text);
      setParsed(rows);
      if (rows.length === 0) {
        toast.error('No se encontraron contactos validos. Asegurate de tener una columna "phone" o "telefono".');
      }
    };
    reader.readAsText(file);
  }

  function clearFile() {
    setParsed([]);
    setFileName('');
    setResult(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }

  async function handleImport() {
    if (parsed.length === 0) return;
    setImporting(true);

    const importResult: ImportResult = { total: parsed.length, created: 0, skipped: 0, errors: [] };

    for (const row of parsed) {
      try {
        const { data: existing } = await supabase
          .from('whatsapp_contacts')
          .select('id')
          .or(`wa_id.eq.${row.phone},phone_number.eq.${row.phone}`)
          .maybeSingle();

        if (existing) {
          importResult.skipped++;
          continue;
        }

        const { error } = await supabase.from('whatsapp_contacts').insert({
          wa_id: row.phone,
          phone_number: row.phone,
          display_name: row.name || row.phone,
          profile_name: row.name || '',
          email: row.email || null,
          company: row.company || null,
          notes: row.notes || null,
          lead_stage: 'nuevo',
          is_imported: true,
          intro_sent: true,
        });

        if (error) {
          importResult.errors.push(`${row.phone}: ${error.message}`);
        } else {
          importResult.created++;
        }
      } catch (err) {
        importResult.errors.push(`${row.phone}: ${err instanceof Error ? err.message : 'Error desconocido'}`);
      }
    }

    setResult(importResult);
    setImporting(false);
    toast.success(`Importacion completada: ${importResult.created} creados, ${importResult.skipped} existentes`);
  }

  function downloadTemplate() {
    const csv = 'phone,name,email,company,notes\n+507XXXXXXXX,Juan Perez,juan@ejemplo.com,Empresa SA,Nota opcional\n';
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'plantilla_importacion.csv';
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-white">Importar Contactos</h1>
        <p className="text-sm text-slate-400 mt-1">
          Sube un archivo CSV con numeros de telefono para importarlos como contactos existentes.
          Estos contactos no recibiran el mensaje de intro cuando escriban.
        </p>
      </div>

      <div className="bg-white/[0.02] border border-white/[0.06] rounded-2xl p-6 mb-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-semibold text-white">Archivo CSV</h2>
          <button
            onClick={downloadTemplate}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-400 hover:text-emerald-400 border border-white/[0.06] hover:border-emerald-500/20 rounded-lg transition-all"
          >
            <Download className="w-3.5 h-3.5" />
            Descargar plantilla
          </button>
        </div>

        <div className="text-xs text-slate-500 mb-4 space-y-1">
          <p>Columnas requeridas: <span className="text-slate-300">phone</span> (o telefono, numero, whatsapp)</p>
          <p>Columnas opcionales: <span className="text-slate-300">name, email, company, notes</span></p>
        </div>

        {!fileName ? (
          <label className="flex flex-col items-center justify-center py-12 border-2 border-dashed border-white/[0.08] rounded-xl cursor-pointer hover:border-emerald-500/20 hover:bg-emerald-500/[0.02] transition-all group">
            <Upload className="w-10 h-10 text-slate-600 group-hover:text-emerald-500/50 mb-3 transition-colors" />
            <span className="text-sm text-slate-400 group-hover:text-slate-300 transition-colors">
              Arrastra un CSV o haz clic para seleccionar
            </span>
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv,text/csv"
              onChange={handleFileSelect}
              className="hidden"
            />
          </label>
        ) : (
          <div className="flex items-center gap-3 p-4 bg-white/[0.03] border border-white/[0.06] rounded-xl">
            <FileText className="w-8 h-8 text-emerald-400 flex-shrink-0" />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-white truncate">{fileName}</p>
              <p className="text-xs text-slate-400">{parsed.length} contactos encontrados</p>
            </div>
            <button
              onClick={clearFile}
              className="p-1.5 rounded-lg hover:bg-white/[0.06] text-slate-500 hover:text-slate-300 transition-all"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        )}
      </div>

      {parsed.length > 0 && !result && (
        <div className="bg-white/[0.02] border border-white/[0.06] rounded-2xl p-6 mb-6">
          <h2 className="text-sm font-semibold text-white mb-4">Vista previa ({parsed.length} contactos)</h2>

          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-white/[0.06]">
                  <th className="text-left py-2 px-3 text-slate-500 font-medium">Telefono</th>
                  <th className="text-left py-2 px-3 text-slate-500 font-medium">Nombre</th>
                  <th className="text-left py-2 px-3 text-slate-500 font-medium">Email</th>
                  <th className="text-left py-2 px-3 text-slate-500 font-medium">Empresa</th>
                </tr>
              </thead>
              <tbody>
                {parsed.slice(0, 20).map((row, i) => (
                  <tr key={i} className="border-b border-white/[0.03]">
                    <td className="py-2 px-3 text-slate-300 font-mono">{row.phone}</td>
                    <td className="py-2 px-3 text-slate-300">{row.name || '--'}</td>
                    <td className="py-2 px-3 text-slate-400">{row.email || '--'}</td>
                    <td className="py-2 px-3 text-slate-400">{row.company || '--'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {parsed.length > 20 && (
              <p className="text-xs text-slate-500 mt-2 px-3">
                ...y {parsed.length - 20} contactos mas
              </p>
            )}
          </div>

          <div className="mt-6 flex justify-end">
            <button
              onClick={handleImport}
              disabled={importing}
              className="flex items-center gap-2 px-5 py-2.5 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white text-sm font-medium rounded-xl transition-all"
            >
              {importing ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Importando...
                </>
              ) : (
                <>
                  <Upload className="w-4 h-4" />
                  Importar {parsed.length} contactos
                </>
              )}
            </button>
          </div>
        </div>
      )}

      {result && (
        <div className="bg-white/[0.02] border border-white/[0.06] rounded-2xl p-6">
          <h2 className="text-sm font-semibold text-white mb-4">Resultado de importacion</h2>

          <div className="grid grid-cols-3 gap-4 mb-4">
            <div className="bg-emerald-500/5 border border-emerald-500/10 rounded-xl p-4 text-center">
              <CheckCircle2 className="w-6 h-6 text-emerald-400 mx-auto mb-1" />
              <p className="text-2xl font-bold text-emerald-400">{result.created}</p>
              <p className="text-xs text-slate-400">Creados</p>
            </div>
            <div className="bg-amber-500/5 border border-amber-500/10 rounded-xl p-4 text-center">
              <AlertCircle className="w-6 h-6 text-amber-400 mx-auto mb-1" />
              <p className="text-2xl font-bold text-amber-400">{result.skipped}</p>
              <p className="text-xs text-slate-400">Ya existentes</p>
            </div>
            <div className="bg-red-500/5 border border-red-500/10 rounded-xl p-4 text-center">
              <X className="w-6 h-6 text-red-400 mx-auto mb-1" />
              <p className="text-2xl font-bold text-red-400">{result.errors.length}</p>
              <p className="text-xs text-slate-400">Errores</p>
            </div>
          </div>

          {result.errors.length > 0 && (
            <div className="bg-red-500/5 border border-red-500/10 rounded-xl p-4">
              <p className="text-xs font-medium text-red-400 mb-2">Errores:</p>
              <div className="space-y-1 max-h-40 overflow-y-auto">
                {result.errors.map((err, i) => (
                  <p key={i} className="text-xs text-red-300/70 font-mono">{err}</p>
                ))}
              </div>
            </div>
          )}

          <div className="mt-4 flex justify-end">
            <button
              onClick={clearFile}
              className="px-4 py-2 text-sm text-slate-400 hover:text-white border border-white/[0.06] rounded-xl hover:bg-white/[0.04] transition-all"
            >
              Nueva importacion
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
