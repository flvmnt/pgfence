import type { Kysely } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
    await db.schema
        .alterTable('person')
        .addColumn('age', 'integer')
        .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
    await db.schema.alterTable('person').dropColumn('age').execute();
}
