import { MigrationInterface, QueryRunner, Table, TableColumn } from 'typeorm';

export class ExpandedBuilderMigration implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropTable('legacy_users');
    await queryRunner.clearTable('sessions');
    await queryRunner.renameTable('old_name', 'new_name');
    await queryRunner.createCheckConstraint('users', 'chk_age', 'age > 0');
    await queryRunner.createView('active_users', 'SELECT * FROM users WHERE active');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropView('active_users');
  }
}
