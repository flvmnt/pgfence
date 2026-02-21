export async function down(knex: any): Promise<void> {
    await knex.raw('DROP TABLE users');
}
