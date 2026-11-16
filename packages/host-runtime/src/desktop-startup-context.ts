import {
  DELEGATION_RUNTIME_ENDPOINT_ENV,
  DELEGATION_RUNTIME_TOKEN_ENV,
} from "./delegation-types.js";

// Forward only the desktop launch settings used by the native tool bridge.
export const desktopToolEnvironmentKeys = [
  "BROWSER_USE_ACCESS_EXECUTOR_ID",
  "BROWSER_USE_ACCESS_PIPE_PATH",
  "BROWSER_USE_ACCESS_VERIFYING_IDENTITY",
  "CODEX_APP_RUNTIME_CLI_PATH",
  "CODEX_APP_TOOLS_PIPE_PATH",
  "CODEX_INTERNAL_ORIGINATOR_OVERRIDE",
  "CODEX_MCP_NODE_PATH",
  "CODEX_TASK_WORKSPACE_VERIFYING_IDENTITY",
] as const;
const desktopToolEnvironment = new Set<string>(desktopToolEnvironmentKeys);
const maxContextLength = 16_000;

function isDesktopContextEnvironmentKey(key: string): boolean {
  return key.startsWith("CODEXHOST_") || desktopToolEnvironment.has(key);
}

export function withoutDesktopToolEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result = { ...environment };
  for (const key of desktopToolEnvironmentKeys) delete result[key];
  return result;
}

export function writeDesktopStartupContext(desktop: {
  environment: NodeJS.ProcessEnv;
  arguments: string[];
}): string {
  const context = Buffer.from(
    JSON.stringify({
      version: 1,
      arguments: desktop.arguments,
      environment: Object.fromEntries(
        Object.entries(desktop.environment).filter(
          ([key, value]) => isDesktopContextEnvironmentKey(key) && value !== undefined,
        ),
      ),
    }),
  ).toString("base64");
  if (context.length > maxContextLength)
    throw new Error("Desktop runtime context exceeds its transport limit");
  return context;
}

/** Runtime/control context is private to an authenticated Desktop connection. It
 * cannot change the service's data root, native account home or execution owner. */
export function readDesktopStartupContext(
  base: NodeJS.ProcessEnv,
  raw: string | string[] | undefined,
): { environment: NodeJS.ProcessEnv; arguments: string[] | undefined } {
  if (raw === undefined) return { environment: base, arguments: undefined };
  if (typeof raw !== "string" || raw.length > maxContextLength)
    throw new Error("Invalid Desktop runtime context");
  const value: unknown = JSON.parse(Buffer.from(raw, "base64").toString("utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid Desktop runtime context");
  const envelope = value as Record<string, unknown>;
  if (
    envelope.version !== 1 ||
    !Array.isArray(envelope.arguments) ||
    !envelope.arguments.every((argument) => typeof argument === "string") ||
    !envelope.environment ||
    typeof envelope.environment !== "object" ||
    Array.isArray(envelope.environment)
  )
    throw new Error("Invalid Desktop runtime context");
  const context: NodeJS.ProcessEnv = {};
  for (const [key, entry] of Object.entries(envelope.environment)) {
    if (!isDesktopContextEnvironmentKey(key) || typeof entry !== "string")
      throw new Error("Invalid Desktop runtime context field");
    context[key] = entry;
  }
  return {
    arguments: envelope.arguments as string[],
    environment: {
      ...withoutDesktopToolEnvironment(base),
      ...context,
      CODEXHOST_DATA_DIR: base.CODEXHOST_DATA_DIR,
      CODEX_HOME: base.CODEX_HOME,
      [DELEGATION_RUNTIME_ENDPOINT_ENV]: base[DELEGATION_RUNTIME_ENDPOINT_ENV],
      [DELEGATION_RUNTIME_TOKEN_ENV]: base[DELEGATION_RUNTIME_TOKEN_ENV],
    },
  };
}
