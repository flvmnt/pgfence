import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('orders', (t) => {
    t.integer('user_id').notNullable().references('id');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTable('orders');
}
