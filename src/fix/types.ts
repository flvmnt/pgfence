/**
 * Shared types for pgfence's two-tier --fix.
 *
 * Tier 1: true in-place, single-statement, side-effect-free fixes.
 * Tier 2 (--split): multi-file scaffolds for the documented expand/backfill/contract
 * recipes that CANNOT be applied in place without changing what the migration does.
 *
 * See src/fix/tier1.ts and src/fix/tier2.ts for the exact allowlists and the
 * reasoning for every ruleId that was considered and excluded.
 */

export interface FixedFinding {
  ruleId: string;
  kind: 'statement' | 'policy';
  status: 'fixed' | 'skipped';
  /** Only present when status === 'skipped'. */
  reason?: string;
  /** A residual risk that remains true even after a successful fix (still surfaced to the user). */
  caveat?: string;
  /** Short preview of the original text (statement or policy message). */
  before?: string;
  /** Short preview of the replacement text that was written. */
  after?: string;
}

export interface Tier2GeneratedFile {
  path: string;
  label: string;
}

export interface Tier2Finding {
  ruleId: string;
  status: 'generated' | 'skipped';
  reason?: string;
  files?: Tier2GeneratedFile[];
}

export interface FileFixReport {
  filePath: string;
  /** Resolved migration format for this file (after auto-detect). */
  resolvedFormat: string;
  /** Whether in-place Tier 1 edits are supported for this format (raw .sql only). */
  supportsInPlaceFix: boolean;
  tier1: FixedFinding[];
  tier2: Tier2Finding[];
  /**
   * Every OTHER finding that carries a safeRewrite but is in neither tier
   * (e.g. alter-column-type, drop-table, fk-missing-index, ...). Never
   * touched; reported purely so "which findings were left for the user, and
   * why" covers the whole file, not just the two automated tiers.
   */
  manual: FixedFinding[];
  /** Whether the original file's content changed on disk. */
  modified: boolean;
}
