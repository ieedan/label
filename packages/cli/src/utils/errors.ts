import { LabelError } from '@ieedan/label-core';
import type { z } from 'zod';

export type CLIError = LabelError | InvalidOptionsError | InvalidJSONError | ZodError;

export class InvalidOptionsError extends LabelError {
	constructor(error: z.ZodError) {
		super(
			`Invalid options: ${error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join(', ')}`,
			{
				suggestion: 'Please check the options and try again.',
			}
		);
	}
}

export class ZodError extends LabelError {
	readonly zodError: z.ZodError;
	constructor(error: z.ZodError) {
		super(`Zod error: ${error.message}`, {
			suggestion: 'Check the input schema and try again.',
		});
		this.zodError = error;
	}
}

export class InvalidJSONError extends LabelError {
	constructor(error: unknown) {
		super(
			`Invalid JSON: ${error instanceof Error ? (error.stack ?? error.message) : `${error}`}`,
			{
				suggestion: 'Check the input JSON and try again.',
			}
		);
	}
}
