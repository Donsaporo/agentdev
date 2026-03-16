import { callAISecondary } from './ai.js';
import { createLogger } from '../core/logger.js';

const log = createLogger('name-classifier');

export interface NameClassification {
  cleanName: string;
  clientType: 'individual' | 'business';
  firstName: string;
  lastName: string;
  companyName: string;
  confidence: 'high' | 'medium' | 'low';
}

const EMOJI_REGEX = /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{FE00}-\u{FE0F}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{200D}\u{20E3}\u{E0020}-\u{E007F}]/gu;

export function stripEmojis(text: string): string {
  return text.replace(EMOJI_REGEX, '').replace(/\s+/g, ' ').trim();
}

const BUSINESS_KEYWORDS = [
  'llc', 'inc', 'corp', 'sa', 's.a', 'srl', 's.r.l', 'ltd',
  'group', 'grupo', 'empresa', 'tech', 'solutions', 'consulting',
  'services', 'servicios', 'tienda', 'store', 'shop', 'market',
  'studio', 'estudio', 'agencia', 'agency', 'construccion', 'constructora',
  'inmobiliaria', 'real estate', 'acabados', 'materiales', 'industrias',
  'comercial', 'distribuidora', 'importadora', 'exportadora',
];

function quickClassify(name: string): 'business' | 'individual' | 'unknown' {
  const lower = name.toLowerCase();
  for (const kw of BUSINESS_KEYWORDS) {
    if (lower.includes(kw)) return 'business';
  }
  if (/^\d+$/.test(name)) return 'unknown';
  const words = name.trim().split(/\s+/);
  if (words.length >= 1 && words.length <= 3) {
    const allCapitalized = words.every(
      (w) => /^[A-ZÁÉÍÓÚÑ]/.test(w) && w.length > 1
    );
    if (allCapitalized) return 'individual';
  }
  return 'unknown';
}

export async function classifyName(rawName: string): Promise<NameClassification> {
  const cleaned = stripEmojis(rawName);

  if (!cleaned || /^\d+$/.test(cleaned)) {
    return {
      cleanName: cleaned || rawName,
      clientType: 'individual',
      firstName: '',
      lastName: '',
      companyName: '',
      confidence: 'low',
    };
  }

  const quick = quickClassify(cleaned);

  if (quick === 'individual' && cleaned.split(/\s+/).length <= 3) {
    const parts = cleaned.split(/\s+/);
    return {
      cleanName: cleaned,
      clientType: 'individual',
      firstName: parts[0] || '',
      lastName: parts.slice(1).join(' ') || '',
      companyName: '',
      confidence: 'high',
    };
  }

  if (quick === 'business') {
    return {
      cleanName: cleaned,
      clientType: 'business',
      firstName: '',
      lastName: '',
      companyName: cleaned,
      confidence: 'high',
    };
  }

  try {
    const prompt = `Analiza este nombre de contacto de WhatsApp y clasifícalo. Responde SOLO con JSON valido, sin markdown.

Nombre: "${cleaned}"

Responde con este formato exacto:
{"clientType":"individual|business","firstName":"","lastName":"","companyName":"","confidence":"high|medium|low"}

Reglas:
- Si parece nombre de persona: clientType=individual, divide en firstName y lastName
- Si parece empresa/negocio: clientType=business, pon el nombre en companyName
- Si no estas seguro, usa confidence=low
- firstName y lastName solo si es individual
- companyName solo si es business`;

    const response = await callAISecondary(prompt, [{ role: 'user', content: 'Clasifica.' }], {
      maxTokens: 150,
      temperature: 0,
    });

    const jsonMatch = response.text.match(/\{[^}]+\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        cleanName: cleaned,
        clientType: parsed.clientType === 'business' ? 'business' : 'individual',
        firstName: parsed.firstName || '',
        lastName: parsed.lastName || '',
        companyName: parsed.companyName || '',
        confidence: (['high', 'medium', 'low'].includes(parsed.confidence) ? parsed.confidence : 'medium') as NameClassification['confidence'],
      };
    }
  } catch (err) {
    log.warn('AI name classification failed, using heuristic', {
      name: cleaned,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const parts = cleaned.split(/\s+/);
  return {
    cleanName: cleaned,
    clientType: 'individual',
    firstName: parts[0] || '',
    lastName: parts.slice(1).join(' ') || '',
    companyName: '',
    confidence: 'low',
  };
}
