'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.sequelize.query(`SET lock_timeout = '2s'`);
    await queryInterface.sequelize.query(`SET statement_timeout = '5min'`);

    await queryInterface.createTable('events', {
      id: {
        type: Sequelize.DataTypes.BIGINT,
        primaryKey: true,
        autoIncrement: true,
      },
      name: {
        type: Sequelize.DataTypes.STRING(100),
        allowNull: false,
      },
      description: Sequelize.DataTypes.TEXT,
      priority: {
        type: Sequelize.DataTypes.INTEGER,
        defaultValue: 0,
      },
      active: {
        type: Sequelize.DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: true,
      },
    });

    await queryInterface.addIndex('events', ['name']);
  },

  async down(queryInterface) {
    await queryInterface.dropTable('events');
  },
};
