'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addConstraint('users', {
      fields: ['email'],
      type: 'unique',
      name: 'uq_users_email',
    });
    await queryInterface.addConstraint('orders', {
      fields: ['user_id'],
      type: 'foreign key',
      name: 'fk_orders_user',
      references: { table: 'users', field: 'id' },
    });
  },

  async down(queryInterface) {
    await queryInterface.removeConstraint('users', 'uq_users_email');
    await queryInterface.removeConstraint('orders', 'fk_orders_user');
  },
};
