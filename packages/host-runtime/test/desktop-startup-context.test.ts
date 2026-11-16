import { describe, expect, it } from "vitest";
import {
  readDesktopStartupContext,
  writeDesktopStartupContext,
} from "../src/desktop-startup-context.js";

describe("Desktop startup context", () => {
  it("forwards the tool connection from Desktop and clears inherited connection fields", () => {
    const desktop = {
      arguments: ["app-server"],
      environment: {
        BROWSER_USE_ACCESS_EXECUTOR_ID: "test-executor",
        BROWSER_USE_ACCESS_PIPE_PATH: "/desktop/current.sock",
        BROWSER_USE_ACCESS_VERIFYING_IDENTITY: "test-identity",
        CODEX_APP_TOOLS_PIPE_PATH: "/desktop/current.sock",
        CODEXHOST_DATA_DIR: "/untrusted",
        CODEX_HOME: "/untrusted",
        PATH: "/untrusted",
        OTHER_AUTH_TOKEN: "test-token",
      },
    };
    const base = {
      CODEX_APP_TOOLS_PIPE_PATH: "/desktop/old.sock",
      CODEX_MCP_NODE_PATH: "/desktop/old-node",
      CODEXHOST_DATA_DIR: "/shared-host",
      CODEX_HOME: "/shared-codex",
      PATH: "/host/bin",
    };
    const context = readDesktopStartupContext(base, writeDesktopStartupContext(desktop));

    expect(context.arguments).toEqual(desktop.arguments);
    expect(context.environment).toMatchObject({
      BROWSER_USE_ACCESS_EXECUTOR_ID: "test-executor",
      BROWSER_USE_ACCESS_PIPE_PATH: "/desktop/current.sock",
      BROWSER_USE_ACCESS_VERIFYING_IDENTITY: "test-identity",
      CODEX_APP_TOOLS_PIPE_PATH: "/desktop/current.sock",
      CODEXHOST_DATA_DIR: "/shared-host",
      CODEX_HOME: "/shared-codex",
      PATH: "/host/bin",
    });
    expect(context.environment).not.toHaveProperty("CODEX_MCP_NODE_PATH");
    expect(context.environment).not.toHaveProperty("OTHER_AUTH_TOKEN");
  });

  it("rejects unrelated variables injected into a Desktop connection", () => {
    const injected = Buffer.from(
      JSON.stringify({
        version: 1,
        arguments: [],
        environment: { NODE_OPTIONS: "--require /tmp/a" },
      }),
    ).toString("base64");
    expect(() => readDesktopStartupContext({}, injected)).toThrow(
      "Invalid Desktop runtime context field",
    );
  });
});
