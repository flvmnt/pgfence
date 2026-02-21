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
});
