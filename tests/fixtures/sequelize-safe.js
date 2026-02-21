module.exports = {
    up: async (queryInterface, Sequelize) => {
        await queryInterface.sequelize.query('CREATE INDEX idx_users_email ON users(email);');
    },
    down: async (queryInterface, Sequelize) => {
        await queryInterface.sequelize.query('DROP INDEX idx_users_email;');
    }
};
