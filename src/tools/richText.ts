// Checks for the HTML calmcp writes into Cloud ALM rich-text fields (document `content`, feature and
// library `description`), on create and on update.
//
// Two risks, both from a model writing text it did not fully author (docs/UPDATES.md):
//   - losing images: Cloud ALM stores an image in its image service and puts an `<img>` tag into the
//     HTML; a rewritten text that leaves the tag out deletes the image from the object;
//   - adding active content: calmcp reads text written by other people, so an instruction planted in
//     one object can make a model write `<script>`, an `onerror=` handler, a `javascript:` link or a
//     tracking pixel (`<img src="https://elsewhere/…">`) into another, where every user who opens it
//     runs or loads it. Cloud ALM's server strips some of this (scripts, handlers, srcset, media
//     elements) but keeps images from other hosts and CSS `url(...)`, and its UI loads both (checked
//     on a tenant, 2026-10-28). calmcp therefore checks against an allowlist: only the elements and
//     attributes of plain formatted text, and only links and images that load nothing elsewhere.

/** Where Cloud ALM's own image service serves the images of rich-text fields (same origin). */
const IMAGE_SERVICE_PATH = '/ui/imageServiceAPI/';

/**
 * The elements of formatted text: what Cloud ALM's editor (TinyMCE) and SAP's templates write.
 * Anything else, including every element that runs code, loads a document or takes input, is
 * refused by name.
 */
