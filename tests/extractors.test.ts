import { describe, it, expect } from 'vitest';
import { extractRawSQL } from '../src/extractors/raw-sql.js';
import { extractPrismaSQL } from '../src/extractors/prisma.js';
import { extractTypeORMSQL } from '../src/extractors/typeorm.js';
import { extractKnexSQL } from '../src/extractors/knex.js';
import { extractDrizzleSQL } from '../src/extractors/drizzle.js';
import { extractSequelizeSQL } from '../src/extractors/sequelize.js';
import path from 'path';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';

const fixturesDir = path.join(process.cwd(), 'tests', 'fixtures');

async function withTempFile(prefix: string, suffix: string, content: string, run: (filePath: string) => Promise<void>): Promise<void> {
    const dir = await mkdtemp(path.join(tmpdir(), prefix));
    const filePath = path.join(dir, `migration${suffix}`);
    await writeFile(filePath, content, 'utf8');
    try {
        await run(filePath);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
}

describe('Extractor: Raw SQL', () => {
    it('should extract raw sql correctly', async () => {
        const filePath = path.join(fixturesDir, 'safe-migration.sql');
        const result = await extractRawSQL(filePath);
        expect(result.warnings).toHaveLength(0);
        expect(result.sql).toContain('ALTER TABLE appointments ADD COLUMN');
    });

    it('should fail closed for binary-looking files', async () => {
        await withTempFile('pgfence-binary-sql-', '.sql', 'ALTER TABLE users ADD COLUMN a int;\0', async (filePath) => {
            await expect(extractRawSQL(filePath)).rejects.toThrow('appears to be binary');
        });
    });

    it('should fail closed for files over the configured size limit', async () => {
        const originalLimit = process.env.PGFENCE_MAX_MIGRATION_BYTES;
        process.env.PGFENCE_MAX_MIGRATION_BYTES = '10';
        try {
            await withTempFile('pgfence-large-sql-', '.sql', 'ALTER TABLE users ADD COLUMN a int;', async (filePath) => {
                await expect(extractRawSQL(filePath)).rejects.toThrow('too large to analyze safely');
            });
        } finally {
            if (originalLimit === undefined) {
                delete process.env.PGFENCE_MAX_MIGRATION_BYTES;
            } else {
                process.env.PGFENCE_MAX_MIGRATION_BYTES = originalLimit;
            }
        }
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
        expect(result.warnings[0].unanalyzable).toBe(true);
    });

    it('should extract SQL from aliased queryRunner variables', async () => {
        await withTempFile('pgfence-typeorm-alias-', '.ts', `import { MigrationInterface, QueryRunner } from 'typeorm';
export class DropUsers implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    const qr = queryRunner;
    await qr.query('DROP TABLE users');
  }
}`, async (filePath) => {
            const result = await extractTypeORMSQL(filePath);
            expect(result.sql).toContain('DROP TABLE users');
            expect(result.sourceRanges).toHaveLength(1);
        });
    });

    it('should mark conditional SQL as unanalyzable for strict unknown handling', async () => {
        await withTempFile('pgfence-typeorm-conditional-', '.ts', `import { MigrationInterface, QueryRunner } from 'typeorm';
export class ConditionalDrop implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    if (process.env.DROP_USERS) {
      await queryRunner.query('DROP TABLE users');
    }
  }
}`, async (filePath) => {
            const result = await extractTypeORMSQL(filePath);
            expect(result.sql).toContain('DROP TABLE users');
            expect(result.warnings.some((warning) => warning.unanalyzable)).toBe(true);
            expect(result.warnings.some((warning) => warning.message.includes('Conditional SQL'))).toBe(true);
        });
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

    it('should transpile schema builder calls to SQL', async () => {
        const filePath = path.join(fixturesDir, 'knex-schema-builder.ts');
        const result = await extractKnexSQL(filePath);
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
        expect(result.warnings[0].unanalyzable).toBe(true);
    });

    it('should extract SQL from object-style module exports', async () => {
        await withTempFile('pgfence-knex-object-export-', '.js', `module.exports = {
  async up(knex) {
    await knex.raw('DROP TABLE users');
  }
};`, async (filePath) => {
            const result = await extractKnexSQL(filePath);
            expect(result.sql).toContain('DROP TABLE users');
        });
    });

    it('should extract SQL from destructured raw aliases', async () => {
        await withTempFile('pgfence-knex-raw-alias-', '.js', `exports.up = async function(knex) {
  const { raw } = knex;
  await raw('DROP TABLE users');
};`, async (filePath) => {
            const result = await extractKnexSQL(filePath);
            expect(result.sql).toContain('DROP TABLE users');
        });
    });

    it('should mark conditional raw SQL as unanalyzable for strict unknown handling', async () => {
        await withTempFile('pgfence-knex-conditional-', '.js', `exports.up = async function(knex) {
  if (process.env.DROP_USERS) {
    await knex.raw('DROP TABLE users');
  }
};`, async (filePath) => {
            const result = await extractKnexSQL(filePath);
            expect(result.sql).toContain('DROP TABLE users');
            expect(result.warnings.some((warning) => warning.unanalyzable)).toBe(true);
            expect(result.warnings.some((warning) => warning.message.includes('Conditional SQL'))).toBe(true);
        });
    });

    it('should warn on dynamic Knex builder column names', async () => {
        await withTempFile('pgfence-knex-dynamic-column-', '.js', `exports.up = async function(knex) {
  const columnName = 'old_name';
  await knex.schema.alterTable('users', function(table) {
    table.dropColumn(columnName);
  });
};`, async (filePath) => {
            const result = await extractKnexSQL(filePath);
            expect(result.warnings.some((warning) => warning.unanalyzable)).toBe(true);
            expect(result.warnings.some((warning) => warning.message.includes('Dynamic column name'))).toBe(true);
        });
    });

    it('should fix references().inTable() chain and escape quotes in defaults', async () => {
        const filePath = path.join(fixturesDir, 'knex-references-intable.ts');
        const result = await extractKnexSQL(filePath);
        expect(result.sql).toContain('REFERENCES "users"("id")');
        expect(result.sql).toContain('ON DELETE CASCADE');
        expect(result.sql).toContain("it''s pending");
    });

    it('should warn and fail closed when Knex REFERENCES is incomplete', async () => {
        const filePath = path.join(fixturesDir, 'knex-references-missing-intable.ts');
        const result = await extractKnexSQL(filePath);
        expect(result.warnings.some((w) => w.unanalyzable)).toBe(true);
        expect(result.sql).not.toContain('REFERENCES');
    });

    it('should detect Knex transaction = false and set autoCommit', async () => {
        const filePath = path.join(fixturesDir, 'knex-transaction-false.ts');
        const result = await extractKnexSQL(filePath);
        expect(result.autoCommit).toBe(true);
        expect(result.sql).toContain('CREATE INDEX CONCURRENTLY');
    });

    it('should handle knex.schema.table() alias for alterTable', async () => {
        const filePath = path.join(fixturesDir, 'knex-table-alias.ts');
        const result = await extractKnexSQL(filePath);
        expect(result.sql).toContain('ALTER TABLE');
        expect(result.sql).toContain('nickname');
    });

    it('should handle createTableIfNotExists and dropTableIfExists', async () => {
        const filePath = path.join(fixturesDir, 'knex-if-exists.ts');
        const result = await extractKnexSQL(filePath);
        expect(result.sql).toContain('CREATE TABLE IF NOT EXISTS');
    });

    it('should handle timestamps() method producing two columns', async () => {
        const filePath = path.join(fixturesDir, 'knex-timestamps.ts');
        const result = await extractKnexSQL(filePath);
        expect(result.sql).toContain('created_at');
        expect(result.sql).toContain('updated_at');
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
        expect(result.sql).not.toContain('DROP INDEX');
        expect(result.sourceRanges).toHaveLength(1);
    });

    it('should warn on dynamic SQL', async () => {
        const filePath = path.join(fixturesDir, 'sequelize-dynamic.js');
        const result = await extractSequelizeSQL(filePath);
        expect(result.warnings.length).toBeGreaterThan(0);
        expect(result.warnings[0].message).toContain('Dynamic SQL');
    });

    it('should warn as unanalyzable if no up() function is found', async () => {
        await withTempFile('pgfence-sequelize-no-up-', '.js', `module.exports = {
  async down(queryInterface) {
    await queryInterface.sequelize.query('DROP TABLE users');
  }
};`, async (filePath) => {
            const result = await extractSequelizeSQL(filePath);
            expect(result.warnings).toHaveLength(1);
            expect(result.warnings[0].message).toContain('No up() function found');
            expect(result.warnings[0].unanalyzable).toBe(true);
        });
    });

    it('should map raw Sequelize SQL back to the original source range', async () => {
        await withTempFile('pgfence-sequelize-range-', '.js', `module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query('DROP TABLE users');
  }
};`, async (filePath) => {
            const result = await extractSequelizeSQL(filePath);
            const range = result.sourceRanges?.[0];
            expect(range).toBeDefined();
            const source = `module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query('DROP TABLE users');
  }
};`;
            expect(source.slice(range!.startOffset, range!.endOffset)).toBe('DROP TABLE users');
        });
    });

    it('should mark conditional raw SQL as unanalyzable for strict unknown handling', async () => {
        await withTempFile('pgfence-sequelize-conditional-', '.js', `module.exports = {
  async up(queryInterface) {
    if (process.env.DROP_USERS) {
      await queryInterface.sequelize.query('DROP TABLE users');
    }
  }
};`, async (filePath) => {
            const result = await extractSequelizeSQL(filePath);
            expect(result.sql).toContain('DROP TABLE users');
            expect(result.warnings.some((warning) => warning.unanalyzable)).toBe(true);
            expect(result.warnings.some((warning) => warning.message.includes('Conditional SQL'))).toBe(true);
        });
    });

    it('should transpile queryInterface builder calls to SQL', async () => {
        const filePath = path.join(fixturesDir, 'sequelize-no-query.js');
        const result = await extractSequelizeSQL(filePath);
        expect(result.sql).toBeDefined();
    });

    it('should only extract from up() method, not down()', async () => {
        const filePath = path.join(fixturesDir, 'sequelize-up-only.js');
        const result = await extractSequelizeSQL(filePath);
        expect(result.sql).toContain('ADD COLUMN');
        expect(result.sql).not.toContain('DROP COLUMN');
    });

    it('should handle addConstraint and removeConstraint', async () => {
        const filePath = path.join(fixturesDir, 'sequelize-add-constraint.js');
        const result = await extractSequelizeSQL(filePath);
        expect(result.sql).toContain('UNIQUE');
        expect(result.sql).toContain('FOREIGN KEY');
        expect(result.sql).toContain('REFERENCES "users"');
        expect(result.sql).not.toContain('DROP CONSTRAINT');
    });

    it('should warn and fail closed when Sequelize REFERENCES metadata is incomplete', async () => {
        const filePath = path.join(fixturesDir, 'sequelize-dynamic-fk.js');
        const result = await extractSequelizeSQL(filePath);
        expect(result.warnings.some((w) => w.unanalyzable)).toBe(true);
        expect(result.sql).not.toContain('REFERENCES');
    });

    it('should warn and fail closed for partial Sequelize addIndex options', async () => {
        const filePath = path.join(fixturesDir, 'sequelize-partial-index.js');
        const result = await extractSequelizeSQL(filePath);
        expect(result.warnings.some((w) => w.unanalyzable)).toBe(true);
        expect(result.sql).not.toContain('CREATE INDEX');
    });

    it('should detect Sequelize.literal() as volatile default', async () => {
        const filePath = path.join(fixturesDir, 'sequelize-literal-default.js');
        const result = await extractSequelizeSQL(filePath);
        expect(result.sql).toContain('pgfence_volatile_expr');
    });
});

describe('Extractor: TypeORM builder API', () => {
    it('should warn on builder API usage', async () => {
        const filePath = path.join(fixturesDir, 'typeorm-builder-api.ts');
        const result = await extractTypeORMSQL(filePath);
        expect(result.warnings.length).toBeGreaterThan(0);
        expect(result.warnings.every((w) => w.unanalyzable)).toBe(true);
        const builderWarnings = result.warnings.filter(w =>
            w.message.includes('TypeORM builder API detected')
        );
        expect(builderWarnings.length).toBeGreaterThanOrEqual(2);
        expect(builderWarnings[0].message).toContain('createTable');
        expect(builderWarnings[1].message).toContain('addColumn');
    });

    it('should warn on expanded builder methods: dropTable, clearTable, renameTable, createCheckConstraint, createView', async () => {
        const filePath = path.join(fixturesDir, 'typeorm-builder-expanded.ts');
        const result = await extractTypeORMSQL(filePath);
        const builderWarnings = result.warnings.filter(w =>
            w.message.includes('TypeORM builder API detected')
        );
        expect(builderWarnings.length).toBe(5);
        expect(builderWarnings[0].message).toContain('dropTable');
        expect(builderWarnings[1].message).toContain('clearTable');
        expect(builderWarnings[2].message).toContain('renameTable');
        expect(builderWarnings[3].message).toContain('createCheckConstraint');
        expect(builderWarnings[4].message).toContain('createView');
    });
});

describe('Extractor: Knex .alter() modifier', () => {
    it('should emit ALTER COLUMN TYPE instead of ADD COLUMN', async () => {
        const filePath = path.join(fixturesDir, 'knex-alter-modifier.ts');
        const result = await extractKnexSQL(filePath);
        expect(result.sql).toContain('ALTER COLUMN "name" TYPE varchar(500)');
        expect(result.sql).toContain('ALTER COLUMN "email" SET NOT NULL');
        expect(result.sql).not.toContain('ADD COLUMN');
    });
});

describe('Extractor: Knex setNullable/dropNullable', () => {
    it('should emit ALTER COLUMN SET/DROP NOT NULL', async () => {
        const filePath = path.join(fixturesDir, 'knex-set-nullable.ts');
        const result = await extractKnexSQL(filePath);
        expect(result.sql).toContain('ALTER COLUMN "email" DROP NOT NULL');
        expect(result.sql).toContain('ALTER COLUMN "username" SET NOT NULL');
    });
});

describe('Extractor: Knex dropColumns (plural)', () => {
    it('should emit DROP COLUMN for each column', async () => {
        const filePath = path.join(fixturesDir, 'knex-drop-columns.ts');
        const result = await extractKnexSQL(filePath);
        expect(result.sql).toContain('DROP COLUMN "temp1"');
        expect(result.sql).toContain('DROP COLUMN "temp2"');
    });
});

describe('Extractor: Sequelize addIndex with options', () => {
    it('should handle concurrently, unique, and name options', async () => {
        const filePath = path.join(fixturesDir, 'sequelize-add-index-options.js');
        const result = await extractSequelizeSQL(filePath);
        expect(result.sql).toContain('CREATE UNIQUE INDEX CONCURRENTLY');
        expect(result.sql).toContain('idx_users_email_unique');
    });
});

describe('Extractor: Sequelize addConstraint with onDelete/onUpdate', () => {
    it('should include ON DELETE and ON UPDATE clauses', async () => {
        const filePath = path.join(fixturesDir, 'sequelize-constraint-cascade.js');
        const result = await extractSequelizeSQL(filePath);
        expect(result.sql).toContain('FOREIGN KEY');
        expect(result.sql).toContain('ON DELETE CASCADE');
        expect(result.sql).toContain('ON UPDATE SET NULL');
        expect(result.sql).not.toContain('DROP CONSTRAINT');
    });
});
