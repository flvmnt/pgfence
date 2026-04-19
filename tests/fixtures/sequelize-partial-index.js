'use strict';

module.exports = {
  async up(queryInterface) {
    await queryInterface.addIndex('users', ['email'], {
      name: 'idx_users_email_active',
      where: { deletedAt: null },
    });
  },

  async down(queryInterface) {
    await queryInterface.removeIndex('users', 'idx_users_email_active');
  },
};
