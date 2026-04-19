import { Knex } from 'knex';

export const config = { transaction: false };

export async function up(knex: Knex): Promise<void> {
  await knex.raw('CREATE INDEX CONCURRENTLY idx_users_email ON users (email)');
}

export async function down(knex: Knex): Promise<void> {}
