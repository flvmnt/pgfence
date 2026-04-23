import { describe, it, expect } from 'vitest';
import { reportJSON } from '../src/reporters/json.js';
import { reportCLI } from '../src/reporters/cli.js';
import { reportGitHub } from '../src/reporters/github-pr.js';
import { reportSARIF } from '../src/reporters/sarif.js';
import { reportGitLab } from '../src/reporters/gitlab.js';
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

function stripAnsi(text: string): string {
    const ansiPattern = new RegExp(String.fromCharCode(27) + '\\[[0-?]*[ -/]*[@-~]', 'g');
    let result = '';
    for (const chunk of text.split(ansiPattern)) {
        result += chunk;
    }
    return result;
}

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

        expect(parsed.coverage.totalStatements).toBe(3);
        expect(parsed.coverage.analyzedStatements).toBe(2);
        expect(parsed.coverage.dynamicStatements).toBe(1);
        expect(parsed.coverage.coveragePercent).toBe(67);
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
        expect(output).toMatch(/Coverage: 75%/);
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

    it('should display [UNANALYZABLE] header label for safe files with unanalyzable warnings', () => {
        const unanalyzableResults: AnalysisResult[] = [{
            ...mockResults[0],
            checks: [],
            policyViolations: [],
            maxRisk: RiskLevel.SAFE,
            extractionWarnings: [
                { filePath: 'test.ts', line: 3, column: 2, message: 'Dynamic SQL', unanalyzable: true },
            ],
        }];
        const output = reportCLI(unanalyzableResults, mockConfig);
        expect(output).toContain('[UNANALYZABLE]');
        expect(output).not.toContain('No dangerous statements detected.');
        expect(output).toContain('unanalyzable statements requiring manual review');
    });

    it('should put LOW-risk safe rewrites in Notes section, not Safe Rewrite Recipes', () => {
        const lowRiskWithRewrite: AnalysisResult[] = [{
            ...mockResults[0],
            checks: [
                {
                    ...mockCheck,
                    risk: RiskLevel.LOW,
                    safeRewrite: { description: 'Low risk note', steps: ['-- no action needed'] },
                }
            ]
        }];
        const output = reportCLI(lowRiskWithRewrite, mockConfig);
        expect(output).toContain('Notes / Why this is safe:');
        expect(output).not.toContain('Safe Rewrite Recipes:');
        expect(output).toContain('Low risk note');
    });

    it('should display "(was X)" when a check has adjustedRisk different from base risk', () => {
        const adjustedResults: AnalysisResult[] = [{
            ...mockResults[0],
            policyViolations: [],
            checks: [
                {
                    ...mockCheck,
                    risk: RiskLevel.LOW,
                    adjustedRisk: RiskLevel.HIGH,
                    message: 'This is safe but table is large',
                    ruleId: 'rename-column',
                }
            ],
            maxRisk: RiskLevel.HIGH,
        }];
        const output = reportCLI(adjustedResults, mockConfig);
        // cli-table3 may word-wrap "(was LOW)" across cell rows, so check the parts separately.
        const noAnsi = stripAnsi(output);
        expect(noAnsi).toContain('(was');
        expect(noAnsi).toContain('LOW)');
        expect(noAnsi).toContain('HIGH');
    });

    it('should keep later repeated statements visible as separate rows', () => {
        const repeatedResults: AnalysisResult[] = [{
            ...mockResults[0],
            policyViolations: [],
            checks: [
                mockCheck,
                {
                    ...mockCheck,
                    statement: 'CREATE INDEX idx_users_email ON users (email);',
                    statementPreview: 'CREATE INDEX idx_users_email ON users',
                    tableName: 'users',
                    lockMode: LockMode.SHARE,
                    blocks: { reads: false, writes: true, otherDdl: true },
                    risk: RiskLevel.MEDIUM,
                    message: 'Index build blocks writes without CONCURRENTLY',
                    ruleId: 'create-index-not-concurrent',
                },
                { ...mockCheck },
            ],
        }];

        const output = stripAnsi(reportCLI(repeatedResults, mockConfig));
        const matches = output.match(/ALTER TABLE users ADD COLUMN foo/g) ?? [];
        expect(matches).toHaveLength(2);
    });
});

