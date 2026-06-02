'use strict';

// A CHECK constraint whose predicate (the Sequelize `where` object) cannot be
// statically rendered to SQL, followed by a genuinely dangerous statement.
// pgfence must NOT emit invalid SQL for the CHECK (which would poison the
// whole-file parse and silently hide the DROP TABLE); it must fail closed on
// the CHECK and still analyze the DROP TABLE.
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addConstraint('orders', {
      fields: ['amount'],
      type: 'check',
      name: 'ck_orders_amount_positive',
      where: { amount: { [Sequelize.Op.gt]: 0 } },
    });
    await queryInterface.dropTable('legacy_orders');
  },

  async down(queryInterface) {
    await queryInterface.removeConstraint('orders', 'ck_orders_amount_positive');
  },
};
