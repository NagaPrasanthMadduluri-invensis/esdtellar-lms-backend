import { parseScormDuration } from '@/common/scorm-duration.util';

export interface ParsedManifest {
  version: '1.2' | '2004';
  title: string;
  entryPoint: string;
  /**
   * Runtime the package declares, in minutes, or null when it declares none.
   * Null is the common case — many authoring tools omit it — and it is what
   * sends the admin to type the duration by hand.
   */
  durationMinutes: number | null;
}

/**
 * The runtime the package says it takes, from LOM `typicalLearningTime`.
 *
 * Namespacing here is as inconsistent as everywhere else in SCORM
 * (`typicalLearningTime`, `imsmd:typicallearningtime`, `lom:...`), and the
 * value sits in a nested `<duration>` in 2004 and a `<datetime>` in the older
 * 1.2 LOM binding — so both children are accepted. The value itself is an
 * ISO 8601 duration, the same shape `cmi.total_time` uses in 2004, so it goes
 * through the one parser that already knows how to read those.
 *
 * Returns null rather than 0 when nothing is declared: 0 would look like a
 * package that genuinely takes no time, and would stop the admin being asked.
 */
function parseTypicalLearningTime(xml: string): number | null {
  const block = xml.match(
    /<(?:[a-z0-9]+:)?typicallearningtime[^>]*>([\s\S]*?)<\/(?:[a-z0-9]+:)?typicallearningtime>/i,
  )?.[1];
  if (!block) return null;

  const raw =
    block.match(/<(?:[a-z0-9]+:)?duration[^>]*>([^<]+)</i)?.[1] ??
    block.match(/<(?:[a-z0-9]+:)?datetime[^>]*>([^<]+)</i)?.[1] ??
    // Some packages put the value straight inside the element.
    block.trim();

  const minutes = parseScormDuration((raw ?? '').trim());
  return minutes > 0 ? Math.round(minutes) : null;
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
  return {
    version,
    title,
    entryPoint: entryPoint ?? 'index.htm',
    durationMinutes: parseTypicalLearningTime(xml),
  };
}
