import { sql, type Kysely } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
    await sql`CREATE INDEX CONCURRENTLY idx_person_email ON person(email)`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
    await sql`DROP INDEX CONCURRENTLY idx_person_email`.execute(db);
}
