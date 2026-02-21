module.exports = {
    up: async (queryInterface, Sequelize) => {
        const tableName = 'users';
        await queryInterface.sequelize.query(`CREATE INDEX idx_users_email ON ${tableName}(email);`);
    }
};
