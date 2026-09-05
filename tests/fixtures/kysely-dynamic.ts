import { sql, type Kysely } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
    const columnName = 'legacy_flag';
    await sql`ALTER TABLE person ADD COLUMN ${sql.raw(columnName)} boolean`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
}
