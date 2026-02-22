import { describe, it, expect } from 'vitest';
import { reportJSON } from '../src/reporters/json.js';
import { reportCLI } from '../src/reporters/cli.js';
import { reportGitHub } from '../src/reporters/github-pr.js';
import { AnalysisResult, RiskLevel, LockMode, PgfenceConfig } from '../src/types.js';

const mockCheck: AnalysisResult['checks'][0] = {
    statement: 'ALTER TABLE users ADD COLUMN foo BOOLEAN;',
    statementPreview: 'ALTER TABLE users ADD COLUMN foo',
    tableName: 'users',
    lockMode: LockMode.ACCESS_EXCLUSIVE,
    blocks: { reads: true, writes: true, otherDdl: true },
    risk: RiskLevel.HIGH,
    message: 'Adding a column can be dangerous',
    ruleId: 'add-column-not-null-no-default',
};

const mockResults: AnalysisResult[] = [
    {
        filePath: 'test.sql',
        statementCount: 1,
        extractionWarnings: [],
        checks: [mockCheck],
        policyViolations: [
            {
                ruleId: 'missing-lock-timeout',
                severity: 'error',
                message: 'Missing lock_timeout',
                suggestion: "Set lock_timeout = '2s'",
            },
        ],
        maxRisk: RiskLevel.HIGH,
    },
];

const mockConfig: PgfenceConfig = {
    minPostgresVersion: 11,
    maxAllowedRisk: RiskLevel.CRITICAL,
    requireLockTimeout: false,
    requireStatementTimeout: false,
    output: 'cli',
    format: 'sql',
};

describe('Reporter: JSON', () => {
    it('should format output as JSON correctly', () => {
        const output = reportJSON(mockResults);
        const parsed = JSON.parse(output);

        expect(parsed.version).toBe('1.0');
        expect(parsed.coverage.totalStatements).toBe(1);
        expect(parsed.coverage.coveragePercent).toBe(100);
        expect(parsed.results[0].filePath).toBe('test.sql');
    });

    it('should calculate coverage correctly with dynamic statements', () => {
        const resultsWithWarnings: AnalysisResult[] = [
            {
                ...mockResults[0],
                statementCount: 2,
                extractionWarnings: [{ filePath: 'test.sql', line: 1, column: 0, message: 'Dynamic SQL' }],
            }
        ];

        const output = reportJSON(resultsWithWarnings);
        const parsed = JSON.parse(output);

        expect(parsed.coverage.totalStatements).toBe(2);
        expect(parsed.coverage.dynamicStatements).toBe(1);
        expect(parsed.coverage.coveragePercent).toBe(50);
    });
});

describe('Reporter: CLI', () => {
    it('should format output as a CLI table', () => {
        const output = reportCLI(mockResults, mockConfig);

        expect(output).toContain('test.sql');
        expect(output).toContain('ALTER TABLE users ADD COLUMN foo');
        expect(output).toContain('ACCESS EXCLUSIVE');
        expect(output).toContain('HIGH');
        expect(output).toContain('Missing lock_timeout');
        expect(output).toContain('=== Coverage ===');
        expect(output).toContain('Coverage: 100%');
    });

    it('should output safe migrations notice', () => {
        const safeResults: AnalysisResult[] = [{ ...mockResults[0], checks: [] }];
        const output = reportCLI(safeResults, mockConfig);

        expect(output).toContain('No dangerous statements detected.');
    });

    it('should output extraction warnings', () => {
        const resultsWithWarnings: AnalysisResult[] = [{
            ...mockResults[0],
            extractionWarnings: [{ filePath: 'test.sql', line: 1, column: 0, message: 'Dynamic SQL' }],
        }];

        const output = reportCLI(resultsWithWarnings, mockConfig);
        expect(output).toContain('Dynamic SQL');
    });

    it('should output safe rewrite recipes', () => {
        const resultsWithRewrites: AnalysisResult[] = [{
            ...mockResults[0],
            checks: [
                {
                    ...mockCheck,
                    safeRewrite: {
                        description: "Test description",
                        steps: ["SELECT 1;"]
                    }
                }
            ]
        }];

        const output = reportCLI(resultsWithRewrites, mockConfig);
        expect(output).toContain('Safe Rewrite Recipes:');
        expect(output).toContain('Test description');
        expect(output).toContain('SELECT 1;');
    });

    it('should include coverage summary line per Trust Contract (Analyzed N statements, Unanalyzable M, Coverage P%)', () => {
        const output = reportCLI(mockResults, mockConfig);
        expect(output).toContain('=== Coverage ===');
        expect(output).toMatch(/Analyzed: 1 statements\s+\|\s+Unanalyzable: 0\s+\|\s+Coverage: 100%/);
    });

    it('should report unanalyzable count and reduced coverage when extraction warnings present', () => {
        const resultsWithWarnings: AnalysisResult[] = [{
            ...mockResults[0],
            statementCount: 3,
            extractionWarnings: [
                { filePath: 'test.sql', line: 10, column: 2, message: 'Dynamic SQL' },
            ],
        }];
        const output = reportCLI(resultsWithWarnings, mockConfig);
        expect(output).toContain('=== Coverage ===');
        expect(output).toMatch(/Unanalyzable: 1/);
        expect(output).toMatch(/Coverage: 67%/);
    });
});

