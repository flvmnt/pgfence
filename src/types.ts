/**
 * Postgres lock modes, ordered from least to most restrictive.
 * See: https://www.postgresql.org/docs/current/explicit-locking.html
 */
export enum LockMode {
  ACCESS_SHARE = 'ACCESS SHARE',
  ROW_SHARE = 'ROW SHARE',
  ROW_EXCLUSIVE = 'ROW EXCLUSIVE',
  SHARE_UPDATE_EXCLUSIVE = 'SHARE UPDATE EXCLUSIVE',
  SHARE = 'SHARE',
  SHARE_ROW_EXCLUSIVE = 'SHARE ROW EXCLUSIVE',
  EXCLUSIVE = 'EXCLUSIVE',
  ACCESS_EXCLUSIVE = 'ACCESS EXCLUSIVE',
}

export enum RiskLevel {
  SAFE = 'SAFE',
  LOW = 'LOW',
  MEDIUM = 'MEDIUM',
  HIGH = 'HIGH',
  CRITICAL = 'CRITICAL',
}

export interface BlockedOperations {
  reads: boolean;
  writes: boolean;
  otherDdl: boolean;
}

export interface SafeRewrite {
  description: string;
  steps: string[];
}

export interface CheckResult {
  /** The original SQL statement */
  statement: string;
  /** Truncated version for display */
  statementPreview: string;
  /** Which table is affected */
  tableName: string | null;
  /** Lock mode this statement acquires */
  lockMode: LockMode;
  /** What operations are blocked while this lock is held */
  blocks: BlockedOperations;
  /** Risk level (before DB-size adjustment) */
  risk: RiskLevel;
  /** Risk level after DB-size adjustment (if stats available) */
  adjustedRisk?: RiskLevel;
  /** Human-readable explanation of the issue */
  message: string;
  /** Rule ID for suppression */
  ruleId: string;
  /** Safe alternative if available */
  safeRewrite?: SafeRewrite;
  /** If true, this check fires even on tables created in the same migration */
  appliesToNewTables?: boolean;
}

export interface PolicyViolation {
  /** Policy rule ID */
  ruleId: string;
  /** Human-readable message */
  message: string;
  /** Suggested fix */
  suggestion: string;
  /** Severity */
  severity: 'error' | 'warning';
}

export interface TableStats {
  schemaName: string;
  tableName: string;
  rowCount: number;
  totalBytes: number;
}

export interface ExtractionWarning {
  filePath: string;
  line?: number;
  column?: number;
  message: string;
}

export interface ExtractionResult {
  sql: string;
  warnings: ExtractionWarning[];
}

export interface AnalysisResult {
  /** Source file path */
  filePath: string;
  /** Individual statement check results */
  checks: CheckResult[];
  /** Policy violations (lock_timeout, statement_timeout, etc.) */
  policyViolations: PolicyViolation[];
  /** Highest risk level found */
  maxRisk: RiskLevel;
  /** Total number of SQL statements parsed */
  statementCount: number;
  /** Warnings from SQL extraction (dynamic SQL, unparseable expressions, etc.) */
  extractionWarnings?: ExtractionWarning[];
  /** Table stats if DB connection was provided */
  tableStats?: TableStats[];
}

export interface PgfenceConfig {
  /** Minimum Postgres version to assume (affects which operations are instant) */
  minPostgresVersion: number;
  /** Maximum risk level allowed before CI failure */
  maxAllowedRisk: RiskLevel;
  /** Whether to require lock_timeout in every migration */
  requireLockTimeout: boolean;
  /** Whether to require statement_timeout */
  requireStatementTimeout: boolean;
  /** Database URL for size-aware scoring (optional) */
  dbUrl?: string;
  /** Pre-fetched table stats from --stats-file (alternative to dbUrl) */
  tableStats?: TableStats[];
  /** Output format */
  output: 'cli' | 'json' | 'github' | 'sarif';
  /** Migration file format */
  format: 'sql' | 'typeorm' | 'prisma' | 'knex' | 'drizzle' | 'sequelize' | 'auto';
}

/**
 * Lock mode conflict matrix.
 * For each lock mode, lists which other lock modes it conflicts with.
 */
export const LOCK_CONFLICTS: Record<LockMode, LockMode[]> = {
  [LockMode.ACCESS_SHARE]: [LockMode.ACCESS_EXCLUSIVE],
  [LockMode.ROW_SHARE]: [LockMode.EXCLUSIVE, LockMode.ACCESS_EXCLUSIVE],
  [LockMode.ROW_EXCLUSIVE]: [
    LockMode.SHARE,
    LockMode.SHARE_ROW_EXCLUSIVE,
    LockMode.EXCLUSIVE,
    LockMode.ACCESS_EXCLUSIVE,
  ],
  [LockMode.SHARE_UPDATE_EXCLUSIVE]: [
    LockMode.SHARE_UPDATE_EXCLUSIVE,
    LockMode.SHARE,
    LockMode.SHARE_ROW_EXCLUSIVE,
    LockMode.EXCLUSIVE,
    LockMode.ACCESS_EXCLUSIVE,
  ],
  [LockMode.SHARE]: [
    LockMode.ROW_EXCLUSIVE,
    LockMode.SHARE_UPDATE_EXCLUSIVE,
    LockMode.SHARE_ROW_EXCLUSIVE,
    LockMode.EXCLUSIVE,
    LockMode.ACCESS_EXCLUSIVE,
  ],
  [LockMode.SHARE_ROW_EXCLUSIVE]: [
    LockMode.ROW_EXCLUSIVE,
    LockMode.SHARE_UPDATE_EXCLUSIVE,
    LockMode.SHARE,
    LockMode.SHARE_ROW_EXCLUSIVE,
    LockMode.EXCLUSIVE,
    LockMode.ACCESS_EXCLUSIVE,
  ],
  [LockMode.EXCLUSIVE]: [
    LockMode.ROW_SHARE,
    LockMode.ROW_EXCLUSIVE,
    LockMode.SHARE_UPDATE_EXCLUSIVE,
    LockMode.SHARE,
    LockMode.SHARE_ROW_EXCLUSIVE,
    LockMode.EXCLUSIVE,
    LockMode.ACCESS_EXCLUSIVE,
  ],
  [LockMode.ACCESS_EXCLUSIVE]: [
    LockMode.ACCESS_SHARE,
    LockMode.ROW_SHARE,
    LockMode.ROW_EXCLUSIVE,
    LockMode.SHARE_UPDATE_EXCLUSIVE,
    LockMode.SHARE,
    LockMode.SHARE_ROW_EXCLUSIVE,
    LockMode.EXCLUSIVE,
    LockMode.ACCESS_EXCLUSIVE,
  ],
};

/**
 * Returns what operations a lock mode blocks.
 */
export function getBlockedOperations(lockMode: LockMode): BlockedOperations {
  const conflicts = LOCK_CONFLICTS[lockMode];
  return {
    reads: conflicts.includes(LockMode.ACCESS_SHARE),
    writes: conflicts.includes(LockMode.ROW_EXCLUSIVE),
    otherDdl: conflicts.includes(LockMode.ACCESS_EXCLUSIVE),
  };
}
