import type { Kysely } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
    await db.schema
        .createTable('pet')
        .addColumn('id', 'serial', (col) => col.primaryKey())
        .addColumn('name', 'varchar', (col) => col.notNull())
        .addColumn('owner_id', 'integer', (col) => col.references('person.id').onDelete('cascade').notNull())
        .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
    await db.schema.dropTable('pet').execute();
}
