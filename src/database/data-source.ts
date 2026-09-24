import { join } from 'node:path';
import { DataSource } from 'typeorm';
import { configuration } from '../config/configuration.js';
import { buildDataSourceOptions } from './database.config.js';

/**
 * Entry point for the TypeORM CLI (`npm run migration:*`), loaded from the
 * compiled `dist/` output. Uses the same validated configuration as the app.
 */
export default new DataSource({
  ...buildDataSourceOptions(configuration().database),
  entities: [join(import.meta.dirname, '..', '**', '*.entity.js')],
});
