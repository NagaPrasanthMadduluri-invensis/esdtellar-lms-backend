export interface ParsedManifest {
  version: '1.2' | '2004';
  title: string;
  entryPoint: string;
}

/**
 * Reads `imsmanifest.xml` for the SCORM version, title and launch file.
 *
 * Regex rather than a DOM parse, carried over from the working legacy
 * implementation: authoring tools emit wildly inconsistent namespacing
 * (`adlcp:scormtype`, `adlcp:scormType`, no prefix at all), and matching on the
 * attribute name alone survives all of them. Falls back progressively so a
 * slightly malformed package still launches.
 */
export function parseManifest(xml: string): ParsedManifest {
  const schemaVersion =
    xml.match(/<schemaversion[^>]*?>([^<]+)<\/schemaversion>/i)?.[1]?.trim() ??
    '1.2';

  const version: '1.2' | '2004' =
    schemaVersion.includes('2004') ||
    schemaVersion.toLowerCase().includes('cam') ||
    schemaVersion.includes('1.3')
      ? '2004'
      : '1.2';

  const title =
    xml
      .match(/<organization[^>]*?>[\s\S]*?<title>([\s\S]*?)<\/title>/i)?.[1]
      ?.trim()
      .replace(/\s+/g, ' ') ?? 'SCORM Package';

  const resources =
    xml.match(/<resources[^>]*?>([\s\S]*?)<\/resources>/i)?.[1] ?? xml;

  // Preferred: the resource explicitly flagged as a SCO.
  let entryPoint: string | null = null;
  const scoPattern = /(<resource\b[^>]*?scormtype="sco"[^>]*?>)/gi;
  let match: RegExpExecArray | null;
  while ((match = scoPattern.exec(resources)) !== null) {
    const href = match[1].match(/\bhref="([^"]+)"/i);
    if (href) {
      entryPoint = href[1];
      break;
    }
  }

  // Fallback: any resource pointing at an HTML file.
  entryPoint ??= resources.match(/\bhref="([^"]+\.html?)"/i)?.[1] ?? null;

  // Last resort: the SCORM convention.
  return { version, title, entryPoint: entryPoint ?? 'index.htm' };
}
