import { createLogger } from '../core/logger.js';
import { downloadMedia, downloadFromUrl, describeImage, transcribeAudio, describeDocument } from './media.js';

const log = createLogger('media-processor');

const FALLBACK_LABELS: Record<string, string> = {
  image: 'El cliente envio una imagen',
  audio: 'El cliente envio un audio',
  video: 'El cliente envio un video',
  document: 'El cliente envio un documento',
};

const MAX_SIZE_BYTES: Record<string, number> = {
  image: 10 * 1024 * 1024,
  audio: 25 * 1024 * 1024,
  document: 20 * 1024 * 1024,
  video: 20 * 1024 * 1024,
};

const MAX_CONCURRENT_MEDIA = 3;
let activeMediaProcessing = 0;
const mediaQueue: Array<() => void> = [];

async function acquireMediaSlot(): Promise<void> {
  if (activeMediaProcessing < MAX_CONCURRENT_MEDIA) {
    activeMediaProcessing++;
    return;
  }
  return new Promise((resolve) => {
    mediaQueue.push(() => {
      activeMediaProcessing++;
      resolve();
    });
  });
}

function releaseMediaSlot(): void {
  activeMediaProcessing--;
  const next = mediaQueue.shift();
  if (next) next();
}

export async function processMediaContent(
  messageType: string,
  mediaId: string,
  mimeType: string,
  localPath: string,
  downloadStatus: string
): Promise<string | null> {
  const fallback = FALLBACK_LABELS[messageType] || `[${messageType}]`;

  await acquireMediaSlot();
  try {
    let buffer: Buffer;
    let resolvedMime = mimeType;

    if (downloadStatus === 'downloaded' && localPath) {
      const result = await downloadFromUrl(localPath);
      buffer = result.buffer;
      resolvedMime = result.mimeType || mimeType;
    } else if (mediaId) {
      const result = await downloadMedia(mediaId);
      buffer = result.buffer;
      resolvedMime = result.mimeType || mimeType;
    } else {
      return fallback;
    }

    if (buffer.length === 0) {
      log.warn('Downloaded media is empty', { messageType, mediaId });
      return fallback;
    }

    const maxSize = MAX_SIZE_BYTES[messageType] || 20 * 1024 * 1024;
    if (buffer.length > maxSize) {
      log.warn('Media exceeds size limit', {
        messageType,
        size: buffer.length,
        maxSize,
      });
      return `${fallback} (archivo demasiado grande para procesar)`;
    }

    switch (messageType) {
      case 'image': {
        const result = await describeImage(buffer, resolvedMime);
        if (result.success && result.description) {
          return `El cliente envio una imagen: ${result.description}`;
        }
        return fallback;
      }

      case 'audio': {
        const result = await transcribeAudio(buffer, resolvedMime);
        if (result.success && result.description) {
          return `El cliente envio un audio diciendo: ${result.description}`;
        }
        return fallback;
      }

      case 'document': {
        const result = await describeDocument(buffer, resolvedMime);
        if (result.success && result.description) {
          return `El cliente envio un documento: ${result.description}`;
        }
        return fallback;
      }

      case 'video':
        return 'El cliente envio un video';

      default:
        return fallback;
    }
  } catch (err) {
    log.error('processMediaContent failed', {
      messageType,
      error: err instanceof Error ? err.message : String(err),
    });
    return fallback;
  } finally {
    releaseMediaSlot();
  }
}
