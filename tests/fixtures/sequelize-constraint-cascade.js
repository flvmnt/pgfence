'use strict';

module.exports = {
  async up(queryInterface) {
    await queryInterface.addConstraint('orders', {
      fields: ['user_id'],
      type: 'foreign key',
      name: 'fk_orders_user',
      references: { table: 'users', field: 'id' },
      onDelete: 'cascade',
      onUpdate: 'set null',
    });
  },

  async down(queryInterface) {
    await queryInterface.removeConstraint('orders', 'fk_orders_user');
  },
};
