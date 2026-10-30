/**
 * Files people share with each other — a community Resource's attachment and a
 * direct-message attachment. One allow-list and one sniffer, so both surfaces
 * accept exactly the same bytes and verify them the same way.
 *
 * ONLY what can be safely magic-byte verified AND rendered in a browser: PDF
 * and raster images. NOT SVG (it is XML that can carry script, and these are
 * streamed from the API origin with the viewer's cookie in scope — the same
 * reason §10.10 and §10.26 refuse it). Office documents are deliberately out:
 * they are ZIP containers whose bytes cannot be told apart from any other zip,
 * so they cannot be verified here — share those as a LINK (a resource may be a
 * link), which is exactly what the feature is for.
 */
export const ALLOWED_SHARED_FILE_TYPES = [
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
] as const;

export const SHARED_FILE_EXTENSION: Record<string, string> = {
  'application/pdf': 'pdf',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

/**
 * 15 MiB. A shared resource is a checklist, a slide export or a photo, not a
 * video. The ceiling is also practical: a multipart upload travels through
 * nginx, which caps the request body at 20 MiB at the origin (the prod note on
 * upload ceilings), so 15 leaves headroom rather than surfacing as a raw 413.
 */
export const SHARED_FILE_MAX_BYTES = 15 * 1024 * 1024;

/**
 * The type the bytes themselves declare, or null — a sanity check on the
 * client-written Content-Type, not a parser. Same short-signature approach as
 * `sniffType` in external-certifications and `sniffImageType` in media.
 */
export function sniffSharedFileType(bytes: Buffer): string | null {
  if (bytes.length < 12) return null;
  if (bytes.subarray(0, 5).toString('ascii') === '%PDF-') return 'application/pdf';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (
    bytes
      .subarray(0, 8)
      .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return 'image/png';
  }
  if (
    bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
    bytes.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'image/webp';
  }
  const head = bytes.subarray(0, 6).toString('ascii');
  if (head === 'GIF87a' || head === 'GIF89a') return 'image/gif';
  return null;
}

/** Whether a stored MIME is an image (the client can preview it inline). */
export function isSharedImage(mime: string | null | undefined): boolean {
  return !!mime && mime.startsWith('image/');
}
