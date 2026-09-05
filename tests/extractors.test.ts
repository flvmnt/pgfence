import { describe, it, expect } from 'vitest';
import { extractRawSQL } from '../src/extractors/raw-sql.js';
import { extractPrismaSQL } from '../src/extractors/prisma.js';
import { extractTypeORMSQL } from '../src/extractors/typeorm.js';
import { extractKnexSQL } from '../src/extractors/knex.js';
import { extractDrizzleSQL } from '../src/extractors/drizzle.js';
import { extractSequelizeSQL } from '../src/extractors/sequelize.js';
import { extractKyselySQL } from '../src/extractors/kysely.js';
import { parseSQL } from '../src/parser.js';
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

    it('should extract SQL from aliased TypeORM manager variables', async () => {
        await withTempFile('pgfence-typeorm-manager-alias-', '.ts', `import { MigrationInterface, QueryRunner } from 'typeorm';
export class DropUsers implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    const manager = queryRunner.manager;
    await manager.query('DROP TABLE users');
  }
}`, async (filePath) => {
            const result = await extractTypeORMSQL(filePath);
            expect(result.sql).toContain('DROP TABLE users');
            expect(result.warnings.some((warning) => warning.unanalyzable)).not.toBe(true);
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

    it('should not inherit transaction = false from unrelated trailing classes', async () => {
        await withTempFile('pgfence-typeorm-trailing-helper-', '.ts', `import { MigrationInterface, QueryRunner } from 'typeorm';
export class AddUsersIndex implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('CREATE INDEX CONCURRENTLY idx_users_email ON users(email)');
  }
}

class Helper {
  transaction = false;
}`, async (filePath) => {
            const result = await extractTypeORMSQL(filePath);
            expect(result.autoCommit).toBe(false);
            expect(result.sql).toContain('CREATE INDEX CONCURRENTLY');
        });
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

    it('should transpile schema builder calls from aliased Knex schema variables', async () => {
        await withTempFile('pgfence-knex-schema-alias-', '.js', `exports.up = async function(knex) {
  const schema = knex.schema;
  await schema.dropTable('users');
};`, async (filePath) => {
            const result = await extractKnexSQL(filePath);
            expect(result.sql).toContain('DROP TABLE "users"');
            expect(result.warnings.some((warning) => warning.unanalyzable)).not.toBe(true);
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

    it('should transpile standalone Knex table index and constraint builders', async () => {
        await withTempFile('pgfence-knex-table-ops-', '.js', `exports.up = async function(knex) {
  await knex.schema.alterTable('users', function(table) {
    table.index(['last_name', 'first_name'], 'idx_users_name');
    table.unique('email');
    table.primary(['tenant_id', 'id'], { constraintName: 'users_tenant_id_pkey' });
    table.foreign('account_id').references('accounts.id').onDelete('CASCADE');
    table.dropIndex(['legacy_code']);
    table.dropForeign('old_account_id');
  });
};`, async (filePath) => {
            const result = await extractKnexSQL(filePath);
            expect(result.warnings.filter((warning) => warning.unanalyzable)).toHaveLength(0);
            expect(result.sql).toContain('CREATE INDEX "idx_users_name" ON "users" ("last_name", "first_name")');
            expect(result.sql).toContain('ALTER TABLE "users" ADD CONSTRAINT "users_email_unique" UNIQUE ("email")');
            expect(result.sql).toContain('ALTER TABLE "users" ADD CONSTRAINT "users_tenant_id_pkey" PRIMARY KEY ("tenant_id", "id")');
            expect(result.sql).toContain('ALTER TABLE "users" ADD CONSTRAINT "users_account_id_foreign" FOREIGN KEY ("account_id") REFERENCES "accounts" ("id") ON DELETE CASCADE');
            expect(result.sql).toContain('DROP INDEX "users_legacy_code_index"');
            expect(result.sql).toContain('ALTER TABLE "users" DROP CONSTRAINT "users_old_account_id_foreign"');
        });
    });

    it('should fail closed for unresolved standalone Knex table operations', async () => {
        await withTempFile('pgfence-knex-dynamic-table-op-', '.js', `exports.up = async function(knex) {
  const columns = ['email'];
  await knex.schema.alterTable('users', function(table) {
    table.unique(columns);
  });
};`, async (filePath) => {
            const result = await extractKnexSQL(filePath);
            expect(result.warnings.some((warning) => warning.unanalyzable)).toBe(true);
            expect(result.sql).not.toContain('UNIQUE');
        });
    });

    it('should fail closed for Knex table index predicates', async () => {
        await withTempFile('pgfence-knex-table-predicate-', '.js', `exports.up = async function(knex) {
  await knex.schema.alterTable('users', function(table) {
    table.index(['email'], 'idx_users_email_active', { predicate: knex.whereNotNull('email') });
    table.unique(['slug'], { indexName: 'uq_users_slug_active', predicate: knex.whereNotNull('slug') });
  });
};`, async (filePath) => {
            const result = await extractKnexSQL(filePath);
            expect(result.warnings.filter((warning) => warning.unanalyzable)).toHaveLength(2);
            expect(result.sql).not.toContain('idx_users_email_active');
            expect(result.sql).not.toContain('uq_users_slug_active');
        });
    });

    it('should fail closed for dynamic Knex table index option values', async () => {
        await withTempFile('pgfence-knex-dynamic-table-option-', '.js', `exports.up = async function(knex) {
  const indexName = 'idx_users_email';
  await knex.schema.alterTable('users', function(table) {
    table.index(['email'], indexName);
    table.unique(['slug'], { indexName });
  });
};`, async (filePath) => {
            const result = await extractKnexSQL(filePath);
            expect(result.warnings.filter((warning) => warning.unanalyzable)).toHaveLength(2);
            expect(result.sql).not.toContain('CREATE INDEX');
            expect(result.sql).not.toContain('UNIQUE');
        });
    });

    it('should handle standalone Knex table.foreign references().inTable()', async () => {
        await withTempFile('pgfence-knex-table-foreign-intable-', '.js', `exports.up = async function(knex) {
  await knex.schema.table('orders', function(table) {
    table.foreign(['tenant_id', 'user_id'], 'orders_user_fk')
      .references(['tenant_id', 'id'])
      .inTable('users')
      .onUpdate('CASCADE');
  });
};`, async (filePath) => {
            const result = await extractKnexSQL(filePath);
            expect(result.warnings.filter((warning) => warning.unanalyzable)).toHaveLength(0);
            expect(result.sql).toContain('ALTER TABLE "orders" ADD CONSTRAINT "orders_user_fk" FOREIGN KEY ("tenant_id", "user_id") REFERENCES "users" ("tenant_id", "id") ON UPDATE CASCADE');
        });
    });

    it('should not truncate a multi-word DEFAULT on .alter()', async () => {
        const filePath = path.join(fixturesDir, 'knex-alter-default.ts');
        const result = await extractKnexSQL(filePath);
        // The full quoted default survives (no truncation at the first space).
        expect(result.sql).toContain(`SET DEFAULT 'it is pending'`);
        expect(result.sql).toContain('SET NOT NULL');
        // And the emitted SQL is valid (parses cleanly, no unterminated literal).
        const stmts = await parseSQL(result.sql);
        expect(stmts.length).toBeGreaterThan(0);
    });

    it('should fail closed on .alter() of an auto-increment column instead of emitting invalid serial TYPE', async () => {
        await withTempFile('pgfence-knex-incr-alter-', '.ts', `import type { Knex } from 'knex';
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('users', (t) => {
    t.increments('id').alter();
  });
}`, async (filePath) => {
            const result = await extractKnexSQL(filePath);
            const warning = result.warnings.find((w) => w.unanalyzable);
            expect(warning).toBeDefined();
            expect(warning?.line).toBeGreaterThan(0);
            expect(result.sql).not.toContain('TYPE serial');
        });
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

    it('should fail closed on a CHECK constraint instead of emitting invalid SQL that poisons the batch', async () => {
        const filePath = path.join(fixturesDir, 'sequelize-check-constraint.js');
        const result = await extractSequelizeSQL(filePath);
        // The unresolvable CHECK is surfaced as unanalyzable, not emitted as SQL.
        expect(result.warnings.some((w) => w.unanalyzable)).toBe(true);
        expect(result.sql).not.toContain('CHECK');
        // The co-located dangerous statement is still extracted and parseable.
        expect(result.sql).toContain('DROP TABLE');
        expect(result.sql).toContain('"legacy_orders"');
        const stmts = await parseSQL(result.sql);
        expect(stmts.some((s) => s.nodeType === 'DropStmt')).toBe(true);
    });

    it('should fail closed for computed Sequelize createTable column keys', async () => {
        await withTempFile('pgfence-sequelize-computed-key-', '.js', `module.exports = {
  async up(queryInterface, Sequelize) {
    const col = 'runtime_name';
    await queryInterface.createTable('orders', {
      [col]: { type: Sequelize.INTEGER, allowNull: false },
    });
  },
};`, async (filePath) => {
            const result = await extractSequelizeSQL(filePath);
            expect(result.warnings.some((warning) => warning.unanalyzable)).toBe(true);
            expect(result.sql).not.toContain('"col" integer NOT NULL');
            expect(result.sql).not.toContain('CREATE TABLE');
        });
    });

    it('should detect builder calls when the up() parameter is aliased (not named queryInterface)', async () => {
        await withTempFile('pgfence-sequelize-alias-', '.js', `'use strict';
module.exports = {
  up: async (qi) => {
    await qi.dropTable('users');
  },
  down: async () => {},
};`, async (filePath) => {
            const result = await extractSequelizeSQL(filePath);
            expect(result.sql).toContain('DROP TABLE');
            expect(result.sql).toContain('"users"');
        });
    });

    it('should emit SET NOT NULL / SET DEFAULT from changeColumn, not only a phantom TYPE rewrite', async () => {
        await withTempFile('pgfence-sequelize-change-', '.js', `'use strict';
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.changeColumn('users', 'status', { type: Sequelize.STRING(500), allowNull: false });
    await queryInterface.changeColumn('users', 'kind', { type: Sequelize.STRING, defaultValue: 'pending' });
  },
  async down() {},
};`, async (filePath) => {
            const result = await extractSequelizeSQL(filePath);
            expect(result.sql).toContain('ALTER COLUMN "status" SET NOT NULL');
            expect(result.sql).toContain(`ALTER COLUMN "kind" SET DEFAULT 'pending'`);
            const stmts = await parseSQL(result.sql);
            expect(stmts.length).toBeGreaterThanOrEqual(3);
        });
    });
});

describe('Extractor: Kysely', () => {
    it('should transpile a createTable schema builder chain to SQL', async () => {
        const filePath = path.join(fixturesDir, 'kysely-create-table.ts');
        const result = await extractKyselySQL(filePath);
        expect(result.warnings).toHaveLength(0);
        expect(result.sql).toContain('CREATE TABLE "pet"');
        expect(result.sql).toContain('"id" serial PRIMARY KEY');
        expect(result.sql).toContain('REFERENCES "person"("id") ON DELETE CASCADE');
        const stmts = await parseSQL(result.sql);
        expect(stmts.length).toBeGreaterThan(0);
    });

    it('should transpile an alterTable addColumn call to SQL', async () => {
        const filePath = path.join(fixturesDir, 'kysely-alter-table.ts');
        const result = await extractKyselySQL(filePath);
        expect(result.warnings).toHaveLength(0);
        expect(result.sql).toContain('ALTER TABLE "person" ADD COLUMN "age" integer');
        expect(result.sql).not.toContain('DROP COLUMN'); // should skip down()
    });

    it('should extract a literal sql tagged-template statement', async () => {
        const filePath = path.join(fixturesDir, 'kysely-raw-sql.ts');
        const result = await extractKyselySQL(filePath);
        expect(result.warnings).toHaveLength(0);
        expect(result.sql).toContain('CREATE INDEX CONCURRENTLY idx_person_email ON person(email)');
        expect(result.sql).not.toContain('DROP INDEX'); // should skip down()
    });

    it('should warn on interpolated sql`` templates instead of silently skipping them', async () => {
        const filePath = path.join(fixturesDir, 'kysely-dynamic.ts');
        const result = await extractKyselySQL(filePath);
        expect(result.warnings.length).toBeGreaterThan(0);
        expect(result.warnings[0].message).toContain('Dynamic SQL');
        expect(result.warnings[0].unanalyzable).toBe(true);
        // The dynamic statement must not be silently treated as fully analyzed SQL.
        expect(result.sql).not.toContain('legacy_flag');
    });

    it('should warn if no up() function is found', async () => {
        const filePath = path.join(fixturesDir, 'kysely-no-up.ts');
        const result = await extractKyselySQL(filePath);
        expect(result.warnings).toHaveLength(1);
        expect(result.warnings[0].message).toContain('No up() function found');
        expect(result.warnings[0].unanalyzable).toBe(true);
    });

    it('should transpile alterColumn, dropColumn, renameColumn, and constraint chains', async () => {
        await withTempFile('pgfence-kysely-alter-ops-', '.ts', `import type { Kysely } from 'kysely';
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable('person')
    .alterColumn('age', (ac) => ac.setDataType('bigint'))
    .execute();
  await db.schema.alterTable('person')
    .dropColumn('legacy_flag')
    .renameColumn('first_name', 'given_name')
    .execute();
  await db.schema.alterTable('person')
    .addUniqueConstraint('person_email_uq', ['email'])
    .execute();
}`, async (filePath) => {
            const result = await extractKyselySQL(filePath);
            expect(result.warnings).toHaveLength(0);
            expect(result.sql).toContain('ALTER TABLE "person" ALTER COLUMN "age" TYPE bigint');
            expect(result.sql).toContain('ALTER TABLE "person" DROP COLUMN "legacy_flag"');
            expect(result.sql).toContain('ALTER TABLE "person" RENAME COLUMN "first_name" TO "given_name"');
            expect(result.sql).toContain('ALTER TABLE "person" ADD CONSTRAINT "person_email_uq" UNIQUE ("email")');
            const stmts = await parseSQL(result.sql);
            expect(stmts.length).toBe(4);
        });
    });

    it('should transpile alterTable addForeignKeyConstraint with chained onDelete/onUpdate (the idiomatic form, distinct from createTable\'s callback form)', async () => {
        await withTempFile('pgfence-kysely-alter-fk-', '.ts', `import type { Kysely } from 'kysely';
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable('pet')
    .addForeignKeyConstraint('owner_id_fk', ['owner_id'], 'person', ['id'])
    .onDelete('cascade')
    .execute();
}`, async (filePath) => {
            const result = await extractKyselySQL(filePath);
            expect(result.warnings).toHaveLength(0);
            expect(result.sql).toContain(
                'ALTER TABLE "pet" ADD CONSTRAINT "owner_id_fk" FOREIGN KEY ("owner_id") REFERENCES "person" ("id") ON DELETE CASCADE',
            );
            const stmts = await parseSQL(result.sql);
            expect(stmts.length).toBe(1);
        });
    });

    it('should fail closed on an unrecognized chained foreign key builder method rather than dropping the constraint entirely', async () => {
        await withTempFile('pgfence-kysely-alter-fk-bad-', '.ts', `import type { Kysely } from 'kysely';
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable('pet')
    .addForeignKeyConstraint('owner_id_fk', ['owner_id'], 'person', ['id'])
    .deferrable()
    .execute();
}`, async (filePath) => {
            const result = await extractKyselySQL(filePath);
            expect(result.warnings.some((w) => w.unanalyzable)).toBe(true);
            expect(result.sql).not.toContain('FOREIGN KEY');
        });
    });

    it('should transpile addUniqueConstraint\'s NULLS NOT DISTINCT builder callback instead of silently dropping it', async () => {
        await withTempFile('pgfence-kysely-unique-nnd-', '.ts', `import type { Kysely } from 'kysely';
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable('person')
    .addUniqueConstraint('person_email_uq', ['email'], (cb) => cb.nullsNotDistinct())
    .execute();
}`, async (filePath) => {
            const result = await extractKyselySQL(filePath);
            expect(result.warnings).toHaveLength(0);
            expect(result.sql).toContain('ADD CONSTRAINT "person_email_uq" UNIQUE NULLS NOT DISTINCT ("email")');
        });
    });

    it('should transpile addPrimaryKeyConstraint\'s deferrable builder callback instead of silently dropping it', async () => {
        await withTempFile('pgfence-kysely-pk-deferrable-', '.ts', `import type { Kysely } from 'kysely';
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable('person')
    .addPrimaryKeyConstraint('person_pk', ['id'], (cb) => cb.deferrable().initiallyDeferred())
    .execute();
}`, async (filePath) => {
            const result = await extractKyselySQL(filePath);
            expect(result.warnings).toHaveLength(0);
            expect(result.sql).toContain('ADD CONSTRAINT "person_pk" PRIMARY KEY ("id") DEFERRABLE INITIALLY DEFERRED');
        });
    });

    it('should fail closed on nullsNotDistinct() used on a PRIMARY KEY (not a real Kysely/Postgres option)', async () => {
        await withTempFile('pgfence-kysely-pk-nnd-', '.ts', `import type { Kysely } from 'kysely';
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable('person')
    .addPrimaryKeyConstraint('person_pk', ['id'], (cb) => cb.nullsNotDistinct())
    .execute();
}`, async (filePath) => {
            const result = await extractKyselySQL(filePath);
            expect(result.warnings.some((w) => w.unanalyzable)).toBe(true);
            expect(result.sql).not.toContain('PRIMARY KEY');
        });
    });

    it('should fail closed on modifyColumn instead of inventing Postgres semantics Kysely does not implement there', async () => {
        await withTempFile('pgfence-kysely-modify-column-', '.ts', `import type { Kysely } from 'kysely';
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable('person')
    .modifyColumn('age', 'bigint')
    .execute();
}`, async (filePath) => {
            const result = await extractKyselySQL(filePath);
            expect(result.warnings.some((w) => w.unanalyzable)).toBe(true);
            expect(result.warnings.some((w) => w.message.includes('modifyColumn'))).toBe(true);
            expect(result.sql).not.toContain('ALTER COLUMN');
        });
    });

    it('should transpile createIndex and dropIndex chains', async () => {
        await withTempFile('pgfence-kysely-index-', '.ts', `import type { Kysely } from 'kysely';
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema.createIndex('idx_person_email').on('person').column('email').unique().ifNotExists().execute();
  await db.schema.dropIndex('idx_old_email').ifExists().execute();
}`, async (filePath) => {
            const result = await extractKyselySQL(filePath);
            expect(result.warnings).toHaveLength(0);
            expect(result.sql).toContain('CREATE UNIQUE INDEX IF NOT EXISTS "idx_person_email" ON "person" ("email")');
            expect(result.sql).toContain('DROP INDEX IF EXISTS "idx_old_email"');
        });
    });

    it('should fail closed for a dynamic table name instead of emitting a guessed statement', async () => {
        await withTempFile('pgfence-kysely-dynamic-table-', '.ts', `import type { Kysely } from 'kysely';
export async function up(db: Kysely<any>): Promise<void> {
  const tbl = getTableName();
  await db.schema.dropTable(tbl).execute();
}`, async (filePath) => {
            const result = await extractKyselySQL(filePath);
            expect(result.warnings.some((w) => w.unanalyzable)).toBe(true);
            expect(result.sql).not.toContain('DROP TABLE');
        });
    });

    it('should fail closed on an unsupported column builder method rather than emitting a partial column', async () => {
        await withTempFile('pgfence-kysely-unsupported-column-', '.ts', `import type { Kysely } from 'kysely';
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema.createTable('widgets')
    .addColumn('id', 'serial', (col) => col.primaryKey())
    .addColumn('price', 'numeric', (col) => col.check(sql\`price > 0\`))
    .execute();
}`, async (filePath) => {
            const result = await extractKyselySQL(filePath);
            expect(result.warnings.some((w) => w.unanalyzable)).toBe(true);
            expect(result.sql).not.toContain('CREATE TABLE');
        });
    });

    it('should mark conditional raw SQL as unanalyzable for strict unknown handling', async () => {
        await withTempFile('pgfence-kysely-conditional-', '.ts', `import { sql, type Kysely } from 'kysely';
export async function up(db: Kysely<any>): Promise<void> {
  if (process.env.DROP_USERS) {
    await sql\`DROP TABLE users\`.execute(db);
  }
}`, async (filePath) => {
            const result = await extractKyselySQL(filePath);
            expect(result.sql).toContain('DROP TABLE users');
            expect(result.warnings.some((warning) => warning.unanalyzable)).toBe(true);
            expect(result.warnings.some((warning) => warning.message.includes('Conditional SQL'))).toBe(true);
        });
    });

    it('should recognize a schema variable aliased from db.schema', async () => {
        await withTempFile('pgfence-kysely-schema-alias-', '.ts', `import type { Kysely } from 'kysely';
export async function up(db: Kysely<any>): Promise<void> {
  const schema = db.schema;
  await schema.dropTable('legacy_table').execute();
}`, async (filePath) => {
            const result = await extractKyselySQL(filePath);
            expect(result.warnings).toHaveLength(0);
            expect(result.sql).toContain('DROP TABLE "legacy_table"');
        });
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

describe('Extractor: Sequelize unresolved column types', () => {
    it('should fail closed for unsupported addColumn column types', async () => {
        await withTempFile('pgfence-sequelize-unsupported-add-column-', '.js', `module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('users', 'shape', {
      type: Sequelize.GEOMETRY,
      allowNull: false,
    });
  }
};`, async (filePath) => {
            const result = await extractSequelizeSQL(filePath);
            expect(result.sql).toBe('');
            expect(result.warnings.some((warning) => warning.unanalyzable)).toBe(true);
            expect(result.warnings[0].message).toContain('Could not resolve Sequelize column type');
        });
    });

    it('should fail closed instead of emitting partial createTable SQL', async () => {
        await withTempFile('pgfence-sequelize-partial-create-table-', '.js', `module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('places', {
      id: { type: Sequelize.INTEGER, allowNull: false },
      shape: { type: Sequelize.GEOMETRY, allowNull: false },
    });
  }
};`, async (filePath) => {
            const result = await extractSequelizeSQL(filePath);
            expect(result.sql).toBe('');
            expect(result.warnings.some((warning) => warning.unanalyzable)).toBe(true);
        });
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
