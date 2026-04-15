/**
 * LSP Document Symbols provider.
 *
 * Returns one DocumentSymbol per flagged statement, enabling the
 * Outline / breadcrumb panel in editors (VS Code, Zed, Helix, etc.).
 */

import {
  DocumentSymbol,
  SymbolKind,
  Range,
} from 'vscode-languageserver';
import type { DocumentSymbolParams } from 'vscode-languageserver';
import type { TextDocument } from 'vscode-languageserver-textdocument';
import type { AnalyzeTextResult } from './analyze-text.js';
import { offsetToPosition } from './diagnostics.js';
import { getStatementEntries } from './statement-groups.js';

export function getDocumentSymbols(
  _params: DocumentSymbolParams,
  analysis: AnalyzeTextResult,
  doc: TextDocument,
): DocumentSymbol[] {
  const text = doc.getText();
  const symbols: DocumentSymbol[] = [];

  for (const { check, sourceRange } of getStatementEntries(analysis)) {

    const start = offsetToPosition(text, sourceRange.startOffset);
    const end = offsetToPosition(text, sourceRange.endOffset);
    const range = Range.create(start, end);

    symbols.push({
      name: check.statementPreview,
      detail: check.tableName ?? '',
      kind: SymbolKind.Module,
      range,
      selectionRange: range,
    });
  }

  return symbols;
}
