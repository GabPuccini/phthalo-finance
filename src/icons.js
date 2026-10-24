/**
 * icons.js
 *
 * Inline SVG icons. Everything draws in currentColor on a 24 unit grid,
 * so an icon takes its colour and size from wherever it is placed.
 */

const svg = (paths, extra = '') =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" `
  + `stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"${extra}>${paths}</svg>`;

/** One glyph per category, drawn inside the round coloured badge. */
const CATEGORY_GLYPHS = {
  // A coin with a hexagon on it.
  crypto: '<path d="M12 3.5l7.4 4.25v8.5L12 20.5l-7.4-4.25v-8.5z"/><path d="M12 8.5l3.2 1.85v3.3L12 15.5l-3.2-1.85v-3.3z"/>',
  // A stack of bars.
  metals: '<path d="M3.5 19h7l-1.2-4.5H4.7z"/><path d="M13.5 19h7l-1.2-4.5h-4.6z"/><path d="M8.5 14.5h7L14.3 10H9.7z"/>',
  // A house.
  property: '<path d="M4 11l8-6.5 8 6.5"/><path d="M6 9.5V19h12V9.5"/><path d="M10 19v-5h4v5"/>',
  // A rising line.
  investments: '<path d="M4 17l5-5 4 3.5L20 8"/><path d="M15 8h5v5"/>',
  // A wallet.
  cash: '<path d="M4 7.5A1.5 1.5 0 0 1 5.5 6H18a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z"/><path d="M4 8l11.5-3.5V6"/><path d="M16 12.5h1.5"/>',
  // A card.
  debt: '<rect x="3" y="6" width="18" height="12" rx="2"/><path d="M3 10.5h18"/><path d="M7 14.5h4"/>'
};

export function categoryGlyph(key) {
  return svg(CATEGORY_GLYPHS[key] || CATEGORY_GLYPHS.cash);
}

export const icon = {
  back: svg('<path d="M15 5l-7 7 7 7"/>'),
  chevron: svg('<path d="M9 5l7 7-7 7"/>'),
  plus: svg('<path d="M12 5v14M5 12h14"/>'),
  minus: svg('<path d="M5 12h14"/>'),
  edit: svg('<path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16z"/><path d="M13.5 6.5l4 4"/>'),
  up: svg('<path d="M12 19V5M6 11l6-6 6 6"/>'),
  down: svg('<path d="M12 5v14M6 13l6 6 6-6"/>'),
  close: svg('<path d="M6 6l12 12M18 6L6 18"/>'),
  check: svg('<circle cx="12" cy="12" r="9"/><path d="M8 12.5l2.7 2.7L16 10"/>'),
  alert: svg('<circle cx="12" cy="12" r="9"/><path d="M12 7.5v5.5M12 16.5h.01"/>'),
  info: svg('<circle cx="12" cy="12" r="9"/><path d="M12 11v5.5M12 7.5h.01"/>'),
  clock: svg('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'),
  flag: svg('<path d="M5 21V4M5 4h11l-2 4 2 4H5"/>'),
  trendUp: svg('<path d="M5 15l5-5 4 4 5-6"/>'),
  trendDown: svg('<path d="M5 9l5 5 4-4 5 6"/>'),
  download: svg('<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>'),
  upload: svg('<path d="M12 20V9M7 14l5-5 5 5M5 4h14"/>'),
  table: svg('<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><path d="M3.5 9.5h17M9.5 9.5v10"/>'),
  refresh: svg('<path d="M20 12a8 8 0 1 1-2.3-5.6M20 4v4h-4"/>'),
  archive: svg('<rect x="3.5" y="4.5" width="17" height="4" rx="1"/><path d="M5 8.5V19h14V8.5M10 12.5h4"/>'),
  trash: svg('<path d="M4 7h16M9 7V4.5h6V7M6.5 7l1 13h9l1-13"/>'),
  sparkle: svg('<path d="M12 4v4M12 16v4M4 12h4M16 12h4M6.5 6.5l2.5 2.5M15 15l2.5 2.5M6.5 17.5L9 15M15 9l2.5-2.5"/>'),
  sliders: svg('<path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/>')
};
