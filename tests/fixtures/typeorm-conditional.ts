import { MigrationInterface, QueryRunner } from 'typeorm';

export class ConditionalMigration1234567890 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET lock_timeout = '2s'`);
    await queryRunner.query(`SET statement_timeout = '5min'`);

    // Unconditional query — should NOT trigger conditional warning
    await queryRunner.query(`ALTER TABLE users ADD COLUMN age INTEGER`);

    // Conditional query — should trigger warning
    const hasColumn = await queryRunner.query(`SELECT 1`);
    if (hasColumn) {
      await queryRunner.query(`CREATE INDEX idx_users_age ON users(age)`);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX idx_users_age`);
  }
}
