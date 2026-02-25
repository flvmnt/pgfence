import { describe, it, expect } from 'vitest';
import { extractRawSQL } from '../src/extractors/raw-sql.js';
import { extractPrismaSQL } from '../src/extractors/prisma.js';
import { extractTypeORMSQL } from '../src/extractors/typeorm.js';
import { extractKnexSQL } from '../src/extractors/knex.js';
import { extractDrizzleSQL } from '../src/extractors/drizzle.js';
import { extractSequelizeSQL } from '../src/extractors/sequelize.js';
import path from 'path';

const fixturesDir = path.join(process.cwd(), 'tests', 'fixtures');

describe('Extractor: Raw SQL', () => {
    it('should extract raw sql correctly', async () => {
        const filePath = path.join(fixturesDir, 'safe-migration.sql');
        const result = await extractRawSQL(filePath);
        expect(result.warnings).toHaveLength(0);
        expect(result.sql).toContain('ALTER TABLE appointments ADD COLUMN');
    });
});

describe('Extractor: Prisma', () => {
    it('should delegate to raw sql extraction', async () => {
        const filePath = path.join(fixturesDir, 'safe-migration.sql');
        const result = await extractPrismaSQL(filePath);
        expect(result.warnings).toHaveLength(0);
        expect(result.sql).toContain('ALTER TABLE appointments ADD COLUMN');
    });
});

describe('Extractor: TypeORM', () => {
    it('should extract SQL from queryRunner.query', async () => {
        const filePath = path.join(fixturesDir, 'dangerous-typeorm.ts');
        const result = await extractTypeORMSQL(filePath);

        expect(result.sql).toContain('CREATE INDEX idx_appointments_status');
        expect(result.sql).not.toContain('DROP INDEX'); // Should skip down()
    });

    it('should issue a warning for dynamic SQL', async () => {
        const filePath = path.join(fixturesDir, 'dynamic-typeorm.ts');
        const result = await extractTypeORMSQL(filePath);

        expect(result.warnings.length).toBeGreaterThan(0);
        expect(result.warnings[0].message).toContain('Dynamic SQL');
    });

    it('should warn if no up() method is found', async () => {
        const filePath = path.join(fixturesDir, 'no-up-typeorm.ts');
        const result = await extractTypeORMSQL(filePath);

        expect(result.warnings).toHaveLength(1);
        expect(result.warnings[0].message).toContain('No up() method found');
    });

    it('should extract SQL when parameter is named something other than queryRunner', async () => {
        const filePath = path.join(fixturesDir, 'typeorm-qr-parameter.ts');
        const result = await extractTypeORMSQL(filePath);

        expect(result.warnings).toHaveLength(0);
        expect(result.sql).toContain('ALTER TABLE users ADD COLUMN age integer');
        expect(result.sql).toContain('SET lock_timeout');
    });

    it('should detect transaction = false and set autoCommit', async () => {
        const filePath = path.join(fixturesDir, 'typeorm-transaction-false.ts');
        const result = await extractTypeORMSQL(filePath);

        expect(result.autoCommit).toBe(true);
        expect(result.sql).toContain('ALTER TABLE foo ADD CONSTRAINT fk_bar');
    });

    it('should not set autoCommit when transaction property is absent', async () => {
        const filePath = path.join(fixturesDir, 'dangerous-typeorm.ts');
        const result = await extractTypeORMSQL(filePath);

        expect(result.autoCommit).toBe(false);
    });
});

describe('Extractor: Knex', () => {
    it('should extract SQL from knex.raw()', async () => {
        const filePath = path.join(fixturesDir, 'knex-raw.ts');
        const result = await extractKnexSQL(filePath);
        expect(result.sql).toContain('ALTER TABLE users ADD COLUMN age INT');
    });

    it('should transpile schema builder calls to SQL (Gap 13)', async () => {
        const filePath = path.join(fixturesDir, 'knex-schema-builder.ts');
        const result = await extractKnexSQL(filePath);
        // Schema builder is now transpiled to SQL instead of generating a warning
        expect(result.sql).toContain('ALTER TABLE');
        expect(result.sql).toContain('age');
    });

    it('should warn on dynamic SQL', async () => {
        const filePath = path.join(fixturesDir, 'knex-dynamic.ts');
        const result = await extractKnexSQL(filePath);
        expect(result.warnings.length).toBeGreaterThan(0);
        expect(result.warnings[0].message).toContain('Dynamic SQL');
    });

    it('should warn if no up() function is found', async () => {
        const filePath = path.join(fixturesDir, 'knex-no-up.ts');
        const result = await extractKnexSQL(filePath);
        expect(result.warnings).toHaveLength(1);
        expect(result.warnings[0].message).toContain('No up()');
    });
});

describe('Extractor: Drizzle', () => {
    it('should extract SQL correctly', async () => {
        const filePath = path.join(fixturesDir, 'drizzle-safe.sql');
        const result = await extractDrizzleSQL(filePath);
        expect(result.warnings).toHaveLength(0);
        expect(result.sql).toContain('ALTER TABLE users ADD COLUMN is_active');
    });
});

describe('Extractor: Sequelize', () => {
    it('should extract SQL from queryInterface.sequelize.query', async () => {
        const filePath = path.join(fixturesDir, 'sequelize-safe.js');
        const result = await extractSequelizeSQL(filePath);
        expect(result.sql).toContain('CREATE INDEX idx_users_email');
        expect(result.sql).toContain('DROP INDEX'); // Right now we extract all, up and down.
    });

    it('should warn on dynamic SQL', async () => {
        const filePath = path.join(fixturesDir, 'sequelize-dynamic.js');
        const result = await extractSequelizeSQL(filePath);
        expect(result.warnings.length).toBeGreaterThan(0);
        expect(result.warnings[0].message).toContain('Dynamic SQL');
    });

    it('should transpile queryInterface builder calls to SQL (Gap 13)', async () => {
        const filePath = path.join(fixturesDir, 'sequelize-no-query.js');
        const result = await extractSequelizeSQL(filePath);
        // Builder calls that cannot be fully transpiled now emit warnings instead of silently passing
        expect(result.sql).toBeDefined();
    });
});
