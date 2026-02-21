export async function up(knex: any): Promise<void> {
    const table = 'users';
    await knex.raw(`ALTER TABLE ${table} ADD COLUMN age INT`);
}

export async function down(knex: any): Promise<void> {
}
