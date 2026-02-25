import { MigrationInterface, QueryRunner } from 'typeorm';

export class TestMigration1234567891 implements MigrationInterface {
  public transaction = false;

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET lock_timeout = '2s'`);
    await queryRunner.query(`ALTER TABLE foo ADD CONSTRAINT fk_bar FOREIGN KEY (bar_id) REFERENCES bar(id)`);
    await queryRunner.query(`ALTER TABLE foo DROP CONSTRAINT old_constraint`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE foo ADD CONSTRAINT old_constraint CHECK (id > 0)`);
    await queryRunner.query(`ALTER TABLE foo DROP CONSTRAINT fk_bar`);
  }
}
