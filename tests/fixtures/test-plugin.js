/**
 * Test plugin — requires every CREATE TABLE to have a primary key.
 */
module.exports = {
  name: 'test-require-pk',
  rules: [
    {
      ruleId: 'plugin:require-primary-key',
      check(stmt) {
        const results = [];
        if (stmt.nodeType === 'CreateStmt') {
          const node = stmt.node;
          const tableName = node.relation?.relname ?? 'unknown';

          // Check if any column or table constraint defines a primary key
          const tableElts = node.tableElts ?? [];
          let hasPK = false;
          for (const elt of tableElts) {
            if (elt.Constraint?.contype === 'CONSTR_PRIMARY') {
              hasPK = true;
              break;
            }
            // Column-level constraint
            const colConstraints = elt.ColumnDef?.constraints ?? [];
            for (const c of colConstraints) {
              if (c.Constraint?.contype === 'CONSTR_PRIMARY') {
                hasPK = true;
                break;
              }
            }
            if (hasPK) break;
          }

          if (!hasPK) {
            results.push({
              statement: stmt.sql,
              statementPreview: stmt.sql.slice(0, 80),
              tableName,
              lockMode: 'ACCESS EXCLUSIVE',
              blocks: { reads: true, writes: true, otherDdl: true },
              risk: 'LOW',
              message: `Table "${tableName}" does not define a PRIMARY KEY — every table should have a primary key`,
              ruleId: 'plugin:require-primary-key',
            });
          }
        }
        return results;
      },
    },
  ],
};
