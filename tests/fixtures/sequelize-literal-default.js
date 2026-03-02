'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('users', 'created_at', {
      type: Sequelize.DataTypes.DATE,
      defaultValue: Sequelize.literal('NOW()'),
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('users', 'created_at');
  },
};
