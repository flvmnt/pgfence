/**
 * Human-readable "what did --fix actually do" summary.
 *
 * Always plain text (not swallowed into JSON/SARIF/GitLab's machine-readable
 * payloads): the CLI writes this to stdout for human-facing output formats and
 * to stderr for machine-readable ones, see src/index.ts.
 */

import type { FileFixReport } from './types.js';

function indent(lines: string[], prefix = '    '): string[] {
  return lines.map((line) => `${prefix}${line}`);
}

export function formatFixSummary(reports: FileFixReport[]): string {
  const lines: string[] = [];
  lines.push('');
  lines.push('pgfence --fix summary');
  lines.push('======================');

  let anyModified = false;
  let totalFixed = 0;
  let totalSkipped = 0;
  let totalGenerated = 0;

  for (const report of reports) {
    lines.push('');
    lines.push(`${report.filePath} (format: ${report.resolvedFormat})`);

    const fixed = report.tier1.filter((f) => f.status === 'fixed');
    const skipped = report.tier1.filter((f) => f.status === 'skipped');
    const generated = report.tier2.filter((t) => t.status === 'generated');
    const splitSkipped = report.tier2.filter((t) => t.status === 'skipped');
    const manual = report.manual;

    if (fixed.length === 0 && skipped.length === 0 && generated.length === 0 && splitSkipped.length === 0 && manual.length === 0) {
      lines.push('    (no fixable findings)');
      continue;
    }

    if (fixed.length > 0) {
      lines.push('  Fixed in place:');
      for (const f of fixed) {
        const detail = f.kind === 'policy'
          ? `added ${f.after}`
          : `${f.before} -> ${f.after}`;
        lines.push(...indent([`[${f.ruleId}] ${detail}`]));
        if (f.caveat) lines.push(...indent([`caveat: ${f.caveat}`], '      '));
      }
      totalFixed += fixed.length;
    }

    if (generated.length > 0) {
      lines.push('  Split into new files (--split):');
      for (const t of generated) {
        lines.push(...indent([`[${t.ruleId}] generated ${t.files?.length ?? 0} file(s):`]));
        for (const f of t.files ?? []) {
          lines.push(...indent([`- ${f.path} (${f.label})`], '      '));
        }
      }
      totalGenerated += generated.length;
    }

    if (skipped.length > 0 || splitSkipped.length > 0 || manual.length > 0) {
      lines.push('  Left for manual review:');
      for (const f of skipped) {
        lines.push(...indent([`[${f.ruleId}] ${f.reason}`]));
      }
      for (const t of splitSkipped) {
        lines.push(...indent([`[${t.ruleId}] ${t.reason}`]));
      }
      for (const f of manual) {
        lines.push(...indent([`[${f.ruleId}] ${f.reason}`]));
      }
      totalSkipped += skipped.length + splitSkipped.length + manual.length;
    }

    if (report.modified) anyModified = true;
  }

  lines.push('');
  lines.push(
    `${totalFixed} finding(s) fixed in place, ${totalGenerated} recipe(s) split into new files, ` +
    `${totalSkipped} left for manual review.`,
  );
  if (anyModified) {
    lines.push('Modified file(s) were re-analyzed; the report above reflects the post-fix state.');
  }
  lines.push('');

  return lines.join('\n');
}
