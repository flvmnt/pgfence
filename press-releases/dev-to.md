# Dev.to / Hashnode Article

**Title:** How we stopped ORM migrations from taking down our Postgres database

**Tags:** #postgres #databases #typescript #opensource #devops

If you've ever run a database migration that applied a seemingly minor change, like `ALTER TABLE users ADD COLUMN is_verified BOOLEAN DEFAULT false`, only to watch your API response times spike and connection pools exhaust, you've met the Postgres `ACCESS EXCLUSIVE` lock.

Modern ORMs like TypeORM, Sequelize, Prisma, and Drizzle hide the underlying Postgres locking mechanics. When developers can't see the DDL statements their ORMs are running, they can't optimize them.

### The Lock Queue Death Spiral

Postgres requires strict locks for schema changes. When a migration runs an `ALTER TABLE` command, it normally requires an `ACCESS EXCLUSIVE` lock.
If there's currently a 30-second reporting query running on that table, the migration has to wait in line.

While the migration is waiting, *every other incoming production query* behind it is also forced to wait. Suddenly, your app is down.

### Introducing `pgfence`

To solve this, I built [pgfence](https://pgfence.com), a source-available TypeScript CLI designed specifically for the Node.js ecosystem. It's the first tool in this space built natively for Node. The alternatives (strong_migrations, Eugene, Squawk) are Ruby or Rust, which creates real friction if your stack is TypeScript.

Unlike other linters, `pgfence` parses the Abstract Syntax Trees (ASTs) of your ORM's migration files (supporting `.ts` files from TypeORM, Knex, Sequelize, and Prisma). It statically extracts the SQL and evaluates the risk before you ever merge to main.

#### 1. Predicting Lock Modes
`pgfence` matches every DDL command to the Postgres lock matrix. It prints out exactly what locks are being grabbed and whether they will block **Reads**, **Writes**, or both.

#### 2. Enforcing Timeout Policies
If you don't explicitly declare `SET lock_timeout = '2s'` inside a migration, a stuck migration will bring down your app. `pgfence` scans your migrations and fails CI if timeouts are omitted.

#### 3. Giving you the fix
`pgfence` provides "Safe Rewrite Recipes." If you try to add a column with a volatile default, it gives you the exact 3-step zero-downtime expand/contract migration to use instead.

### Try it out

You can integrate `pgfence` into your GitHub Actions today. It's free and open-source.

```bash
npx @flvmnt/pgfence analyze migrations/*.sql
```

Website: [pgfence.com](https://pgfence.com)
GitHub: [flvmnt/pgfence](https://github.com/flvmnt/pgfence)
