// Inline toolbar icons (24 px grid, stroked with currentColor).
const svg = body =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

export const ICONS = {
  select: svg('<path d="M5 3l14 8-6 1.5L10 19z"/>'),
  spikelet: svg('<path d="M12 3c4 3 5 8 3 13l-3 5-3-5c-2-5-1-10 3-13z"/><path d="M12 8v4M10 10h4"/>'),
  awn: svg('<path d="M4 20c3-2 4-6 7-8s6-1 9-8"/><circle cx="4" cy="20" r="1.6"/>'),
  ruler: svg('<path d="M3 17L17 3l4 4L7 21z"/><path d="M7 13l2 2M10 10l2 2M13 7l2 2"/>'),
  undo: svg('<path d="M9 14L4 9l5-5"/><path d="M4 9h10a6 6 0 010 12h-3"/>'),
  redo: svg('<path d="M15 14l5-5-5-5"/><path d="M20 9H10a6 6 0 000 12h3"/>'),
  fit: svg('<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>'),
  focus: svg('<circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2"/>'),
  delete: svg('<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>')
};

export function applyIcons(root) {
  const map = {select: 'select', spikelet: 'spikelet', awn: 'awn', ruler: 'ruler'};
  for (const button of root.querySelectorAll('[data-tool]')) button.innerHTML = ICONS[map[button.dataset.tool]];
  for (const [id, name] of [['undo', 'undo'], ['redo', 'redo'], ['fit', 'fit'], ['focus', 'focus'], ['delete-selection', 'delete']]) {
    const el = root.querySelector('#' + id);
    if (el) el.innerHTML = ICONS[name];
  }
}
