import { describe, it, expect } from 'vitest';
import { reportJSON } from '../src/reporters/json.js';
import { reportCLI } from '../src/reporters/cli.js';
import { reportGitHub } from '../src/reporters/github-pr.js';
import { AnalysisResult, RiskLevel, LockMode } from '../src/types.js';

const mockResults: AnalysisResult[] = [
    {
        filePath: 'test.sql',
        format: 'sql',
        statementCount: 1,
        extractionWarnings: [],
        checks: [
            {
                ruleId: 'add-column',
                lockMode: LockMode.ACCESS_EXCLUSIVE,
                blocks: { reads: true, writes: true, otherDdl: true },
                risk: RiskLevel.HIGH,
                statementPreview: 'ALTER TABLE users ADD COLUMN foo',
                message: 'Adding a column can be dangerous',
            },
        ],
        policyViolations: [
            {
                ruleId: 'missing-lock-timeout',
                severity: 'error',
                message: 'Missing lock_timeout',
                suggestion: "Set lock_timeout = '2s'",
            },
        ],
        maxRisk: RiskLevel.HIGH,
        timeMs: 10,
    },
];

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
        const output = reportCLI(mockResults);

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
        const output = reportCLI(safeResults);

        expect(output).toContain('No dangerous statements detected.');
    });

    it('should output extraction warnings', () => {
        const resultsWithWarnings: AnalysisResult[] = [{
            ...mockResults[0],
            extractionWarnings: [{ filePath: 'test.sql', line: 1, column: 0, message: 'Dynamic SQL' }],
        }];

        const output = reportCLI(resultsWithWarnings);
        expect(output).toContain('Dynamic SQL');
    });

    it('should output safe rewrite recipes', () => {
        const resultsWithRewrites: AnalysisResult[] = [{
            ...mockResults[0],
            checks: [
                {
                    ...mockResults[0].checks[0],
                    safeRewrite: {
                        description: "Test description",
                        steps: ["SELECT 1;"]
                    }
                }
            ]
        }];

        const output = reportCLI(resultsWithRewrites);
        expect(output).toContain('Safe Rewrite Recipes:');
        expect(output).toContain('Test description');
        expect(output).toContain('SELECT 1;');
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
                    ...mockResults[0].checks[0],
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
});
