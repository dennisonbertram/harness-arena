// The models a run can execute on. Most route through the Vercel AI Gateway
// (one endpoint, one key); glm-5.2 is the default and the reference the
// leaderboard was built around. Poolside's Laguna routes through poolside's OWN
// inference endpoint (a pi custom provider) — the first non-gateway provider on
// the board. See PROVIDERS below.
export const DEFAULT_MODEL = "zai/glm-5.2";

export const MODEL_LABELS: Record<string, string> = {
  "zai/glm-5.2": "glm-5.2",
  "anthropic/claude-sonnet-5": "Claude Sonnet 5",
  "anthropic/claude-opus-4-8": "Claude Opus 4.8",
  "poolside/laguna-s-2.1": "Laguna S 2.1",
};

// One shared model->color map so the chart, per-task bars, and any per-model
// labels use the SAME color for a model everywhere. Chosen to be distinct on
// the dark UI and reasonably colorblind-distinguishable.
export const MODEL_COLORS: Record<string, string> = {
  "zai/glm-5.2": "#4f9bf5", // blue
  "anthropic/claude-sonnet-5": "#e8912a", // amber
  "anthropic/claude-opus-4-8": "#a06fe0", // violet
  "poolside/laguna-s-2.1": "#2bb0a0", // teal
};
const FALLBACK_MODEL_COLOR = "#9aa0a6"; // gray for any unknown/legacy id

export function modelColor(model: string | undefined): string {
  return MODEL_COLORS[runModel(model)] ?? FALLBACK_MODEL_COLOR;
}

/** Ordered list of supported models (default first) for selectors/legends. */
export function modelOptions(): { id: string; label: string; color: string }[] {
  return Object.keys(MODEL_LABELS).map((id) => ({ id, label: MODEL_LABELS[id], color: MODEL_COLORS[id] ?? FALLBACK_MODEL_COLOR }));
}

/** Gateway ids a submission is allowed to request. */
export const ALLOWED_MODELS = new Set(Object.keys(MODEL_LABELS));

export function isAllowedModel(id: string): boolean {
  return ALLOWED_MODELS.has(id);
}

/** A run/submission's model, defaulting legacy (absent) records to glm-5.2. */
export function runModel(model: string | undefined): string {
  return model ?? DEFAULT_MODEL;
}

export function modelLabel(model: string | undefined): string {
  const id = runModel(model);
  return MODEL_LABELS[id] ?? id;
}

// --- Providers ---------------------------------------------------------------
// A model declares which inference provider serves it. The runner configures pi
// per provider: gateway models use pi's built-in `vercel-ai-gateway` provider
// (one key), while a DIRECT provider (poolside) is registered as a pi custom
// provider pointing at its own endpoint. This is the multi-provider abstraction:
// adding a provider is a registry entry, not a code path.
export interface ProviderConfig {
  /** pi --provider name. */
  piProvider: string;
  /** Env var holding this provider's API key (forwarded into the sandbox). */
  apiKeyEnv: string;
  /** DIRECT (non-gateway) providers only: pi custom-provider settings. */
  direct?: {
    baseUrl: string; // pi custom-provider base URL (OpenAI-compatible)
    api: string; // pi streaming impl (e.g. "openai-completions")
    host: string; // hostname to add to the sandbox egress allowlist
  };
}

export const PROVIDERS: Record<string, ProviderConfig> = {
  gateway: { piProvider: "vercel-ai-gateway", apiKeyEnv: "AI_GATEWAY_API_KEY" },
  poolside: {
    piProvider: "poolside",
    apiKeyEnv: "POOLSIDE_API_KEY",
    direct: { baseUrl: "https://inference.poolside.ai/v1", api: "openai-completions", host: "inference.poolside.ai" },
  },
};

// Direct models need a full pi model spec (pi has no built-in catalog entry for
// them). Anything not listed here is a gateway model (pi knows its cost/context
// natively). cost is $/1M tokens — pi's unit — and drives the reported run cost.
interface DirectModel {
  provider: string; // key into PROVIDERS
  spec: {
    reasoning: boolean;
    cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
    contextWindow: number;
    maxTokens: number;
  };
}

const DIRECT_MODELS: Record<string, DirectModel> = {
  "poolside/laguna-s-2.1": {
    provider: "poolside",
    spec: {
      reasoning: true,
      // Laguna price from the Vercel AI Gateway model catalog ($/1M): input
      // $0.10, output $0.20, cache-read $0.01. The direct-poolside price may
      // differ slightly, but Laguna is ~100x cheaper than the Claude models
      // either way, so any gap is immaterial to the (cost-secondary) ranking.
      cost: { input: 0.1, output: 0.2, cacheRead: 0.01, cacheWrite: 0.1 },
      // Not a published poolside spec — conservative standard values. These only
      // affect pi's internal context management (when it compacts), not score or
      // reported cost.
      contextWindow: 256000,
      maxTokens: 32000,
    },
  },
};

/** The provider that serves a given model (defaults to the gateway). */
export function providerFor(model: string | undefined): ProviderConfig {
  const direct = DIRECT_MODELS[runModel(model)];
  return direct ? PROVIDERS[direct.provider] : PROVIDERS.gateway;
}

/**
 * The pi models.json (custom-provider config) a DIRECT model needs, as a JSON
 * string. Returns null for gateway models (pi configures them natively). The
 * runner writes this into the task container and loads it via PI_CODING_AGENT_DIR.
 */
export function piModelsConfig(model: string): string | null {
  const direct = DIRECT_MODELS[model];
  if (!direct) return null;
  const provider = PROVIDERS[direct.provider];
  if (!provider.direct) return null;
  return JSON.stringify({
    providers: {
      [provider.piProvider]: {
        api: provider.direct.api,
        baseUrl: provider.direct.baseUrl,
        apiKey: `$${provider.apiKeyEnv}`,
        models: [{ id: model, name: modelLabel(model), input: ["text"], ...direct.spec }],
      },
    },
  });
}
