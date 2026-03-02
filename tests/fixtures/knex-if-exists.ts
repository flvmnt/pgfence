import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTableIfNotExists('temp_data', (t) => {
    t.increments('id');
    t.text('payload');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('temp_data');
}
