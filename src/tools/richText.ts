// Checks for the HTML calmcp writes into Cloud ALM rich-text fields (document `content`, feature and
// library `description`), on create and on update.
//
// Two risks, both from a model writing text it did not fully author (docs/UPDATES.md):
//   - losing images: Cloud ALM stores an image in its image service and puts an `<img>` tag into the
//     HTML; a rewritten text that leaves the tag out deletes the image from the object;
//   - adding active content: calmcp reads text written by other people, so an instruction planted in
//     one object can make a model write `<script>`, an `onerror=` handler, a `javascript:` link or a
//     tracking pixel (`<img src="https://elsewhere/…">`) into another, where every user who opens it
//     runs or loads it. Whether Cloud ALM's UI sanitises such HTML is not documented; calmcp refuses
//     it before sending rather than rely on that.

/** Where Cloud ALM's own image service serves the images of rich-text fields (same origin). */
const IMAGE_SERVICE_PATH = '/ui/imageServiceAPI/';

/** Elements that run code, load other documents or styles, or submit data. */
const FORBIDDEN_ELEMENTS = [
  'script',
  'iframe',
  'frame',
  'frameset',
  'object',
  'embed',
  'applet',
  'style',
  'link',
  'meta',
  'base',
  'form',
  'input',
  'button',
  'textarea',
  'select',
  'svg',
  'math',
];

/** Attributes holding a URL the browser follows or loads. */
const URL_ATTRIBUTES = [
  'href',
  'src',
  'action',
  'formaction',
  'xlink:href',
  'poster',
  'background',
];

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
}

/** Every tag in `html`, parsed. */
function tags(html: string): Tag[] {
  return [...html.matchAll(TAG)].map(([, , name = '', rest = '']) => ({
    name: name.toLowerCase(),
    attributes: parseAttributes(rest),
  }));
}

/** Tokenise an attribute string left to right, so a value is never searched for another attribute. */
function parseAttributes(text: string): Map<string, string> {
  const attributes = new Map<string, string>();
  ATTRIBUTE.lastIndex = 0;
  while (ATTRIBUTE.lastIndex < text.length) {
    const before = ATTRIBUTE.lastIndex;
    const match = ATTRIBUTE.exec(text);
    if (!match || ATTRIBUTE.lastIndex === before) break;
    const name = match[1]?.toLowerCase();
    if (name && !attributes.has(name)) {
      attributes.set(name, match[2] ?? match[3] ?? match[4] ?? '');
    }
  }
  return attributes;
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
    return imageId ? `imageId:${decodeURIComponent(imageId).toLowerCase()}` : `src:${src}`;
  });
  return [...new Set(keys)];
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

  for (const tag of parsed) {
    if (FORBIDDEN_ELEMENTS.includes(tag.name))
      problems.add(`<${tag.name}> elements are not allowed`);
    for (const [name, value] of tag.attributes) {
      if (name.startsWith('on')) {
        problems.add(`event handler attributes such as ${name}= are not allowed`);
      }
      if (URL_ATTRIBUTES.includes(name) && UNSAFE_SCHEME.test(normalizedUrl(value))) {
        problems.add(`${name} URLs with javascript:, vbscript: or data: are not allowed`);
      }
      if (name === 'style' && /url\s*\(|expression\s*\(/i.test(decodeEntities(value))) {
        problems.add('inline styles may not load URLs (url(...) or expression(...))');
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

  const existingSources = new Set(imageSources(current));
  for (const src of imageSources(html)) {
    if (!src.startsWith(IMAGE_SERVICE_PATH) && !existingSources.has(src)) {
      problems.add(
        `images must come from Cloud ALM's image service (${IMAGE_SERVICE_PATH}…), not "${src}"`,
      );
    }
  }
  return [...problems];
}

/** A URL scheme that runs code or embeds a document. */
const UNSAFE_SCHEME = /^(javascript|vbscript|data):/i;

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
