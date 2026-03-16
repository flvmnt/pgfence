import { describe, it, expect } from 'vitest';
import { reportJSON } from '../src/reporters/json.js';
import { reportCLI } from '../src/reporters/cli.js';
import { reportGitHub } from '../src/reporters/github-pr.js';
import { reportSARIF } from '../src/reporters/sarif.js';
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
    minPostgresVersion: 14,
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
                extractionWarnings: [{ filePath: 'test.sql', line: 1, column: 0, message: 'Dynamic SQL', unanalyzable: true }],
            }
        ];

        const output = reportJSON(resultsWithWarnings);
        const parsed = JSON.parse(output);

        expect(parsed.coverage.totalStatements).toBe(2);
        expect(parsed.coverage.dynamicStatements).toBe(1);
        expect(parsed.coverage.coveragePercent).toBe(50);
    });

    it('should not count informational warnings as unanalyzable', () => {
        const resultsWithInfoWarnings: AnalysisResult[] = [
            {
                ...mockResults[0],
                statementCount: 2,
                extractionWarnings: [{ filePath: 'test.sql', line: 1, column: 0, message: 'Builder API info' }],
            }
        ];

        const output = reportJSON(resultsWithInfoWarnings);
        const parsed = JSON.parse(output);

        expect(parsed.coverage.totalStatements).toBe(2);
        expect(parsed.coverage.dynamicStatements).toBe(0);
        expect(parsed.coverage.coveragePercent).toBe(100);
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

    it('should report unanalyzable count and reduced coverage when unanalyzable extraction warnings present', () => {
        const resultsWithWarnings: AnalysisResult[] = [{
            ...mockResults[0],
            statementCount: 3,
            extractionWarnings: [
                { filePath: 'test.sql', line: 10, column: 2, message: 'Dynamic SQL', unanalyzable: true },
            ],
        }];
        const output = reportCLI(resultsWithWarnings, mockConfig);
        expect(output).toContain('=== Coverage ===');
        expect(output).toMatch(/Unanalyzable: 1/);
        expect(output).toMatch(/Coverage: 67%/);
    });

    it('should not count informational warnings as unanalyzable in coverage', () => {
        const resultsWithInfoWarnings: AnalysisResult[] = [{
            ...mockResults[0],
            statementCount: 3,
            extractionWarnings: [
                { filePath: 'test.sql', line: 10, column: 2, message: 'Builder API detected' },
            ],
        }];
        const output = reportCLI(resultsWithInfoWarnings, mockConfig);
        expect(output).toContain('=== Coverage ===');
        expect(output).toMatch(/Unanalyzable: 0/);
        expect(output).toMatch(/Coverage: 100%/);
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

    it('should report dynamic statements not analyzable and coverage percent when unanalyzable extraction warnings present', () => {
        const resultsWithWarnings: AnalysisResult[] = [{
            ...mockResults[0],
            statementCount: 2,
            extractionWarnings: [
                { filePath: 'test.sql', line: 5, column: 0, message: 'Dynamic SQL', unanalyzable: true },
            ],
        }];
        const output = reportGitHub(resultsWithWarnings);
        expect(output).toContain('### Coverage');
        expect(output).toMatch(/\*\*1\*\* dynamic statements not analyzable/);
        expect(output).toMatch(/Coverage: \*\*50%\*\*/);
    });
});

describe('Reporter: SARIF', () => {
    it('should produce valid SARIF 2.1.0 structure', () => {
        const output = reportSARIF(mockResults);
        const sarif = JSON.parse(output);
        expect(sarif.$schema).toContain('sarif');
        expect(sarif.version).toBe('2.1.0');
        expect(sarif.runs).toHaveLength(1);
        expect(sarif.runs[0].results.length).toBeGreaterThan(0);
    });

    it('should include tool driver info', () => {
        const output = reportSARIF(mockResults);
        const sarif = JSON.parse(output);
        const driver = sarif.runs[0].tool.driver;
        expect(driver.name).toBe('pgfence');
        expect(driver.informationUri).toBe('https://pgfence.com');
        expect(driver.rules.length).toBeGreaterThan(0);
    });

    it('should include coverage summary', () => {
        const output = reportSARIF(mockResults);
        const sarif = JSON.parse(output);
        const run = sarif.runs[0];
        expect(run.properties?.coverageSummary).toBeDefined();
        expect(run.properties.coverageSummary.totalStatements).toBe(1);
        expect(run.properties.coverageSummary.dynamicStatements).toBe(0);
        expect(run.properties.coverageSummary.coveragePercent).toBe(100);
    });

    it('should report reduced coverage when extraction warnings present', () => {
        const resultsWithWarnings: AnalysisResult[] = [{
            ...mockResults[0],
            statementCount: 4,
            extractionWarnings: [
                { filePath: 'test.sql', line: 1, column: 0, message: 'Dynamic SQL', unanalyzable: true },
                { filePath: 'test.sql', line: 5, column: 0, message: 'Template literal', unanalyzable: true },
            ],
        }];
        const output = reportSARIF(resultsWithWarnings);
        const sarif = JSON.parse(output);
        const coverage = sarif.runs[0].properties.coverageSummary;
        expect(coverage.totalStatements).toBe(4);
        expect(coverage.dynamicStatements).toBe(2);
        expect(coverage.coveragePercent).toBe(50);
    });

    it('should map risk levels to SARIF severity levels', () => {
        const output = reportSARIF(mockResults);
        const sarif = JSON.parse(output);
        const results = sarif.runs[0].results;
        for (const r of results) {
            expect(['error', 'warning', 'note']).toContain(r.level);
        }
    });

    it('should map HIGH risk to error level', () => {
        const output = reportSARIF(mockResults);
        const sarif = JSON.parse(output);
        const checkResult = sarif.runs[0].results.find(
            (r: { ruleId: string }) => r.ruleId === 'add-column-not-null-no-default',
        );
        expect(checkResult).toBeDefined();
        expect(checkResult.level).toBe('error');
    });

    it('should include policy violations as results', () => {
        const output = reportSARIF(mockResults);
        const sarif = JSON.parse(output);
        const policyResult = sarif.runs[0].results.find(
            (r: { ruleId: string }) => r.ruleId === 'policy-missing-lock-timeout',
        );
        expect(policyResult).toBeDefined();
        expect(policyResult.level).toBe('error');
        expect(policyResult.message.text).toContain('Missing lock_timeout');
    });

    it('should skip SAFE risk checks', () => {
        const safeResults: AnalysisResult[] = [{
            ...mockResults[0],
            checks: [{
                ...mockCheck,
                risk: RiskLevel.SAFE,
            }],
            policyViolations: [],
        }];
        const output = reportSARIF(safeResults);
        const sarif = JSON.parse(output);
        // SAFE checks should not appear in SARIF results
        expect(sarif.runs[0].results).toHaveLength(0);
    });

    it('should include artifact location with uriBaseId', () => {
        const output = reportSARIF(mockResults);
        const sarif = JSON.parse(output);
        const result = sarif.runs[0].results[0];
        const location = result.locations[0].physicalLocation.artifactLocation;
        expect(location.uri).toBe('test.sql');
        expect(location.uriBaseId).toBe('%SRCROOT%');
    });

    it('should include safe rewrite in message text when available', () => {
        const resultsWithRewrite: AnalysisResult[] = [{
            ...mockResults[0],
            checks: [{
                ...mockCheck,
                safeRewrite: {
                    description: 'Use NOT VALID then VALIDATE',
                    steps: ['ALTER TABLE ...;'],
                },
            }],
            policyViolations: [],
        }];
        const output = reportSARIF(resultsWithRewrite);
        const sarif = JSON.parse(output);
        const result = sarif.runs[0].results[0];
        expect(result.message.text).toContain('Safe rewrite: Use NOT VALID then VALIDATE');
    });
});
