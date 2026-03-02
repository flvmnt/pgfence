import { MigrationInterface, QueryRunner, Table, TableColumn } from 'typeorm';

export class BuilderMigration implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createTable(new Table({ name: 'users', columns: [] }));
    await queryRunner.addColumn('users', new TableColumn({ name: 'email', type: 'varchar' }));
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropColumn('users', 'email');
    await queryRunner.dropTable('users');
  }
}
