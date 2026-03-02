import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.table('users', (t) => {
    t.string('nickname');
  });
}

export async function down(knex: Knex): Promise<void> {}
