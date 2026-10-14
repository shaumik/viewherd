import test from 'node:test';
import assert from 'node:assert/strict';
import { dimensionsFor, renderDesign } from '../examples/product-studio/render.mjs';

const photo = { src: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jX1sAAAAASUVORK5CYII=' };

test('newline-heavy pasted copy stays inside both exported artboards', () => {
  for (const format of ['square', 'story']) {
    const { height } = dimensionsFor(format);
    for (const headline of ['\n'.repeat(79) + 'X', Array(30).fill('A').join('\n'), 'W'.repeat(80)]) {
      const svg = renderDesign({ format, headline, subhead: Array(70).fill('B').join('\n'), eyebrow: '\n'.repeat(47) + 'E', cta: 'W'.repeat(32) }, photo);
      const image = svg.match(/<image\b([^>]*)\/>/)[1];
      const imageY = Number(image.match(/\by="([^"]+)"/)[1]);
      const imageHeight = Number(image.match(/\bheight="([^"]+)"/)[1]);
      assert.ok(imageHeight > 0, 'the product remains visible');
      assert.ok(imageY >= 0 && imageY + imageHeight <= height, 'the product fits the artboard');
      for (const [, attributes, contents] of svg.matchAll(/<text\b([^>]*)>([\s\S]*?)<\/text>/g)) {
        let baseline = Number(attributes.match(/\by="([^"]+)"/)[1]);
        assert.ok(baseline >= 0 && baseline <= height, 'each text baseline fits the artboard');
        for (const [, offset] of contents.matchAll(/<tspan\b[^>]*\bdy="([^"]+)"/g)) {
          baseline += Number(offset);
          assert.ok(baseline >= 0 && baseline <= height, 'wrapped copy fits the artboard');
        }
      }
    }
  }
});

test('exports discard invalid XML characters and preserve valid Unicode copy', () => {
  const svg = renderDesign({ headline: 'Sound \uFFFE\uFFFF\uD800\uDC00\uD800 & 🎧', subhead: 'Listen <freely>\u0001', cta: 'More you' }, photo);
  assert.ok(!/[\uFFFE\uFFFF\u0001]/u.test(svg));
  assert.ok(!/[\uD800-\uDFFF]/u.test(svg), 'unpaired surrogates are removed');
  assert.ok(svg.includes('🎧'), 'valid supplementary characters survive');
  assert.ok(svg.includes('&amp;') && svg.includes('&lt;freely&gt;'));
});
