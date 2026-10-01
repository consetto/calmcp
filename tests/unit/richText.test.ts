// The HTML checks calmcp applies before writing rich text into Cloud ALM (src/tools/richText.ts).

import { describe, expect, it } from 'vitest';
import { imageKeys, unsafeHtml } from '../../src/tools/richText.js';

const serviceImage = '<img src="/ui/imageServiceAPI/v1/getImage?imageId=abc" alt="x" />';

describe('unsafeHtml', () => {
  it('accepts ordinary formatting, links and image-service images', () => {
    const html =
      '<h2 style="font-size: 14pt">Steps</h2><p><strong>bold</strong> <a href="https://sap.com">' +
      `link</a></p><ul><li>one</li></ul><table><tr><td>cell</td></tr></table>${serviceImage}`;
    expect(unsafeHtml(html)).toEqual([]);
  });

  it('accepts plain text and non-strings', () => {
    expect(unsafeHtml('5 < 6 and a > b')).toEqual([]);
    expect(unsafeHtml(undefined)).toEqual([]);
  });

  it.each([
    ['<SCRIPT src=x></SCRIPT>', 'script'],
    ['<iframe src="https://x.example"></iframe>', 'iframe'],
    ['<svg><circle/></svg>', 'svg'],
    ['<form action="https://x.example"><input></form>', 'form'],
    ['<img src="/ui/imageServiceAPI/v1/getImage?imageId=a" onerror="x()">', 'onerror='],
    ['<a href=" JaVaScRiPt:x()">a</a>', 'javascript:'],
    ['<a href="java\tscript:x()">a</a>', 'javascript:'],
    ['<a href="javascript&colon;x()">a</a>', 'javascript:'],
    ['<a href="data:text/html,<b>x</b>">a</a>', 'data:'],
    ['<img src="//evil.example/p.png">', 'image service'],
    ['<p style="background-image: u&#x72;l(https://evil.example)">x</p>', 'url('],
  ])('refuses %s', (html, named) => {
    const problems = unsafeHtml(html);
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.join(' ')).toContain(named);
  });

  it('lets an image stay that the current text already has, from wherever', () => {
    const outside = '<img src="https://intranet.example/d.png">';
    expect(unsafeHtml(`<p>new</p>${outside}`, `<p>old</p>${outside}`)).toEqual([]);
    expect(unsafeHtml(`<p>new</p>${outside}`)).not.toEqual([]);
  });

  // Bypasses found while reviewing the first version of the check.
  it('reads a quoted ">" as part of the value, not as the end of the tag', () => {
    expect(unsafeHtml('<a title="1 > 0" href="javascript:x()">a</a>').join(' ')).toContain(
      'javascript:',
    );
  });

  it("never takes an attribute out of another attribute's value", () => {
    const spoofed =
      '<img title=" src=/ui/imageServiceAPI/v1/getImage?imageId=a" src="https://evil.example/p">';
    expect(unsafeHtml(spoofed).join(' ')).toContain('https://evil.example/p');
  });

  it('refuses a tag it cannot read, and still finds a handler in it', () => {
    const problems = unsafeHtml('<p>x</p><img src=x onerror=alert(1) title="').join(' ');
    expect(problems).toContain('could not be read');
    expect(problems).toContain('onerror=');
  });

  it('does not take an image id from a foreign URL', () => {
    expect(imageKeys('<img src="https://evil.example/x?imageId=abc">')).toEqual([
      'src:https://evil.example/x?imageId=abc',
    ]);
  });
});
