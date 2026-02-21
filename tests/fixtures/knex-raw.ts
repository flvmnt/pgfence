export async function up(knex: any): Promise<void> {
    await knex.raw('ALTER TABLE users ADD COLUMN age INT');
    await knex.raw(`CREATE INDEX idx_age ON users(age)`);
}

export async function down(knex: any): Promise<void> {
}