describe('Reporter: GitHub PR', () => {
    it('should format output as a Markdown table', () => {
        const output = reportGitHub(mockResults);

        expect(output).toContain('## pgfence Migration Safety Report');
        expect(output).toContain('<code>test.sql</code>');
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
        expect(output).toContain('> :warning: <code>Dynamic SQL</code>');
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

    it('should escape user-controlled markdown and HTML in rendered content', () => {
        const maliciousResults: AnalysisResult[] = [{
            ...mockResults[0],
            policyViolations: [],
            checks: [
                {
                    ...mockCheck,
                    statementPreview: 'ALTER TABLE users ADD COLUMN foo | **bold** <script>alert(1)</script>',
                    message: 'Use [link](https://example.com) and `code`',
                    safeRewrite: {
                        description: 'desc </summary><script>alert(1)</script>',
                        steps: ['ALTER TABLE users ADD COLUMN foo text; -- keep | safe'],
                    },
                },
            ],
        }];

        const output = reportGitHub(maliciousResults);
        expect(output).toContain('&#124;');
        expect(output).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
        expect(output).toContain('<code>Use [link](https://example.com) and `code`</code>');
        expect(output).not.toContain('<a href="https://example.com">');
        expect(output).not.toContain('</summary><script>');
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
        expect(output).toMatch(/Coverage: \*\*67%\*\*/);
    });

    it('should put LOW-risk safe rewrites in Notes section, not Safe Rewrite Recipes', () => {
        const lowRiskWithRewrite: AnalysisResult[] = [{
            ...mockResults[0],
            checks: [
                {
                    ...mockCheck,
                    risk: RiskLevel.LOW,
                    safeRewrite: { description: 'Low risk note', steps: ['-- no lock taken'] },
                }
            ]
        }];
        const output = reportGitHub(lowRiskWithRewrite);
        expect(output).toContain('Notes / Why this is safe');
        expect(output).not.toContain('Safe Rewrite Recipes');
        expect(output).toContain('Low risk note');
    });

    it('should not claim safety for files with unanalyzable statements', () => {
        const unanalyzableResults: AnalysisResult[] = [{
            ...mockResults[0],
            checks: [],
            policyViolations: [],
            maxRisk: RiskLevel.SAFE,
            extractionWarnings: [
                { filePath: 'test.sql', line: 7, column: 1, message: 'Dynamic SQL', unanalyzable: true },
            ],
        }];

        const output = reportGitHub(unanalyzableResults);
        expect(output).toContain('UNANALYZABLE');
        expect(output).toContain('manual review');
        expect(output).not.toContain('No dangerous statements detected.');
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
        expect(coverage.totalStatements).toBe(6);
        expect(coverage.analyzedStatements).toBe(4);
        expect(coverage.dynamicStatements).toBe(2);
        expect(coverage.coveragePercent).toBe(67);
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

    it('should surface extraction warnings as SARIF results with source regions', () => {
        const resultsWithWarnings: AnalysisResult[] = [{
            ...mockResults[0],
            checks: [],
            policyViolations: [],
            extractionWarnings: [
                { filePath: 'test.sql', line: 7, column: 3, message: 'Dynamic SQL', unanalyzable: true },
            ],
        }];

        const output = reportSARIF(resultsWithWarnings);
        const sarif = JSON.parse(output);
        const warning = sarif.runs[0].results.find(
            (r: { ruleId: string }) => r.ruleId === 'pgfence-extraction-warning',
        );

        expect(warning).toBeDefined();
        expect(warning.level).toBe('warning');
        expect(warning.message.text).toContain('Dynamic SQL');
        expect(warning.locations[0].physicalLocation.region.startLine).toBe(7);
        expect(warning.locations[0].physicalLocation.region.startColumn).toBe(4);
    });
});

describe('Reporter: GitLab CI', () => {
    it('should produce a valid JSON array (not an object)', () => {
        const output = reportGitLab(mockResults);
        const parsed = JSON.parse(output);
        expect(Array.isArray(parsed)).toBe(true);
    });

    it('should include required GitLab Code Quality fields', () => {
        const output = reportGitLab(mockResults);
        const parsed = JSON.parse(output);
        expect(parsed.length).toBeGreaterThan(0);
        const violation = parsed[0];
        expect(violation).toHaveProperty('description');
        expect(violation).toHaveProperty('check_name');
        expect(violation).toHaveProperty('fingerprint');
        expect(violation).toHaveProperty('severity');
        expect(violation).toHaveProperty('location');
        expect(violation.location).toHaveProperty('path');
        expect(violation.location).toHaveProperty('lines');
        expect(violation.location.lines).toHaveProperty('begin');
    });

    it('should map HIGH risk to "major" severity', () => {
        const output = reportGitLab(mockResults);
        const parsed = JSON.parse(output);
        const checkViolation = parsed.find((v: { check_name: string }) => v.check_name === 'add-column-not-null-no-default');
        expect(checkViolation).toBeDefined();
        expect(checkViolation.severity).toBe('major');
    });

    it('should map CRITICAL risk to "blocker" severity', () => {
        const criticalResults: AnalysisResult[] = [{
            ...mockResults[0],
            policyViolations: [],
            checks: [{ ...mockCheck, risk: RiskLevel.CRITICAL }],
            maxRisk: RiskLevel.CRITICAL,
        }];
        const output = reportGitLab(criticalResults);
        const parsed = JSON.parse(output);
        expect(parsed[0].severity).toBe('blocker');
    });

    it('should map policy error severity to "critical"', () => {
        const output = reportGitLab(mockResults);
        const parsed = JSON.parse(output);
        const policyViolation = parsed.find((v: { check_name: string }) => v.check_name === 'policy-missing-lock-timeout');
        expect(policyViolation).toBeDefined();
        expect(policyViolation.severity).toBe('critical');
    });

    it('should produce stable fingerprints for identical inputs', () => {
        const output1 = reportGitLab(mockResults);
        const output2 = reportGitLab(mockResults);
        const p1 = JSON.parse(output1);
        const p2 = JSON.parse(output2);
        expect(p1[0].fingerprint).toBe(p2[0].fingerprint);
    });

    it('should strip leading "./" from file paths', () => {
        const resultsWithRelPath: AnalysisResult[] = [{
            ...mockResults[0],
            filePath: './migrations/001.sql',
        }];
        const output = reportGitLab(resultsWithRelPath);
        const parsed = JSON.parse(output);
        expect(parsed[0].location.path).toBe('migrations/001.sql');
    });

    it('should strip leading "/" from file paths', () => {
        const resultsWithAbsPath: AnalysisResult[] = [{
            ...mockResults[0],
            filePath: '/migrations/001.sql',
        }];
        const output = reportGitLab(resultsWithAbsPath);
        const parsed = JSON.parse(output);
        expect(parsed[0].location.path).toBe('migrations/001.sql');
    });

    it('should include both checks and policy violations', () => {
        const output = reportGitLab(mockResults);
        const parsed = JSON.parse(output);
        const checkEntry = parsed.find((v: { check_name: string }) => v.check_name === 'add-column-not-null-no-default');
        const policyEntry = parsed.find((v: { check_name: string }) => v.check_name === 'policy-missing-lock-timeout');
        expect(checkEntry).toBeDefined();
        expect(policyEntry).toBeDefined();
    });

    it('should keep repeated findings distinct via fingerprints', () => {
        const repeatedResults: AnalysisResult[] = [{
            ...mockResults[0],
            policyViolations: [],
            checks: [
                mockCheck,
                { ...mockCheck },
            ],
        }];

        const output = reportGitLab(repeatedResults);
        const parsed = JSON.parse(output);
        const findings = parsed.filter((v: { check_name: string }) => v.check_name === 'add-column-not-null-no-default');
        expect(findings).toHaveLength(2);
        expect(new Set(findings.map((v: { fingerprint: string }) => v.fingerprint)).size).toBe(2);
    });

    it('should preserve extraction warnings and emit a coverage summary entry', () => {
        const resultsWithWarnings: AnalysisResult[] = [{
            ...mockResults[0],
            statementCount: 2,
            extractionWarnings: [
                { filePath: 'test.sql', line: 7, column: 3, message: 'Dynamic SQL', unanalyzable: true },
            ],
        }];

        const output = reportGitLab(resultsWithWarnings);
        const parsed = JSON.parse(output);
        const warning = parsed.find((v: { check_name: string }) => v.check_name === 'pgfence-extraction-warning');
        const coverage = parsed.find((v: { check_name: string }) => v.check_name === 'pgfence-coverage-summary');

        expect(warning).toBeDefined();
        expect(warning.severity).toBe('minor');
        expect(coverage).toBeDefined();
        expect(coverage.description).toContain('Analyzed 2 SQL statements');
        expect(coverage.description).toContain('1 dynamic statements not analyzable');
    });
});

describe('LSP Export Safety', () => {
    it('should import the CLI module without auto-running the command parser', async () => {
        const mod = await import('../src/index.ts');
        expect(mod).toBeDefined();
    });
});
