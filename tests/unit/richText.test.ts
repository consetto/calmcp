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

  // Each of these passed the former blocklist. Cloud ALM's server keeps the CSS ones and the image
  // paths, and its UI loads them (checked on a tenant), so calmcp is the only check.
  it.each([
    [
      'srcset on an image',
      '<img src="/ui/imageServiceAPI/v1/getImage?imageId=1" srcset="https://x.example/p.png 1x">',
      'srcset',
    ],
    [
      'a picture source',
      '<picture><source srcset="https://x.example/p.png"></picture>',
      '<picture>',
    ],
    ['a video poster', '<video poster="https://x.example/p.png"></video>', '<video>'],
    ['an audio element', '<audio src="https://x.example/a.mp3" autoplay></audio>', '<audio>'],
    ['a table background', '<table background="https://x.example/p.png"></table>', 'background'],
    [
      'image-set() in a style',
      '<p style="background-image:image-set(\'https://x.example/p.png\' 1x)">x</p>',
      'inline styles',
    ],
    [
      'a CSS escape in a style',
      '<p style="background:u\\72l(https://x.example/p.png)">x</p>',
      'inline styles',
    ],
    [
      'a CSS comment splitting url',
      '<p style="background:u/**/rl(https://x.example/p.png)">x</p>',
      'inline styles',
    ],
    [
      'a stray "=" before the style',
      '<p ="" style="background:url(https://x.example/p.png)">x</p>',
      'could not be read',
    ],
    [
      'dot segments out of the image service',
      '<img src="/ui/imageServiceAPI/../../api/x">',
      'image service',
    ],
    [
      'encoded dot segments',
      '<img src="/ui/imageServiceAPI/%2e%2e/%2e%2e/api/x">',
      'image service',
    ],
    [
      'a protocol-relative image',
      '<img src="//x.example/ui/imageServiceAPI/p.png">',
      'image service',
    ],
    [
      'an image id that does not decode',
      '<img src="/ui/imageServiceAPI/v1/getImage?imageId=%E0%A4%A">',
      'image service',
    ],
    ['an unknown element', '<marquee>x</marquee>', '<marquee>'],
    ['an unknown attribute', '<p formaction="https://x.example">x</p>', 'formaction'],
    ['a link with another scheme', '<a href="file:///etc/passwd">x</a>', 'links must be'],
    // Named entities a browser decodes before it loads anything (found in the 1.0 review).
    [
      'a host hidden behind &sol;',
      '<img src="&sol;&sol;x.example/../../ui/imageServiceAPI/x">',
      '&sol;',
    ],
    [
      'a scheme hidden behind &colon;',
      '<img src="https&colon;//x.example/../../../ui/imageServiceAPI/x">',
      '&colon;',
    ],
    [
      'a CSS escape hidden behind &bsol;',
      '<p style="background:u&bsol;72l(https://x.example/p.png)">x</p>',
      '&bsol;',
    ],
    [
      'a host hidden behind numeric entities',
      '<img src="&#47;&#47;x.example/../../ui/imageServiceAPI/x">',
      'image service',
    ],
    [
      'a scheme hidden behind a hex entity',
      '<img src="https&#x3a;//x.example/../ui/imageServiceAPI/x">',
      'image service',
    ],
  ])('refuses %s', (_, html, expected) => {
    expect(unsafeHtml(html).join('\n')).toContain(expected);
  });

  it('accepts the HTML Cloud ALM stores from its editor and its templates', () => {
    // Written in the Cloud ALM document editor (TinyMCE 7) with every toolbar format, then read back
    // through the Documents API (2026-10-28).
    const editor =
      '<p>calmcp editor probe</p><h2>Heading two</h2><p><strong>bold text</strong></p>' +
      '<p><em>italic text</em></p><p><span style="text-decoration: underline">underlined</span></p>' +
      '<p><span style="color: #e03e2d">red</span></p>' +
      '<p><span style="background-color: #fbeeb8">highlighted</span></p>' +
      '<p><span style="font-family: &quot;arial&quot;">arial</span></p>' +
      '<p><span style="font-size: 18pt">big</span></p><p><sup>sup</sup></p><p><sub>sub</sub></p>' +
      '<p style="text-align: center">centered</p><blockquote><ol><li style="list-style-type: none">' +
      '<ol><li>one<p><a href="https://www.sap.com" target="_blank">a link</a></p>' +
      '<table style="border-collapse: collapse ; width: 100%" border="1"><colgroup><col><col>' +
      '</colgroup><tbody><tr><td>&nbsp;</td><td><pre>pre</pre><p>smile 😀</p></td></tr></tbody>' +
      '</table></li></ol></li></ol></blockquote>';
    // What the editor sends before Cloud ALM's server strips some of it.
    const unsaved =
      '<p><s>struck</s></p><p dir="rtl">rtl</p><hr><a href="/launchpad#x" rel="noopener">x</a>';
    // The shape of SAP's roadmap task descriptions.
    const template = '<p><strong>Purpose</strong></p><ul><li><b>Step</b></li></ul><h2>Results</h2>';
    expect(unsafeHtml(editor)).toEqual([]);
    expect(unsafeHtml(unsaved)).toEqual([]);
    expect(unsafeHtml(template)).toEqual([]);
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

  it('keeps named entities in text and in alt or title', () => {
    const html =
      '<p title="caf&eacute;">Gr&ouml;&szlig;e <img alt="Gr&ouml;&szlig;e" ' +
      'src="/ui/imageServiceAPI/v1/getImage?imageId=abc&amp;x=1"></p>';
    expect(unsafeHtml(html)).toEqual([]);
  });

  it('decodes an out-of-range numeric entity instead of throwing', () => {
    expect(() => unsafeHtml('<a href="&#x110000;x">a</a>')).not.toThrow();
  });

  it('reads crafted tag soup in linear time', () => {
    const started = Date.now();
    for (const html of ['<a'.repeat(100_000), `${'<a"'.repeat(50_000)}>`, "<a '".repeat(50_000)]) {
      unsafeHtml(html);
    }
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('does not take an image id from a foreign URL', () => {
    expect(imageKeys('<img src="https://evil.example/x?imageId=abc">')).toEqual([
      'src:https://evil.example/x?imageId=abc',
    ]);
  });
});
