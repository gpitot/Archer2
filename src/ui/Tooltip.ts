/**
 * A single shared floating tooltip — LoL/Dota-style — used by the spell bar
 * and item bar to describe a spell or item on hover.
 *
 * There is exactly one tooltip element in the DOM (a lazily-created singleton);
 * hovering any registered anchor moves and fills it, and leaving hides it. The
 * shop reuses the same content model (`TooltipContent`) but renders it inline
 * rather than through this hover element.
 */

/**
 * One stat row: a label and one or more values. When `values` has more than
 * one entry (a per-rank ability table) they render slash-separated, and the
 * entry at `highlightIndex` (the current rank) is emphasised.
 */
export interface StatLine {
  label: string;
  values: readonly string[];
}

/** Everything the tooltip renders for one spell or item. */
export interface TooltipContent {
  name: string;
  description: string;
  stats?: readonly StatLine[];
  /** Which per-rank value to emphasise (0-based). Omit for no emphasis. */
  highlightIndex?: number;
  /** Optional footer line (e.g. cost, current rank). */
  footer?: string;
}

const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * Render just the stat rows (label + slash-separated values) as HTML. Shared
 * by the hover tooltip and the always-visible shop cards so both read
 * identically. `highlightIndex` emphasises one per-rank value (current rank).
 */
export function renderStatRows(
  stats: readonly StatLine[],
  highlightIndex?: number,
): string {
  const rows = stats.map((stat) => {
    const values = stat.values
      .map((v, i) => {
        const shown = escapeHtml(v);
        const emphasise = stat.values.length > 1 && i === highlightIndex;
        return emphasise
          ? `<span style="color:#fff;font-weight:bold;">${shown}</span>`
          : `<span style="color:#cfa">${shown}</span>`;
      })
      .join('<span style="color:#665">/</span>');
    return `<div style="display:flex;justify-content:space-between;gap:12px;font-size:11px;line-height:1.5;">`
      + `<span style="color:#9a8">${escapeHtml(stat.label)}</span><span>${values}</span></div>`;
  });
  return rows.join('');
}

/**
 * Render the stat/description body of a tooltip as HTML. Shared by the hover
 * tooltip and the always-visible shop cards so both read identically.
 */
export function renderTooltipBody(content: TooltipContent): string {
  const parts: string[] = [];
  parts.push(
    `<div style="color:#ffdd88;font-size:13px;font-weight:bold;margin-bottom:4px;">${escapeHtml(content.name)}</div>`,
  );
  parts.push(
    `<div style="color:#bbb;font-size:11px;line-height:1.35;margin-bottom:6px;">${escapeHtml(content.description)}</div>`,
  );
  if (content.stats && content.stats.length > 0) {
    parts.push(
      `<div style="border-top:1px solid rgba(180,160,100,0.25);padding-top:5px;">`
        + renderStatRows(content.stats, content.highlightIndex)
        + `</div>`,
    );
  }
  if (content.footer) {
    parts.push(
      `<div style="color:#888;font-size:10px;margin-top:6px;">${escapeHtml(content.footer)}</div>`,
    );
  }
  return parts.join('');
}

/**
 * The shared hover tooltip. Register an anchor element with `attach`; the
 * tooltip shows above it on hover, following the anchor's on-screen box.
 */
export class Tooltip {
  private static _instance: Tooltip | null = null;
  private readonly _el: HTMLDivElement;

  static shared(): Tooltip {
    if (!Tooltip._instance) Tooltip._instance = new Tooltip();
    return Tooltip._instance;
  }

  private constructor() {
    this._el = document.createElement('div');
    this._el.style.cssText = `
      position: fixed;
      z-index: 500;
      pointer-events: none;
      max-width: 260px;
      padding: 8px 10px;
      background: rgba(10, 8, 5, 0.96);
      border: 1px solid rgba(180, 160, 100, 0.6);
      border-radius: 5px;
      box-shadow: 0 4px 16px rgba(0,0,0,0.6);
      font-family: sans-serif;
      display: none;
    `;
    document.body.appendChild(this._el);
  }

  /**
   * Wire an anchor element to show this tooltip on hover. Pass a getter so the
   * content can reflect live state (e.g. the ability's current rank). Returning
   * `null` from the getter suppresses the tooltip for that hover.
   */
  attach(anchor: HTMLElement, getContent: () => TooltipContent | null): void {
    anchor.style.pointerEvents = 'auto';
    anchor.addEventListener('mouseenter', () => {
      const content = getContent();
      if (!content) return;
      this._show(anchor, content);
    });
    anchor.addEventListener('mouseleave', () => this.hide());
  }

  private _show(anchor: HTMLElement, content: TooltipContent): void {
    this._el.innerHTML = renderTooltipBody(content);
    this._el.style.display = 'block';

    // Anchor above the element, horizontally centred, clamped to the viewport.
    const a = anchor.getBoundingClientRect();
    const t = this._el.getBoundingClientRect();
    const margin = 8;
    let left = a.left + a.width / 2 - t.width / 2;
    left = Math.max(margin, Math.min(left, window.innerWidth - t.width - margin));
    let top = a.top - t.height - margin;
    if (top < margin) top = a.bottom + margin; // flip below if no room above
    this._el.style.left = `${left}px`;
    this._el.style.top = `${top}px`;
  }

  hide(): void {
    this._el.style.display = 'none';
  }
}
