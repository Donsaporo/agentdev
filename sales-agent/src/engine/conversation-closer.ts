import { createLogger } from '../core/logger.js';

const log = createLogger('conversation-closer');

const FAREWELL_PATTERNS = [
  /^(ok|okey|okay|okk+|oki)\.?$/i,
  /^(listo|listoo+)\.?$/i,
  /^(gracias|graci|grax|thx|thanks|ty)\.?$/i,
  /^(igualmente|igual)\.?$/i,
  /^(dale|va|va pues|dale dale|listo dale)\.?$/i,
  /^(perfecto|perfect|excelente|genial)\.?$/i,
  /^(bueno|buenoo+)\.?$/i,
  /^(bien|esta bien|todo bien)\.?$/i,
  /^(chao|chau|bye|adios|adiós|nos vemos|hasta luego|hasta pronto)\.?$/i,
  /^(saludos|un saludo|bendiciones)\.?$/i,
  /^(de nada|denada)\.?$/i,
  /^(claro|claro que si|por supuesto)\.?$/i,
  /^(muchas gracias|mil gracias)\.?$/i,
  /^(esta bien|estamos)\.?$/i,
  /^(entendido|entiendo)\.?$/i,
  /^(ya|ya ya|sisi|si si)\.?$/i,
  /^(👍|👋|🙏|✅|😊|🤝|💪)$/,
];

const POST_FAREWELL_PATTERNS = [
  /^(ok|okey|okay|okk+|oki)\.?$/i,
  /^(listo|listoo+)\.?$/i,
  /^(gracias|graci|grax)\.?$/i,
  /^(igualmente|igual)\.?$/i,
  /^(dale|va)\.?$/i,
  /^(chao|chau|bye|adios|adiós)\.?$/i,
  /^(saludos|bendiciones)\.?$/i,
  /^(de nada|denada)\.?$/i,
  /^(👍|👋|🙏|✅|😊|🤝|💪)$/,
  /^(bueno|bien|perfecto|genial|excelente)\.?$/i,
  /^(muchas gracias|mil gracias)\.?$/i,
  /^(si|sisi|ya)\.?$/i,
];

const farewellSent = new Map<string, number>();
const FAREWELL_COOLDOWN = 2 * 60 * 60_000;

function cleanMessage(text: string): string {
  return text.trim().replace(/\s+/g, ' ').replace(/[.!,;:]+$/g, '').trim();
}

export function isFarewellMessage(text: string): boolean {
  const cleaned = cleanMessage(text);
  if (cleaned.length > 60) return false;
  return FAREWELL_PATTERNS.some((p) => p.test(cleaned));
}

export function isPostFarewellMessage(text: string): boolean {
  const cleaned = cleanMessage(text);
  if (cleaned.length > 30) return false;
  return POST_FAREWELL_PATTERNS.some((p) => p.test(cleaned));
}

export function hasSentFarewell(conversationId: string): boolean {
  const sentAt = farewellSent.get(conversationId);
  if (!sentAt) return false;
  if (Date.now() - sentAt > FAREWELL_COOLDOWN) {
    farewellSent.delete(conversationId);
    return false;
  }
  return true;
}

export function markFarewellSent(conversationId: string): void {
  farewellSent.set(conversationId, Date.now());
  log.debug('Farewell marked for conversation', { conversationId });
}

export function clearFarewell(conversationId: string): void {
  farewellSent.delete(conversationId);
}

export function shouldSkipResponse(conversationId: string, incomingText: string): boolean {
  if (!hasSentFarewell(conversationId)) return false;

  if (isPostFarewellMessage(incomingText)) {
    log.info('Skipping response to post-farewell message', {
      conversationId,
      message: incomingText.slice(0, 30),
    });
    return true;
  }

  clearFarewell(conversationId);
  return false;
}
