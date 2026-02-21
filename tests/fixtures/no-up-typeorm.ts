export class NoUpMigration1612345678901 {
    public async down(queryRunner: any): Promise<void> {
        await queryRunner.query(`DROP TABLE users`);
    }
}
