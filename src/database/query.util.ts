import type { DataSource, EntityManager, QueryResult } from 'typeorm';

/**
 * Runs raw SQL and always returns `{ records, affected }`.
 *
 * Plain `dataSource.query()` changes shape with the statement: rows for
 * SELECT and INSERT, but `[rows, rowCount]` for UPDATE and DELETE, so
 * `UPDATE ... RETURNING` silently yields a nested array. Every repository
 * query that reads rows back from a data-changing statement goes through here.
 *
 * Pass `manager` to run inside that manager's transaction.
 */
export const runQuery = async <T = unknown>(
  dataSource: DataSource,
  sql: string,
  parameters: unknown[],
  manager?: EntityManager,
): Promise<QueryResult<T>> => {
  if (manager?.queryRunner) {
    return (await manager.queryRunner.query(sql, parameters, true)) as QueryResult<T>;
  }
  const queryRunner = dataSource.createQueryRunner();
  try {
    return (await queryRunner.query(sql, parameters, true)) as QueryResult<T>;
  } finally {
    await queryRunner.release();
  }
};
