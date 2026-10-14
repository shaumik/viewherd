const FONT = 'Arial, Helvetica, sans-serif';

const THEMES = Object.freeze({
  sand: Object.freeze({
    id: 'sand', label: 'Sand', color: '#e5d8bf', background: '#f0ece3',
    foreground: '#292d24', muted: '#696d60', line: '#c9c9ba',
    accent: '#30392a', accentText: '#f5f3ea', halo: '#dcd5c1',
  }),
  midnight: Object.freeze({
    id: 'midnight', label: 'Midnight', color: '#203b31', background: '#16382f',
    foreground: '#e7f0dd', muted: '#b0c5b7', line: '#517165',
    accent: '#d6efbd', accentText: '#16382f', halo: '#6c8b65',
  }),
  cobalt: Object.freeze({
    id: 'cobalt', label: 'Cobalt', color: '#325ae1', background: '#305be5',
    foreground: '#f5f3e9', muted: '#d6e0ff', line: '#91abf0',
    accent: '#e4f4ac', accentText: '#19317a', halo: '#87a6f5',
  }),
});

export const DESIGN_THEMES = Object.freeze(Object.values(THEMES));

export function dimensionsFor(format) {
  return { width: 1080, height: format === 'story' ? 1920 : 1080 };
}

function cleanText(value, fallback, maxLength) {
  const text = typeof value === 'string' ? value : fallback;
  return Array.from(text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\uD800-\uDFFF\uFFFE\uFFFF]/gu, '').replace(/\r\n?/g, '\n')).slice(0, maxLength).join('');
}

function escapeXML(value) {
  return String(value).replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
  })[character]);
}

function readableParagraphs(text, maxParagraphs) {
  const paragraphs = text.split(/\n+/u).map(paragraph => paragraph.replace(/\s+/gu, ' ').trim()).filter(Boolean);
  return paragraphs.join(paragraphs.length > maxParagraphs ? ' ' : '\n');
}

