import { describe, it, expect } from 'vitest';
import { parseSQL, makePreview } from '../src/parser.js';

describe('parser', () => {
    it('should format long SQL statements correctly', () => {
        const longSql = 'SELECT * FROM users WHERE id = 1 AND status = active AND role = admin AND ' + 'a'.repeat(90);
        const preview = makePreview(longSql, 50);
        expect(preview.length).toBeLessThanOrEqual(50);
        expect(preview).toMatch(/.*\.\.\.$/);
    });

    it('should trim comments correctly', () => {
        const sql = '/* block comment */ SELECT * FROM -- inline comment\n users;';
        const preview = makePreview(sql);
        expect(preview).toBe('SELECT * FROM users;');
    });

    it('should parse single statements', async () => {
        const ast = await parseSQL('SELECT 1;');
        expect(ast.length).toBe(1);
        expect(ast[0].nodeType).toBe('SelectStmt');
        expect(ast[0].sql).toBe('SELECT 1');
    });

    it('should detect parsing errors', async () => {
        await expect(parseSQL('THIS IS NOT SQL;')).rejects.toThrow();
    });

    it('should return correct character offsets for multi-statement SQL', async () => {
        const sql = 'SELECT 1;\nALTER TABLE t ADD COLUMN c int;';
        const stmts = await parseSQL(sql);
        expect(stmts.length).toBe(2);
        expect(stmts[0].startOffset).toBe(0);
        // Offsets should not overlap and should cover the statement text
        expect(stmts[0].endOffset).toBeLessThanOrEqual(stmts[1].startOffset);
        expect(sql.slice(stmts[0].startOffset, stmts[0].endOffset)).toContain('SELECT 1');
        expect(sql.slice(stmts[1].startOffset, stmts[1].endOffset)).toContain('ALTER TABLE');
        expect(stmts[1].endOffset).toBeLessThanOrEqual(sql.length);
    });

    it('should handle multi-byte UTF-8 characters in offset calculation', async () => {
        // CJK chars (3 bytes each in UTF-8) would shift byte offsets
        const sql = "SELECT '日本語'; SELECT 2;";
        const stmts = await parseSQL(sql);
        expect(stmts.length).toBe(2);
        // Second statement should start at the correct character index
        const secondStart = stmts[1].startOffset;
        // The character at secondStart should be 'S' (start of SELECT 2)
        // or a space before it
        const charAtStart = sql[secondStart];
        expect([' ', 'S']).toContain(charAtStart);
        // The extracted SQL should contain SELECT 2
        expect(stmts[1].sql).toContain('SELECT 2');
    });

    it('should assign endOffset = sql.length for last statement without stmt_len', async () => {
        const sql = 'SELECT 1';
        const stmts = await parseSQL(sql);
        expect(stmts.length).toBe(1);
        expect(stmts[0].startOffset).toBe(0);
        expect(stmts[0].endOffset).toBe(sql.length);
    });
});
