export async function up(knex: any): Promise<void> {
    await knex.schema.alterTable('users', (t: any) => {
        t.integer('age');
    });
}

export async function down(knex: any): Promise<void> {
}