const ALLOWED_ELEMENTS = new Set([
  ...['p', 'br', 'hr', 'div', 'span', 'font', 'b', 'strong', 'i', 'em', 'u', 's', 'strike'],
  ...['del', 'ins', 'sub', 'sup', 'small', 'big', 'mark', 'code', 'pre', 'kbd', 'samp', 'var'],
  ...['blockquote', 'q', 'cite', 'abbr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li'],
  ...['dl', 'dt', 'dd', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption'],
  ...['colgroup', 'col', 'a', 'img', 'figure', 'figcaption'],
]);

/** Attributes any allowed element may carry; none of them makes the browser load anything. */
const GLOBAL_ATTRIBUTES = new Set([
  ...['style', 'class', 'id', 'title', 'lang', 'dir', 'align', 'valign', 'width', 'height'],
]);

/** Attributes allowed on one element only. `href` and `src` are checked further below. */
const ELEMENT_ATTRIBUTES: Record<string, readonly string[]> = {
  a: ['href', 'target', 'rel', 'name'],
  img: ['src', 'alt', 'border'],
  table: ['border', 'cellpadding', 'cellspacing', 'summary', 'bgcolor'],
  tr: ['bgcolor'],
  td: ['colspan', 'rowspan', 'headers', 'scope', 'nowrap', 'bgcolor'],
  th: ['colspan', 'rowspan', 'headers', 'scope', 'nowrap', 'bgcolor'],
  col: ['span'],
  colgroup: ['span'],
  ol: ['start', 'type', 'reversed'],
  ul: ['type'],
  li: ['value', 'type'],
  font: ['color', 'face', 'size'],
};

/** Elements that run code, load other documents or styles, or submit data: searched for again in
 * the raw text, in case the parser could not read the tag. */
const FORBIDDEN_ELEMENTS = [
  ...['script', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'style', 'link'],
  ...['meta', 'base', 'form', 'input', 'button', 'textarea', 'select', 'svg', 'math', 'video'],
  ...['audio', 'source', 'picture', 'track', 'template', 'portal'],
];

/** Link targets: http(s), mailto, or a path within Cloud ALM. */
const LINK_SCHEME = /^(https?|mailto):/i;

/** Anything in a style value that loads a resource or could hide one (escapes, comments). */
const STYLE_LOADS =
  /\\|\/\*|url\s*\(|image(-set)?\s*\(|cross-fade\s*\(|element\s*\(|src\s*\(|expression\s*\(|@import|binding|behavior/i;

/**
 * One tag: closing slash, element name, and the raw attribute text. Quoted values may contain `>`,
 * which therefore does not end the tag; a tag with an unterminated quote does not match at all and
 * is reported as malformed by {@link unsafeHtml}.
 */
const TAG = /<\s*(\/?)\s*([a-z][a-z0-9:-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/gi;

/** One attribute, read from where the previous one ended (sticky), as a browser tokenises them. */
const ATTRIBUTE = /\s*([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?|\s*\/|\s+/y;

/** A parsed tag. */
interface Tag {
  name: string;
  /** Attribute values by lower-case name; for a repeated name the first wins, as in a browser. */
  attributes: Map<string, string>;
  /** False when the attribute text could not be read to its end, e.g. after a stray `=`. */
  complete: boolean;
}

/** Every tag in `html`, parsed. */
function tags(html: string): Tag[] {
  return [...html.matchAll(TAG)].map(([, , name = '', rest = '']) => ({
    name: name.toLowerCase(),
    ...parseAttributes(rest),
  }));
}

/**
 * Tokenise an attribute string left to right, so a value is never searched for another attribute.
 * Where the tokenizer stops early a browser would read on, so the tag is reported as incomplete.
 */
function parseAttributes(text: string): { attributes: Map<string, string>; complete: boolean } {
  const attributes = new Map<string, string>();
  ATTRIBUTE.lastIndex = 0;
  while (ATTRIBUTE.lastIndex < text.length) {
    const before = ATTRIBUTE.lastIndex;
    const match = ATTRIBUTE.exec(text);
    if (!match || ATTRIBUTE.lastIndex === before) {
      return { attributes, complete: text.slice(before).trim() === '' };
    }
    const name = match[1]?.toLowerCase();
    if (name && !attributes.has(name)) {
      attributes.set(name, match[2] ?? match[3] ?? match[4] ?? '');
    }
  }
  return { attributes, complete: true };
}

/** Every `<img>` tag's `src`, exactly as written (with `&amp;` decoded), in order. */
export function imageSources(html: unknown): string[] {
  if (typeof html !== 'string') return [];
  return tags(html)
    .filter((tag) => tag.name === 'img')
    .map((tag) => (tag.attributes.get('src') ?? '').replace(/&amp;/g, '&'));
}

/**
 * The images an HTML value references, one key per image.
 *
 * An image-service image is keyed by its id, so a tag rewritten with other attributes still counts
 * as the same image; any other image by its `src`.
 *
 * @param html - An HTML string (or anything else, which has no images).
 * @returns The image keys, in order of appearance, without duplicates.
 */
export function imageKeys(html: unknown): string[] {
  const keys = imageSources(html).map((src) => {
    const imageId = src.startsWith(IMAGE_SERVICE_PATH)
      ? /[?&]imageId=([^&#]+)/i.exec(src)?.[1]
      : undefined;
    return imageId ? `imageId:${decodeId(imageId).toLowerCase()}` : `src:${src}`;
  });
  return [...new Set(keys)];
}

/** An image id with its percent escapes decoded, or as written when an escape is malformed. */
function decodeId(imageId: string): string {
  try {
    return decodeURIComponent(imageId);
  } catch {
    return imageId;
  }
}

/**
 * The images `current` references that `next` no longer does.
 *
 * @param current - The stored HTML.
 * @param next - The HTML the caller wants to store instead.
 * @returns The keys of the images the change would remove.
 */
export function droppedImages(current: unknown, next: unknown): string[] {
  const kept = new Set(imageKeys(next));
  return imageKeys(current).filter((key) => !kept.has(key));
}

/**
 * What makes an HTML value unsafe to store, or an empty list when nothing does.
 *
 * Two layers. Parsed tags are checked attribute by attribute; then the whole text, entities
 * decoded, is searched for the same patterns, so a tag the parser could not read (an unterminated
 * quote, say) is still caught. A tag start the parser could not read is refused as malformed.
 *
 * @param html - The value to store.
 * @param current - The value it replaces, if any: an image already in it may stay, whatever its
 *   source, so an update never fails over an image someone added in the Cloud ALM UI.
 * @returns One line per problem.
 */
export function unsafeHtml(html: unknown, current?: unknown): string[] {
  if (typeof html !== 'string') return [];
  const problems = new Set<string>();
  const parsed = tags(html);
  const existingSources = new Set(imageSources(current));

  for (const tag of parsed) {
    if (!ALLOWED_ELEMENTS.has(tag.name)) {
      problems.add(`<${tag.name}> elements are not allowed`);
      continue;
    }
    if (!tag.complete) {
      problems.add(`a <${tag.name}> tag could not be read to its end; remove stray "=" or quotes`);
    }
    for (const [name, value] of tag.attributes) {
      if (name.startsWith('on')) {
        problems.add(`event handler attributes such as ${name}= are not allowed`);
      } else if (
        !GLOBAL_ATTRIBUTES.has(name) &&
        !ELEMENT_ATTRIBUTES[tag.name]?.includes(name) &&
        !name.startsWith('data-')
      ) {
        problems.add(`the ${name} attribute is not allowed on <${tag.name}>`);
      } else if (name === 'style' && STYLE_LOADS.test(decodeEntities(value))) {
        problems.add(
          'inline styles may not load anything: no url(), image-set(), @import, CSS escapes or ' +
            'comments',
        );
      } else if (name === 'href') {
        const url = normalizedUrl(value);
        if (/^[a-z][a-z0-9+.-]*:/i.test(url) && !LINK_SCHEME.test(url)) {
          problems.add('links must be http(s), mailto or a path within Cloud ALM');
        }
      } else if (tag.name === 'img' && name === 'src') {
        const src = value.replace(/&amp;/g, '&');
        if (!existingSources.has(src) && !isImageServicePath(src)) {
          problems.add(
            `images must come from Cloud ALM's image service (${IMAGE_SERVICE_PATH}…), not "${src}"`,
          );
        }
      }
    }
  }

  // Second layer: the same patterns anywhere in the text, after decoding entities.
  const text = decodeEntities(html);
  const element = new RegExp(`<\\s*\\/?\\s*(${FORBIDDEN_ELEMENTS.join('|')})\\b`, 'i').exec(
    text,
  )?.[1];
  if (element) problems.add(`<${element.toLowerCase()}> elements are not allowed`);
  const handler = /<[a-z][^<]*?\s(on[a-z]+)\s*=/i.exec(text)?.[1];
  if (handler)
    problems.add(`event handler attributes such as ${handler.toLowerCase()}= are not allowed`);
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is stripped.
  if (/=\s*["'`]?\s*(javascript|vbscript|data)\s*:/i.test(text.replace(/[\u0000-\u001f]/g, ''))) {
    problems.add('URLs with javascript:, vbscript: or data: are not allowed');
  }
  if ((html.match(/<\s*\/?\s*[a-z]/gi) ?? []).length !== parsed.length) {
    problems.add(
      'a tag could not be read (unterminated quote or stray "<"); write "&lt;" for a literal "<"',
    );
  }
  return [...problems];
}

/**
 * Whether `src` names an image of Cloud ALM's image service on the same host, after the browser's
 * own resolution of `../` and `%2e%2e`, and with an image id that decodes.
 */
function isImageServicePath(src: string): boolean {
  let url: URL;
  try {
    url = new URL(src, 'https://tenant.invalid');
    decodeURIComponent(url.search);
  } catch {
    return false;
  }
  return url.origin === 'https://tenant.invalid' && url.pathname.startsWith(IMAGE_SERVICE_PATH);
}

/** Decode the numeric and the few named entities that can disguise a scheme or a CSS function. */
function decodeEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);?/gi, (_, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    )
    .replace(/&#(\d+);?/g, (_, dec: string) => String.fromCodePoint(Number.parseInt(dec, 10)))
    .replace(/&colon;/gi, ':')
    .replace(/&lpar;/gi, '(')
    .replace(/&tab;|&newline;/gi, '');
}

/** A URL as a browser reads its scheme: entities decoded, whitespace and control characters gone. */
function normalizedUrl(value: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is stripped.
  return decodeEntities(value).replace(/[\s\u0000-\u001f]/g, '');
}
