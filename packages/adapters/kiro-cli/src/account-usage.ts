import { execFile } from "node:child_process";
import os from "node:os";
import { promisify, stripVTControlCharacters } from "node:util";

import { HarnessAccountInspectionError } from "@codexhost/harness-adapter";
import { commandInvocation } from "@codexhost/harness-discovery";
import type { HarnessAccountSnapshot } from "@codexhost/shared-contracts";

import { KiroExecutableError, resolveKiroExecutable } from "./command.js";

const execute = promisify(execFile);
const amount = /(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?/u.source;
const planCredits = new RegExp(
  `^Credits\\s*\\(\\s*(${amount}) of (${amount}) covered in plan\\)(?:,.*)?$`,
  "iu",
);

function resetDate(value: string | undefined): string | undefined {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return undefined;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
    ? value
    : undefined;
}

/** Parse Kiro's account summary only; turn credits and context stats have different semantics. */
export function parseKiroAccountUsage(output: string): HarnessAccountSnapshot | null {
  const lines = stripVTControlCharacters(output)
    .split(/\r?\n/u)
    .map((line) => line.trim());
  const header = lines.find((line) => /^Estimated Usage\s*\|/iu.test(line));
  const row = lines.map((line) => planCredits.exec(line)).find(Boolean);
  if (!header || !row?.[1] || !row[2]) return null;
  const used = Number(row[1].replaceAll(",", ""));
  const limit = Number(row[2].replaceAll(",", ""));
  if (!Number.isFinite(used) || !Number.isFinite(limit) || limit <= 0) return null;
  const fields = header.split("|").map((field) => field.trim());
  const plan = fields.find((field) => /^KIRO [A-Z0-9 +_-]{1,64}$/iu.test(field));
  const resetsAt = resetDate(
    fields.map((field) => /^resets on (\S+)$/iu.exec(field)?.[1]).find(Boolean),
  );
  return {
    ...(plan ? { plan } : {}),
    credits: {
      used,
      limit,
      unit: "credits",
      usedPercent: Math.min(100, (used / limit) * 100),
      // This is the covered-in-plan allowance. Kiro documents it as monthly.
      periodType: "monthly",
      ...(resetsAt ? { resetsAt } : {}),
    },
  };
}

export async function readKiroAccountUsage(options: {
  command?: string;
  environment?: NodeJS.ProcessEnv;
}): Promise<HarnessAccountSnapshot | null> {
  const environment = options.environment ?? process.env;
  try {
    const executable = resolveKiroExecutable(options);
    // V3 headless can send "/usage" to a model. Explicitly select the native V2
    // command; no login, ACP session or model prompt is needed.
    const invocation = commandInvocation(
      executable,
      ["chat", "--v2", "--no-interactive", "--wrap", "never", "/usage"],
      environment,
    );
    const { stdout } = await execute(invocation.command, invocation.arguments, {
      cwd: os.tmpdir(),
      env: { ...environment, NO_COLOR: "1", TERM: "dumb" },
      windowsHide: true,
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
      // Kiro startup plus account I/O can exceed eight seconds on a cold CLI.
      timeout: 11_000,
      maxBuffer: 128_000,
    });
    return parseKiroAccountUsage(stdout);
  } catch (error) {
    if (error instanceof KiroExecutableError) {
      throw new HarnessAccountInspectionError("notInstalled");
    }
    const stderr =
      error && typeof error === "object" && "stderr" in error && typeof error.stderr === "string"
        ? error.stderr
        : "";
    if (
      /sign[ -]?in required|sign in to kiro|not logged in|kiro-cli login|SignInRequiredError/iu.test(
        stderr,
      )
    ) {
      throw new HarnessAccountInspectionError("authenticationRequired");
    }
    if (/unexpected argument.*--v2|unknown (?:flag|option).*--v2/iu.test(stderr)) {
      throw new HarnessAccountInspectionError("unsupported");
    }
    throw new HarnessAccountInspectionError("failed");
  }
}
