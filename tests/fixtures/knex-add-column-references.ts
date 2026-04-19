import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('orders', (t) => {
    t.integer('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('orders', (t) => {
    t.dropColumn('user_id');
  });
}
