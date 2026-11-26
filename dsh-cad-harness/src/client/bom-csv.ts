// BOM as CSV — the last mile between the machine page and a quote.
//
// WHY PURE: the failure modes are all in the TEXT, not the UI: a part name with a
// comma, a material written as `AL 6061, T6`, a note with a quote, an undeclared
// quantity (empty ≠ 0), two identical nodes (two hangers are two rows, not one
// with qty 2). None of that is checkable by clicking download and opening a
// spreadsheet (`scripts/accept-bom-csv.mjs` drives this module directly).
//
// COLUMNS are the ones a workshop/quote actually reads, in this order:
//   零件名,版本,数量,材料,工艺,来源,库存编号
//
// HONESTY RULE for 工艺: the manifest records who decided the process. An `agent`
// recommendation without a `confirmedBy` is NOT a settled process (the schema says
// so), and a CSV that prints it as one would let a recommendation reach a quote.
// Those cells get "（未确认）" appended — the only place this file editorialises,
// and it is visible rather than silently omitted.

export interface BomNode {
  /** Part name as the manifest names it (the column a human matches to the model). */
  part: string;
  version?: string | null;
  qty?: number;
  material?: string;
  /** e.g. `fdm-pla-0.4`, `cnc-alu`. */
  process?: { id: string; source?: string; confirmedBy?: string } | null;
  /** printed | purchased | reference (the buy/make axis). */
  source?: string;
  stockRef?: string;
}

export const BOM_HEADER = ['零件名', '版本', '数量', '材料', '工艺', '来源', '库存编号'] as const;

/** RFC 4180-ish: quote when the value contains a delimiter, quote or newline. */
export function csvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';
  const text = String(value);
  if (!/[",\n\r]/.test(text)) return text;
  return `"${text.replaceAll('"', '""')}"`;
}

/** The 工艺 cell: the profile id, marked when it is an unconfirmed recommendation. */
export function processCell(node: BomNode): string {
  const process = node.process;
  if (!process?.id) return '';
  const unconfirmed = process.source === 'agent' && !process.confirmedBy;
  return unconfirmed ? `${process.id}（未确认）` : process.id;
}

/**
 * The whole sheet, `\n`-terminated, one row per NODE (duplicates kept).
 *
 * A `\r\n`-free line ending is deliberate: the file is UTF-8 text that a
 * spreadsheet or a script reads; the BOM-less UTF-8 keeps Chinese headers intact
 * in Excel (which is the one place a BOM would help, but a BOM also breaks naive
 * `head -1` checks — the panel prepends it at download time instead).
 */
export function buildBomCsv(nodes: readonly BomNode[]): string {
  const rows: string[] = [BOM_HEADER.map((cell) => csvCell(cell)).join(',')];
  for (const node of nodes) {
    rows.push([
      csvCell(node.part),
      csvCell(node.version ?? ''),
      csvCell(node.qty ?? ''),
      csvCell(node.material ?? ''),
      csvCell(processCell(node)),
      csvCell(node.source ?? ''),
      csvCell(node.stockRef ?? ''),
    ].join(','));
  }
  return `${rows.join('\n')}\n`;
}

/**
 * Undeclared BOM facts, per column — what the sheet CANNOT answer.
 *
 * "qty 12/16 rows" is the difference between a quote that is right and one that
 * quietly assumed 1. The panel shows this next to the button.
 */
export function bomGaps(nodes: readonly BomNode[]): { rows: number; qty: number; material: number; process: number } {
  return {
    rows: nodes.length,
    qty: nodes.filter((node) => node.qty !== undefined && node.qty !== null).length,
    material: nodes.filter((node) => Boolean(node.material)).length,
    process: nodes.filter((node) => Boolean(node.process?.id)).length,
  };
}

/** File name for the download: the machine name, made safe for three OSes. */
export function bomFileName(machineName: string | null | undefined, today = new Date()): string {
  const stamp = today.toISOString().slice(0, 10);
  const base = (machineName ?? 'bom').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 60) || 'bom';
  return `${base}_BOM_${stamp}.csv`;
}
