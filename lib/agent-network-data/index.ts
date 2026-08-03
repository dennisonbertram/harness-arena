import { createHash } from "node:crypto";

type JsonPrimitive = boolean | null | number | string;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

type OperationInput = {
  actorId: string;
  operation: string;
  competitionId: string;
  idempotencyKey: string;
  request: JsonValue;
};

type OperationExecution<Response> = {
  operationId: string;
  entityId: string;
  response: Response;
  replayed: boolean;
};

type StoredOperation = {
  requestHash: string;
  operationId: string;
  entityId: string;
  completed: boolean;
  response?: unknown;
};

type OutboxState = "pending" | "processing" | "delivered";

type OutboxRecord = {
  id: string;
  operationId: string;
  state: OutboxState;
  attempts: number;
  claimedAt?: string;
  deliveredAt?: string;
};

type AuditRecord = {
  actorId: string;
  action: string;
  entityId: string;
  occurredAt: string;
};

function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("canonical request JSON cannot contain non-finite numbers");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;

  const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`).join(",")}}`;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function operationScope(input: Omit<OperationInput, "request">): string {
  return canonicalJson({
    actorId: input.actorId,
    competitionId: input.competitionId,
    idempotencyKey: input.idempotencyKey,
    operation: input.operation,
  });
}

function deepFreeze<Value>(value: Value): Value {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function cloneAndFreeze<Value>(value: Value): Value {
  return deepFreeze(structuredClone(value));
}

/** A SHA-256 hash over a recursively key-sorted JSON request body. */
export async function hashCanonicalRequest(request: JsonValue): Promise<string> {
  return digest(canonicalJson(request));
}

/**
 * The public entity reservation is deliberately derived from the idempotency
 * scope, not random state, so a retry can refer to precisely one entity.
 */
export async function reservedEntityId(input: OperationInput): Promise<string> {
  return `entity_${digest(operationScope(input))}`;
}

export class IdempotencyConflictError extends Error {
  readonly code = "IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_REQUEST" as const;

  constructor() {
    super("idempotency key was already used with a different request");
  }
}

export function createInMemoryAgentNetworkData() {
  const operations = new Map<string, StoredOperation>();
  const inFlight = new Map<string, Promise<OperationExecution<unknown>>>();
  const outbox = new Map<string, OutboxRecord>();
  const auditRows: AuditRecord[] = [];

  function outboxView(record: OutboxRecord): OutboxRecord {
    return cloneAndFreeze(record);
  }

  return {
    async execute<Response>(input: OperationInput, mutate: () => Promise<Response>): Promise<OperationExecution<Response>> {
      const scope = operationScope(input);
      const requestHash = await hashCanonicalRequest(input.request);
      const existing = operations.get(scope);

      if (existing) {
        if (existing.requestHash !== requestHash) throw new IdempotencyConflictError();
        if (existing.completed) {
          return {
            operationId: existing.operationId,
            entityId: existing.entityId,
            response: cloneAndFreeze(existing.response as Response),
            replayed: true,
          };
        }
      }

      const pending = inFlight.get(scope);
      if (pending) {
        const completed = await pending;
        return { ...completed, response: cloneAndFreeze(completed.response as Response), replayed: true };
      }

      const operationId = `operation_${digest(scope)}`;
      const entityId = `entity_${digest(scope)}`;
      const outboxId = `outbox_${digest(scope)}`;
      // These two inserts happen synchronously before the mutation starts: no
      // observer can see a reserved operation without its recoverable outbox row.
      operations.set(scope, { requestHash, operationId, entityId, completed: false });
      outbox.set(outboxId, { id: outboxId, operationId, state: "pending", attempts: 0 });

      let resolveWork!: (value: OperationExecution<Response>) => void;
      let rejectWork!: (reason?: unknown) => void;
      const work = new Promise<OperationExecution<Response>>((resolve, reject) => {
        resolveWork = resolve;
        rejectWork = reject;
      });
      // Register the promise before invoking caller code, including a mutate
      // callback that synchronously starts a nested retry.
      inFlight.set(scope, work as Promise<OperationExecution<unknown>>);
      void (async () => {
        try {
          const response = cloneAndFreeze(await mutate());
          const stored = operations.get(scope);
          if (!stored) throw new Error("operation reservation disappeared");
          stored.response = response;
          stored.completed = true;
          resolveWork({ operationId, entityId, response: cloneAndFreeze(response), replayed: false });
        } catch (error) {
          // A failed mutation is not a completed protected operation. Roll back
          // both in-memory inserts together so a later retry may execute once.
          operations.delete(scope);
          outbox.delete(outboxId);
          rejectWork(error);
        } finally {
          inFlight.delete(scope);
        }
      })();
      return work;
    },

    outbox: {
      async list(filter: { operationId: string }): Promise<OutboxRecord[]> {
        return [...outbox.values()]
          .filter((record) => record.operationId === filter.operationId)
          .sort((left, right) => left.id.localeCompare(right.id))
          .map(outboxView);
      },

      async claimNext({ now }: { now: Date }): Promise<OutboxRecord | undefined> {
        const next = [...outbox.values()]
          .filter((record) => record.state === "pending")
          .sort((left, right) => left.id.localeCompare(right.id))[0];
        if (!next) return undefined;
        next.state = "processing";
        next.attempts += 1;
        next.claimedAt = now.toISOString();
        return outboxView(next);
      },

      async recoverStale({ now, olderThanMs }: { now: Date; olderThanMs: number }): Promise<void> {
        const staleBefore = now.getTime() - olderThanMs;
        for (const record of outbox.values()) {
          if (record.state === "processing" && record.claimedAt && Date.parse(record.claimedAt) <= staleBefore) {
            record.state = "pending";
            delete record.claimedAt;
          }
        }
      },

      async markDelivered(id: string, { now }: { now: Date }): Promise<void> {
        const record = outbox.get(id);
        if (!record) throw new Error(`outbox record not found: ${id}`);
        if (record.state !== "processing") throw new Error(`outbox record is not processing: ${id}`);
        record.state = "delivered";
        record.deliveredAt = now.toISOString();
      },
    },

    audit: {
      async append(record: AuditRecord): Promise<void> {
        auditRows.push(cloneAndFreeze(record));
      },

      async list(filter: { entityId: string }): Promise<AuditRecord[]> {
        return auditRows.filter((record) => record.entityId === filter.entityId).map(cloneAndFreeze);
      },
    },
  };
}
