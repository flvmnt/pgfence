'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    const refTable = process.env.USER_TABLE;
    await queryInterface.addColumn('orders', 'user_id', {
      type: Sequelize.DataTypes.INTEGER,
      references: { model: refTable, key: 'id' },
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('orders', 'user_id');
  },
};