describe('Reporter: GitHub PR', () => {
    it('should format output as a Markdown table', () => {
        const output = reportGitHub(mockResults);

        expect(output).toContain('## pgfence Migration Safety Report');
        expect(output).toContain('`test.sql`');
        expect(output).toContain('ALTER TABLE users ADD COLUMN foo');
        expect(output).toContain('ACCESS EXCLUSIVE');
        expect(output).toContain(':red_circle: HIGH');
        expect(output).toContain('Missing lock_timeout');
        expect(output).toContain('**1** SQL statements.');
    });

    it('should output safe migrations notice', () => {
        const safeResults: AnalysisResult[] = [{ ...mockResults[0], checks: [] }];
        const output = reportGitHub(safeResults);

        expect(output).toContain('No dangerous statements detected.');
    });

    it('should output extraction warnings', () => {
        const resultsWithWarnings: AnalysisResult[] = [{
            ...mockResults[0],
            extractionWarnings: [{ filePath: 'test.sql', line: 1, column: 0, message: 'Dynamic SQL' }],
        }];

        const output = reportGitHub(resultsWithWarnings);
        expect(output).toContain('> :warning: **Dynamic SQL**');
    });

    it('should output safe rewrite recipes details block', () => {
        const resultsWithRewrites: AnalysisResult[] = [{
            ...mockResults[0],
            checks: [
                {
                    ...mockCheck,
                    safeRewrite: {
                        description: "Test description",
                        steps: ["SELECT 1;"]
                    }
                }
            ]
        }];

        const output = reportGitHub(resultsWithRewrites);
        expect(output).toContain('<summary>Safe Rewrite Recipes</summary>');
        expect(output).toContain('Test description');
        expect(output).toContain('SELECT 1;');
    });

    it('should include coverage summary per Trust Contract (Analyzed N SQL statements, M dynamic not analyzable, Coverage P%)', () => {
        const output = reportGitHub(mockResults);
        expect(output).toContain('### Coverage');
        expect(output).toContain('Analyzed **1** SQL statements');
        expect(output).toContain('**0** dynamic statements not analyzable');
        expect(output).toContain('Coverage: **100%**');
    });

    it('should report dynamic statements not analyzable and coverage percent when extraction warnings present', () => {
        const resultsWithWarnings: AnalysisResult[] = [{
            ...mockResults[0],
            statementCount: 2,
            extractionWarnings: [
                { filePath: 'test.sql', line: 5, column: 0, message: 'Dynamic SQL' },
            ],
        }];
        const output = reportGitHub(resultsWithWarnings);
        expect(output).toContain('### Coverage');
        expect(output).toMatch(/\*\*1\*\* dynamic statements not analyzable/);
        expect(output).toMatch(/Coverage: \*\*50%\*\*/);
    });
});
