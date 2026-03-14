import { createLogger } from '../core/logger.js';
import { downloadMedia, downloadFromUrl, describeImage, transcribeAudio, describeDocument } from './media.js';

const log = createLogger('media-processor');

const FALLBACK_LABELS: Record<string, string> = {
  image: 'El cliente envio una imagen',
  audio: 'El cliente envio un audio',
  video: 'El cliente envio un video',
  document: 'El cliente envio un documento',
};

export async function processMediaContent(
  messageType: string,
  mediaId: string,
  mimeType: string,
  localPath: string,
  downloadStatus: string
): Promise<string | null> {
  const fallback = FALLBACK_LABELS[messageType] || `[${messageType}]`;

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
  }
}
