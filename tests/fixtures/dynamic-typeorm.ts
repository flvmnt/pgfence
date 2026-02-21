export class DynamicMigration1612345678901 {
    public async up(queryRunner: any): Promise<void> {
        const tableName = 'users';
        await queryRunner.query(`ALTER TABLE ${tableName} ADD COLUMN age INT`);
    }

    public async down(queryRunner: any): Promise<void> {
    }
}
