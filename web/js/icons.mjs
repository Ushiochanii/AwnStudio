// Inline icons. Paths follow Lucide (ISC license), drawn at 1.75 px to sit with
// the 13.5 px UI text.
const svg = body =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

export const ICONS = {
  select: svg('<path d="M4 4l7.07 17 2.51-7.39L21 11.07z"/>'),
  box: svg('<path d="M3 7V5a2 2 0 0 1 2-2h2"/><path d="M17 3h2a2 2 0 0 1 2 2v2"/><path d="M21 17v2a2 2 0 0 1-2 2h-2"/><path d="M7 21H5a2 2 0 0 1-2-2v-2"/><circle cx="9" cy="10" r="1"/><circle cx="15" cy="14" r="1"/>'),
  spikelet: svg('<path d="M12 3c3.6 2.8 4.6 7.6 2.8 12.2L12 21l-2.8-5.8C7.4 10.6 8.4 5.8 12 3z"/><path d="M12 8v6"/>'),
  awn: svg('<path d="M4 20c3-2 4.5-6 7.5-8s6-1.5 8.5-8"/><circle cx="4" cy="20" r="1.6"/>'),
  ruler: svg('<path d="M21.3 15.3a2.4 2.4 0 0 1 0 3.4l-2.6 2.6a2.4 2.4 0 0 1-3.4 0L2.7 8.7a2.41 2.41 0 0 1 0-3.4l2.6-2.6a2.41 2.41 0 0 1 3.4 0Z"/><path d="m14.5 12.5 2-2"/><path d="m11.5 9.5 2-2"/><path d="m8.5 6.5 2-2"/><path d="m17.5 15.5 2-2"/>'),
  undo: svg('<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>'),
  redo: svg('<path d="m15 14 5-5-5-5"/><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13"/>'),
  source: svg('<path d="M2.1 12s3.5-6 9.9-6 9.9 6 9.9 6-3.5 6-9.9 6S2.1 12 2.1 12Z"/><circle cx="12" cy="12" r="2.5"/>'),
  background: svg('<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9" r="1.5"/><path d="m21 15-5-5L5 20"/><path d="M4 4l16 16"/>'),
  focus: svg('<circle cx="12" cy="12" r="3"/><path d="M3 8V5a2 2 0 0 1 2-2h3M16 3h3a2 2 0 0 1 2 2v3M21 16v3a2 2 0 0 1-2 2h-3M8 21H5a2 2 0 0 1-2-2v-3"/>'),
  delete: svg('<path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="m19 6-1 14H6L5 6"/><path d="M10 11v5M14 11v5"/>'),
  settings: svg('<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>'),
  import: svg('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m17 8-5-5-5 5"/><path d="M12 3v12"/>')
};

const BY_ID = {undo: 'undo', redo: 'redo', 'source-preview': 'source', 'background-toggle': 'background', focus: 'focus', 'delete-selection': 'delete'};

export function applyIcons(root) {
  for (const button of root.querySelectorAll('[data-tool]')) button.innerHTML = ICONS[button.dataset.tool];
  for (const [id, name] of Object.entries(BY_ID)) {
    const el = root.querySelector('#' + id);
    if (el) el.innerHTML = ICONS[name];
  }
  for (const el of root.querySelectorAll('[data-icon]')) el.insertAdjacentHTML('afterbegin', ICONS[el.dataset.icon]);
}
