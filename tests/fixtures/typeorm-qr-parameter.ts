import { MigrationInterface, QueryRunner } from 'typeorm';

export class TestMigration1234567890 implements MigrationInterface {
  async up(qr: QueryRunner): Promise<void> {
    await qr.query(`SET lock_timeout = '2s'`);
    await qr.query(`SET statement_timeout = '5min'`);
    await qr.query(`ALTER TABLE users ADD COLUMN age integer`);
  }

  async down(qr: QueryRunner): Promise<void> {
    await qr.query(`ALTER TABLE users DROP COLUMN age`);
  }
}
