/**
 * Extension -> Content-Type for SCORM package assets.
 *
 * Hand-rolled rather than pulling in `mime-types`, for the same reason
 * `EntitlementCache` is hand-rolled rather than an LRU package: the set of
 * things a SCORM package actually contains is small and known, and `mime-types`
 * v3 ships no TypeScript typings, so using it would mean a dependency plus a
 * separately-versioned `@types` package to serve a fixed list of extensions.
 *
 * Getting these right matters more than it looks. A `.js` served as
 * `application/octet-stream` is refused by the browser under
 * `X-Content-Type-Options: nosniff`, and the package's runtime simply never
 * starts — with no error the learner or an admin could act on. On the `local`
 * driver `express.static` did this for us; the `s3` driver has to set the type
 * at upload time, so the mapping had to become explicit.
 */
const CONTENT_TYPES: Record<string, string> = {
  // Documents and markup
  html: 'text/html',
  htm: 'text/html',
  xml: 'text/xml',
  xsd: 'text/xml',
  css: 'text/css',
  txt: 'text/plain',
  csv: 'text/csv',
  pdf: 'application/pdf',
  // Scripts and data
  js: 'text/javascript',
  mjs: 'text/javascript',
  json: 'application/json',
  map: 'application/json',
  // Images
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  webp: 'image/webp',
  ico: 'image/x-icon',
  bmp: 'image/bmp',
  // Fonts
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  eot: 'application/vnd.ms-fontobject',
  // Media — the reason assets are streamed rather than buffered
  mp4: 'video/mp4',
  webm: 'video/webm',
  ogv: 'video/ogg',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  // Archives occasionally shipped inside a package
  zip: 'application/zip',
  swf: 'application/x-shockwave-flash',
};

export const DEFAULT_CONTENT_TYPE = 'application/octet-stream';

/** Charset is appended for text types so a UTF-8 package renders correctly. */
export function contentTypeFor(pathOrKey: string): string {
  const lastDot = pathOrKey.lastIndexOf('.');
  const lastSlash = Math.max(
    pathOrKey.lastIndexOf('/'),
    pathOrKey.lastIndexOf('\\'),
  );
  if (lastDot <= lastSlash) return DEFAULT_CONTENT_TYPE;

  const extension = pathOrKey.slice(lastDot + 1).toLowerCase();
  const type = CONTENT_TYPES[extension];
  if (!type) return DEFAULT_CONTENT_TYPE;

  return type.startsWith('text/') || type === 'image/svg+xml'
    ? `${type}; charset=utf-8`
    : type;
}
