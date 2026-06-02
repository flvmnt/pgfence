import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('users', (t) => {
    // A DEFAULT value containing spaces must not be truncated.
    t.string('status').notNullable().defaultTo('it is pending').alter();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('users', (t) => {
    t.string('status').nullable().alter();
  });
}
