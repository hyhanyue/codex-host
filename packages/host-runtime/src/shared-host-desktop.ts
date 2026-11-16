import type { IncomingMessage } from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { AppServerHost } from "./app-server-host.js";
import { SharedThreadBridge } from "./shared-thread-bridge.js";
import type { SharedThreadOwner } from "./shared-thread-owner.js";
import type { ExternalThreadStore } from "./external-thread-repository.js";
import type { PreparedLocalCodex } from "./native-account-host.js";
import { installedHarnessPluginOptions } from "./installed-harness-plugins.js";
import type { RemoteAppServerSession, RemoteAppServerSessionStreams } from "./remote-app-server.js";
import type { DelegationControlRegistration } from "./delegation-types.js";
import { readDesktopStartupContext } from "./desktop-startup-context.js";
import type { ModelPriceCatalog } from "./model-prices.js";
import { RuntimeMaintenance } from "./runtime-maintenance.js";
import { consoleEntrypoint, createHostConsoleOpener } from "./console-opener.js";
import { createHostWebOpener } from "./web-opener.js";
import type { HostUpdateCoordinator } from "./update-coordinator.js";

export function sharedHostDesktop(
  options: {
    environment: NodeJS.ProcessEnv;
    runtimeUrl: string;
    stockCodex: string;
    official: PreparedLocalCodex;
    owner: SharedThreadOwner;
    returnToCodex?: AppServerHost["returnToCodex"];
    store: ExternalThreadStore;
    prices: ModelPriceCatalog;
    updateCoordinator?: HostUpdateCoordinator;
    delegation(): DelegationControlRegistration | undefined;
    register(api: DelegationControlRegistration): (() => void) | undefined;
    connected: Set<AppServerHost>;
    running: Set<Promise<number>>;
  },
  streams: RemoteAppServerSessionStreams,
  request?: IncomingMessage,
): RemoteAppServerSession {
  const { environment, arguments: nativeArguments } = readDesktopStartupContext(
    options.environment,
    request?.headers["x-codexhost-desktop-context"],
  );
  let startup: Promise<void> | undefined;
  if (nativeArguments) {
    const stockCodexPath = environment.CODEXHOST_STOCK_CODEX_PATH ?? options.stockCodex;
    if (!path.isAbsolute(stockCodexPath))
      throw new Error("Desktop requires an absolute native Codex executable");
    startup = options.official.configureStartup({
      stockCodexPath,
      arguments: nativeArguments,
      environment,
    });
  }
  const runtime = environment.CODEXHOST_HOST_RUNTIME_PATH;
  const runtimePath = runtime && path.isAbsolute(runtime) ? runtime : undefined;
  const entry = runtimePath ? consoleEntrypoint(runtimePath) : null;
  const delegation = options.delegation();
  const webOpener = createHostWebOpener(options.environment);
  const host = new AppServerHost({
    stockCodexPath: options.stockCodex,
    arguments: [],
    environment,
    desktopInput: streams.input,
    desktopOutput: streams.output,
    diagnosticOutput: streams.diagnosticOutput,
    officialRuntimeScope: options.official.officialRuntimeScope,
    accountControl: options.official.accountControl,
    mappingStore: options.store,
    ...(options.returnToCodex ? { returnToCodex: options.returnToCodex } : {}),
    closeMappingStoreOnExit: false,
    modelPrices: options.prices,
    sharedThreads: new SharedThreadBridge({
      connect: async () => options.owner.connect(),
      delegateCreates: true,
      diagnose: (error) => streams.diagnosticOutput.write(`Shared Host: ${String(error)}\n`),
    }),
    ...(delegation ? { sharedDelegation: delegation } : {}),
    ...installedHarnessPluginOptions(
      environment,
      false,
      runtimePath ? pathToFileURL(runtimePath).href : options.runtimeUrl,
    ),
    ...(runtimePath
      ? { runtimeMaintenance: new RuntimeMaintenance({ runtimePath, remote: false, environment }) }
      : {}),
    ...(options.updateCoordinator ? { updateCoordinator: options.updateCoordinator } : {}),
    ...(entry
      ? { consoleOpener: createHostConsoleOpener({ entrypoint: entry, environment }) }
      : {}),
    ...(webOpener ? { webOpener } : {}),
    onDelegationApi: options.register,
  });
  return {
    run: async () => {
      await startup;
      options.connected.add(host);
      const running = host.run();
      options.running.add(running);
      try {
        return await running;
      } finally {
        options.connected.delete(host);
        options.running.delete(running);
      }
    },
    disconnect: () => host.disconnect(),
    close: () => host.close(),
  };
}
