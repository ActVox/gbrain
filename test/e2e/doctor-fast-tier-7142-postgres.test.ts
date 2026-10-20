import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../doctor-fast-tier-7142.test.ts'));
