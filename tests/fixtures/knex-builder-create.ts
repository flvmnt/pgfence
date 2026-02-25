import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.raw(`SET lock_timeout = '2s'`);
  await knex.raw(`SET statement_timeout = '5min'`);

  await knex.schema.createTable('events', (t) => {
    t.bigIncrements('id');
    t.string('name', 100).notNullable();
    t.text('description');
    t.integer('priority').defaultTo(0);
    t.boolean('active').notNullable().defaultTo(true);
    t.timestamp('created_at').notNullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTable('events');
}