// Approximate the built-in sans font without a browser, canvas, or font service.
// Fitting at render time also keeps long words and edited copy inside the artboard.
function textWidth(text, size, tracking = 0) {
  let width = 0;
  const characters = Array.from(text);
  for (const character of characters) {
    if (/\s/u.test(character)) width += 0.28;
    else if (/[ilI1.,:;'!|]/u.test(character)) width += 0.29;
    else if (/[MW@%]/u.test(character)) width += 0.85;
    else if (/[A-Z]/u.test(character)) width += 0.67;
    else if (/[^\u0000-\u02ff]/u.test(character)) width += 0.95;
    else width += 0.56;
  }
  return width * size + Math.max(0, characters.length - 1) * tracking;
}

function wrapText(text, size, width, tracking = 0) {
  const lines = [];
  for (const paragraph of text.split('\n')) {
    if (!paragraph.trim()) { lines.push(''); continue; }
    let line = '';
    for (const word of paragraph.trim().split(/\s+/u)) {
      if (line && textWidth(`${line} ${word}`, size, tracking) <= width) {
        line += ` ${word}`;
        continue;
      }
      if (line) { lines.push(line); line = ''; }
      if (textWidth(word, size, tracking) <= width) { line = word; continue; }
      // An uninterrupted word can be wider than the board even at the minimum size.
      for (const character of Array.from(word)) {
        if (line && textWidth(line + character, size, tracking) > width) {
          lines.push(line);
          line = character;
        } else line += character;
      }
    }
    if (line) lines.push(line);
  }
  return lines.length ? lines : [''];
}

function fitHeadline(text, story) {
  const width = story ? 900 : 936;
  const maxHeight = story ? 420 : 335;
  const maxSize = story ? 148 : 122;
  for (let size = maxSize; size >= 42; size -= 2) {
    const tracking = -size * 0.048;
    const lines = wrapText(text, size, width, tracking);
    const leading = size * 0.94;
    if (lines.length * leading <= maxHeight) return { lines, size, tracking, leading };
  }
  const size = 40;
  return { lines: wrapText(text, size, width, -1.92), size, tracking: -1.92, leading: 37.6 };
}

function textLines(lines, { x, y, size, leading, color, weight = 400, tracking = 0, anchor = 'start' }) {
  return `<text x="${x}" y="${y}" fill="${color}" font-family="${FONT}" font-size="${size}" font-weight="${weight}" letter-spacing="${tracking}" text-anchor="${anchor}">${lines.map((line, index) => `<tspan x="${x}" dy="${index ? leading : 0}">${escapeXML(line)}</tspan>`).join('')}</text>`;
}

function safeAssetSource(asset) {
  const source = asset && typeof asset.src === 'string' ? asset.src : '';
  return source.length <= 192_000 && /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(source) ? source : '';
}

function productImage(source, { x, y, width, height }, palette) {
  if (source) return `<image href="${source}" x="${x}" y="${y}" width="${width}" height="${height}" preserveAspectRatio="xMidYMid meet"/>`;
  // The sample remains useful if its image has not loaded. Real uploaded artwork
  // and the bundled product photograph use the image element above.
  const scale = Math.min(width / 700, height / 700);
  const tx = x + (width - 700 * scale) / 2;
  const ty = y + (height - 700 * scale) / 2;
  return `<g transform="translate(${tx} ${ty}) scale(${scale})" aria-label="Headphone silhouette">
    <path d="M122 380V287C122 150 217 56 351 56s227 94 227 231v93" fill="none" stroke="${palette.foreground}" stroke-opacity=".15" stroke-width="71" stroke-linecap="round"/>
    <path d="M122 380V287C122 150 217 56 351 56s227 94 227 231v93" fill="none" stroke="#343b35" stroke-width="57" stroke-linecap="round"/>
    <path d="M145 344V281C145 157 229 83 351 83s207 74 207 198v63" fill="none" stroke="#808c7d" stroke-width="7" stroke-opacity=".65"/>
    <rect x="82" y="340" width="139" height="263" rx="69" fill="#202820" transform="rotate(-12 151 471)"/>
    <rect x="109" y="356" width="94" height="235" rx="47" fill="#414b3f" transform="rotate(-12 151 471)"/>
    <rect x="480" y="340" width="139" height="263" rx="69" fill="#202820" transform="rotate(12 549 471)"/>
    <rect x="497" y="356" width="94" height="235" rx="47" fill="#414b3f" transform="rotate(12 549 471)"/>
    <path d="M120 403c16-8 28-10 39-6M532 397c15 1 29 4 41 10" fill="none" stroke="#abb5a1" stroke-opacity=".45" stroke-width="3"/>
  </g>`;
}

function arrow(x, y, color, size = 24) {
  return `<path d="M${x} ${y + size / 2}h${size}m-${size / 3}-${size / 3} ${size / 3} ${size / 3}-${size / 3} ${size / 3}" fill="none" stroke="${color}" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"/>`;
}

function background(palette, story) {
  const cy = story ? 1140 : 716;
  const radius = story ? 640 : 415;
  const opacity = palette.id === 'sand' ? '.72' : palette.id === 'cobalt' ? '.28' : '.26';
  const circle = `<circle cx="${story ? 770 : 795}" cy="${cy}" r="${radius}" fill="${palette.halo}" opacity="${opacity}"/>`;
  if (palette.id === 'midnight') {
    return `${circle}<circle cx="${story ? 770 : 795}" cy="${cy}" r="${radius + 34}" fill="none" stroke="${palette.foreground}" stroke-opacity=".08" stroke-width="1"/><circle cx="${story ? 770 : 795}" cy="${cy}" r="${radius + 83}" fill="none" stroke="${palette.foreground}" stroke-opacity=".05" stroke-width="1"/>`;
  }
  if (palette.id === 'cobalt') {
    return `${circle}<path d="M${story ? -500 : -120} ${story ? 1540 : 1050} 1190 ${story ? 750 : 402}" fill="none" stroke="${palette.foreground}" stroke-opacity=".12" stroke-width="1"/>`;
  }
  return circle;
}

/** Render a complete, exportable campaign image. No remote fonts or assets. */
export function renderDesign(design = {}, asset = {}) {
  if (!design || typeof design !== 'object') design = {};
  const story = design.format === 'story';
  const { width, height } = dimensionsFor(design.format);
  const palette = Object.hasOwn(THEMES, design.theme) ? THEMES[design.theme] : THEMES.sand;
  const headline = readableParagraphs(cleanText(design.headline, 'Sound.\nWithout limits.', 80), 4);
  const subhead = readableParagraphs(cleanText(design.subhead, 'High-fidelity sound.\nNo strings attached.', 140), story ? 4 : 5);
  const eyebrow = readableParagraphs(cleanText(design.eyebrow, 'INTRODUCING FORMA ONE', 48), 1);
  const cta = readableParagraphs(cleanText(design.cta, 'Find your sound', 32), 1);
  const name = cleanText(design.name, 'FORMA One campaign', 80);
  const fit = fitHeadline(headline, story);
  const margin = story ? 90 : 72;
  const baseline = (story ? 218 : 158) + fit.size * 0.82;
  const headlineBottom = baseline + (fit.lines.length - 1) * fit.leading;
  const subheadY = Math.max(story ? 575 : 433, headlineBottom + (story ? 68 : 53));
  const subheadSize = story ? 26 : 21;
  const subheadWidth = story ? 740 : 330;
  let subheadLines = wrapText(subhead, subheadSize, subheadWidth);
  // Long subhead edits remain legible without colliding with the product hero.
  let fittedSubheadSize = subheadSize;
  while (subheadLines.length > (story ? 4 : 5) && fittedSubheadSize > 14) {
    fittedSubheadSize -= 1;
    subheadLines = wrapText(subhead, fittedSubheadSize, subheadWidth);
  }
  const source = safeAssetSource(asset);
  const productY = story ? Math.max(675, subheadY + subheadLines.length * 34 + 28) : Math.max(374, headlineBottom + 10);
  const product = story
    ? { x: 105, y: productY, width: 920, height: Math.min(930, 1605 - productY) }
    : { x: 270, y: productY, width: 795, height: Math.min(633, 984 - productY) };
  const ctaY = story ? 1656 : 864;
  const ctaHeight = story ? 84 : 64;
  const ctaSize = story ? 25 : 19;
  const ctaWidth = Math.max(story ? 280 : 206, textWidth(cta, ctaSize) + (story ? 110 : 80));
  const storyBrandY = ctaWidth > 570 ? ctaY + ctaHeight + 49 : ctaY + 34;
  const footerY = story ? 1817 : 1006;
  const footerBaseline = footerY + (story ? 54 : 35);
  const description = `FORMA One headphones. ${headline.replace(/\n/g, ' ')} ${subhead.replace(/\n/g, ' ')}`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeXML(description)}">
  <title>${escapeXML(name)}</title><desc>${escapeXML(description)}</desc>
  <rect width="${width}" height="${height}" fill="${palette.background}"/>
  ${background(palette, story)}
  <text x="${margin}" y="${story ? 108 : 91}" fill="${palette.foreground}" font-family="${FONT}" font-size="${story ? 51 : 43}" font-weight="700" letter-spacing="-3">FORMA<tspan font-size="${story ? 24 : 21}" dy="-${story ? 19 : 16}" dx="4">®</tspan></text>
  <text x="${width - margin}" y="${story ? 102 : 84}" fill="${palette.foreground}" font-family="${FONT}" font-size="${story ? 18 : 15}" font-weight="600" letter-spacing="2" text-anchor="end">AUDIO / 01</text>
  ${textLines(wrapText(eyebrow, story ? 17 : 14, story ? 850 : 930, 2.2), { x: margin, y: story ? 205 : 149, size: story ? 17 : 14, leading: 22, color: palette.muted, weight: 600, tracking: 2.2 })}
  ${textLines(fit.lines, { x: margin - 4, y: baseline, size: fit.size, leading: fit.leading, color: palette.foreground, weight: 700, tracking: fit.tracking })}
  ${textLines(subheadLines, { x: margin, y: subheadY, size: fittedSubheadSize, leading: fittedSubheadSize * 1.4, color: palette.muted })}
  <ellipse cx="${story ? 661 : 679}" cy="${story ? 1556 : 972}" rx="${story ? 300 : 234}" ry="${story ? 21 : 14}" fill="${palette.foreground}" opacity=".035"/>
  ${productImage(source, product, palette)}
  ${story ? '' : `<text x="${margin}" y="713" fill="${palette.foreground}" font-family="${FONT}" font-size="64" font-weight="400" letter-spacing="-3">40<tspan font-size="28" letter-spacing="-1">h</tspan></text><text x="${margin + 2}" y="740" fill="${palette.muted}" font-family="${FONT}" font-size="13" font-weight="600" letter-spacing="1.6">MORE OF YOUR WORLD.</text>`}
  <rect x="${margin}" y="${ctaY}" width="${ctaWidth}" height="${ctaHeight}" rx="${ctaHeight / 2}" fill="${palette.accent}"/>
  <text x="${margin + (story ? 32 : 26)}" y="${ctaY + ctaHeight / 2 + ctaSize * .35}" fill="${palette.accentText}" font-family="${FONT}" font-size="${ctaSize}" font-weight="600">${escapeXML(cta)}</text>
  ${arrow(margin + ctaWidth - (story ? 55 : 45), ctaY + ctaHeight / 2 - (story ? 13 : 10), palette.accentText, story ? 26 : 20)}
  ${story ? `<text x="${width - margin}" y="${storyBrandY}" fill="${palette.foreground}" font-family="${FONT}" font-size="27" font-weight="600" text-anchor="end">FORMA ONE</text><text x="${width - margin}" y="${storyBrandY + 31}" fill="${palette.muted}" font-family="${FONT}" font-size="16" text-anchor="end" letter-spacing="1">WIRELESS HEADPHONES</text>` : ''}
  <path d="M${margin} ${footerY}H${width - margin}" stroke="${palette.line}" stroke-width="1"/>
  <text x="${margin}" y="${footerBaseline}" fill="${palette.muted}" font-family="${FONT}" font-size="${story ? 18 : 13}" font-weight="600" letter-spacing="${story ? 1.5 : 1.2}">${story ? '40 HOURS. PURE SOUND.' : 'FORMA ONE — WIRELESS HEADPHONES'}</text>
  <text x="${width - margin}" y="${footerBaseline}" fill="${palette.muted}" font-family="${FONT}" font-size="${story ? 18 : 13}" font-weight="600" letter-spacing="${story ? 1.5 : 1.2}" text-anchor="end">${story ? 'MADE FOR THE WAY YOU LISTEN.' : 'PURE SOUND. LESS NOISE.'}</text>
</svg>`;
}
