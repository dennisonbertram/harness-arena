export function normalizedKeyParts(key: unknown): string[];
export function isSensitiveCredentialKey(key: unknown): boolean;
export function configuredSecrets(env: NodeJS.ProcessEnv): string[];
export function sanitizeHttpUrls(value: unknown): string;
export function redactOpsText(value: unknown, secrets?: string[]): string;
export function redactOpsValue(value: unknown, secrets?: string[], key?: string): unknown;
