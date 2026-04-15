/**
 * LSP Folding Ranges provider.
 *
 * Returns a FoldingRange for each multi-line SQL statement, allowing
 * editors to collapse long DDL blocks (e.g. CREATE TABLE with many columns).
 */

import {
  FoldingRange,
  FoldingRangeKind,
} from 'vscode-languageserver';
import type { FoldingRangeParams } from 'vscode-languageserver';
import type { TextDocument } from 'vscode-languageserver-textdocument';
import type { AnalyzeTextResult } from './analyze-text.js';
import { offsetToPosition } from './diagnostics.js';
import { getStatementEntries } from './statement-groups.js';

export function getFoldingRanges(
  _params: FoldingRangeParams,
  analysis: AnalyzeTextResult,
  doc: TextDocument,
): FoldingRange[] {
  const text = doc.getText();
  const ranges: FoldingRange[] = [];

  for (const { sourceRange } of getStatementEntries(analysis)) {
    const start = offsetToPosition(text, sourceRange.startOffset);
    const end = offsetToPosition(text, sourceRange.endOffset);

    if (start.line === end.line) continue;

    ranges.push(FoldingRange.create(
      start.line,
      end.line,
      start.character,
      end.character,
      FoldingRangeKind.Region,
    ));
  }

  return ranges;
}
