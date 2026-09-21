import { existsSync } from 'node:fs';
import path from 'pathe';

export function loadEnv(cwd: string): void {
	let dir = cwd;

	while (true) {
		const envPath = path.join(dir, '.env');
		if (existsSync(envPath)) {
			process.loadEnvFile(envPath);
			return;
		}

		const parent = path.dirname(dir);
		if (parent === dir) return;
		dir = parent;
	}
}
