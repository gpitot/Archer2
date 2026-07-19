/**
 * The tooltip *content model* — plain data, no DOM.
 *
 * Split from `Tooltip.ts` because the sim's ability and item definitions build
 * these structures, and the sim is compiled for the Worker too, where DOM
 * types don't exist. `Tooltip.ts` renders them; this file just describes them.
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
