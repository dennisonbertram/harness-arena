export const RUNTIME_SECRET_ENVIRONMENT_NAMES: readonly string[];
export const POLICY_SECRET_ENVIRONMENT_NAMES: readonly string[];
export const SECRET_ENVIRONMENT_NAMES: readonly string[];
export function isGovernedSecretEnvironmentName(name: unknown): boolean;
export function secretEnvironmentRedactionValues(env: NodeJS.ProcessEnv, additionalNames?: Iterable<string>): string[];
