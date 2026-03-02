'use strict';

module.exports = {
  async up(queryInterface) {
    await queryInterface.addIndex('users', ['email'], {
      unique: true,
      concurrently: true,
      name: 'idx_users_email_unique',
    });
  },

  async down(queryInterface) {
    await queryInterface.removeIndex('users', 'idx_users_email_unique');
  },
};
