import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.raw(`SET lock_timeout = '2s'`);
  await knex.raw(`SET statement_timeout = '5min'`);

  // Unconditional query — should NOT trigger conditional warning
  await knex.raw(`ALTER TABLE users ADD COLUMN age INTEGER`);

  // Conditional query — should trigger warning
  const exists = await knex.raw(`SELECT 1`);
  if (exists) {
    await knex.raw(`CREATE INDEX idx_users_age ON users(age)`);
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`DROP INDEX idx_users_age`);
}
