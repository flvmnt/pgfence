import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fetchTableStats } from '../src/db-stats.js';

// Mock the 'pg' module
vi.mock('pg', () => {
    const mClient = {
        connect: vi.fn(),
        query: vi.fn(),
        end: vi.fn(),
    };
    return {
        default: { Client: vi.fn(() => mClient) },
        Client: vi.fn(() => mClient),
    };
});

describe('DB Stats Fetcher', () => {
    let mClient: any;

    beforeEach(async () => {
        vi.clearAllMocks();
        const pg = await import('pg');
        mClient = new pg.Client();
    });

    it('should fetch table stats successfully for multiple schemas and tables', async () => {
        // Setup mock query resolution
        mClient.query.mockResolvedValueOnce({}); // SET default_transaction_read_only = on
        mClient.query.mockResolvedValueOnce({}); // SET application_name = 'pgfence'

        // Detailed rows simulating pg_class, pg_namespace joining
        mClient.query.mockResolvedValueOnce({
            rows: [
                {
                    schemaname: 'public',
                    relname: 'users',
                    n_live_tup: '1500000',
                    total_bytes: '536870912', // 512 MB
                },
                {
                    schemaname: 'auth',
                    relname: 'tokens',
                    n_live_tup: '0',
                    total_bytes: '8192', // 8 KB
                },
            ],
        });

        const result = await fetchTableStats('postgres://user:pass@localhost:5432/mydb');

        expect(mClient.connect).toHaveBeenCalled();
        expect(mClient.query).toHaveBeenCalledTimes(3);

        // Verify the query passed explicitly asks for table stats
        const queryCall = mClient.query.mock.calls[2][0];
        expect(queryCall).toContain('pg_stat_user_tables');
        expect(queryCall).toContain('pg_total_relation_size');

        expect(mClient.end).toHaveBeenCalled();

        expect(result).toHaveLength(2);
        expect(result[0]).toEqual({
            schemaName: 'public',
            tableName: 'users',
            rowCount: 1500000,
            totalBytes: 536870912,
        });

        expect(result[1]).toEqual({
            schemaName: 'auth',
            tableName: 'tokens',
            rowCount: 0,
            totalBytes: 8192,
        });
    });

    it('should gracefully handle empty table return values', async () => {
        mClient.query.mockResolvedValueOnce({});
        mClient.query.mockResolvedValueOnce({});
        mClient.query.mockResolvedValueOnce({ rows: [] });

        const result = await fetchTableStats('postgres://user:pass@localhost:5432/mydb');
        expect(result).toHaveLength(0);
    });

    it('should ensure connections are closed on error', async () => {
        mClient.query.mockRejectedValue(new Error('Connection Failed'));

        await expect(fetchTableStats('postgres://dummy')).rejects.toThrow('Connection Failed');
        expect(mClient.end).toHaveBeenCalled();
    });
});
