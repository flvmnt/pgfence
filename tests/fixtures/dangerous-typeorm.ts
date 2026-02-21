// Fixture: Dangerous TypeORM migration
// Expected: pgfence should extract SQL from queryRunner.query() and flag issues

import { MigrationInterface, QueryRunner } from 'typeorm';

export class DangerousExample1234567890 implements MigrationInterface {
  name = 'DangerousExample1234567890';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Missing lock_timeout — policy violation
    // Missing statement_timeout — policy violation

    // Dangerous: NOT NULL without DEFAULT
    await queryRunner.query(`
      ALTER TABLE appointments
      ADD COLUMN status VARCHAR(20) NOT NULL DEFAULT 'pending'
    `);

    // Dangerous: CREATE INDEX without CONCURRENTLY
    await queryRunner.query(`
      CREATE INDEX idx_appointments_status ON appointments(status)
    `);

    // Dangerous: backfill inside migration
    await queryRunner.query(`
      UPDATE appointments SET status = 'confirmed' WHERE confirmed = true
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Down methods are not analyzed (expected to be destructive)
    await queryRunner.query(`ALTER TABLE appointments DROP COLUMN status`);
    await queryRunner.query(`DROP INDEX idx_appointments_status`);
  }
}
