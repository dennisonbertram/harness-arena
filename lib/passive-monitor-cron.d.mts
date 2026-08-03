export const DEVELOPMENT_PROJECT_ID: string;
export const DEVELOPMENT_ORIGIN: string;
export const PRODUCTION_ORIGIN: string;
export function createFixedProbeFetch(options?: Record<string, unknown>): typeof fetch;
export function executePassiveMonitorCron(options?: Record<string, unknown>): Promise<{
  status: number;
  body: Record<string, unknown>;
  events: Array<Record<string, unknown>>;
}>;
