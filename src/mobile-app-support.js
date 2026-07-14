const canonicalDeepLinkOrigin = "https://agent-axiom.github.io";
const canonicalDeepLinkBasePath = "/agents-salvo";
const replayIdPattern = /^[A-Za-z0-9-]{1,128}$/;
const roomCodePattern = /^[A-Za-z0-9]{4,12}$/;

export function createUnknownNetworkState() {
  return { connected: false, connectionType: "unknown", confirmed: false };
}

export function networkStateFromSample(status) {
  return {
    connected: status?.connected === true,
    connectionType: typeof status?.connectionType === "string"
      ? status.connectionType
      : "unknown",
    confirmed: true,
  };
}

export function hasConfirmedNetworkConnection(network) {
  return network?.confirmed === true && network.connected === true;
}

export function createAppNavigationCoordinator({
  shouldDiscardLocalBattle,
  clearLocalBattle,
  resetOnline,
  onError,
}) {
  return {
    async run(navigate) {
      if (shouldDiscardLocalBattle()) {
        try {
          await clearLocalBattle();
        } catch (error) {
          await reportObservedError(onError, error);
          return false;
        }
      }
      await resetOnline();
      await navigate();
      return true;
    },
  };
}

export function startMobileAppServices({
  startRuntime,
  hydratePreferences,
  hydrateSecureSession,
  refreshAuth,
  refreshLeaderboard,
  onError,
}) {
  const runtimeResult = settleOperation(startRuntime, onError);
  const preferencesResult = settleOperation(hydratePreferences, onError);
  const secureSessionResult = settleOperation(hydrateSecureSession, onError);

  const runtimeReady = runtimeResult.then(() => undefined);
  const preferencesReady = preferencesResult.then(() => undefined);
  const secureSessionReady = secureSessionResult.then(() => undefined);
  const leaderboardReady = runtimeResult.then((runtime) => (
    runtime.ok ? settleOperation(refreshLeaderboard, onError).then(() => undefined) : undefined
  ));
  const authReady = Promise.all([runtimeResult, secureSessionResult]).then(
    ([runtime, secureSession]) => (
      runtime.ok && secureSession.ok
        ? settleOperation(refreshAuth, onError).then(() => undefined)
        : undefined
    ),
  );
  const done = Promise.all([
    runtimeReady,
    preferencesReady,
    secureSessionReady,
    leaderboardReady,
    authReady,
  ]).then(() => undefined);

  return {
    runtimeReady,
    preferencesReady,
    secureSessionReady,
    leaderboardReady,
    authReady,
    done,
  };
}

export function createPreferenceCoordinator({ settings, onError }) {
  const revisions = new Map();
  const writeTails = new Map();

  return {
    async hydrate(key, apply) {
      const revision = revisions.get(key) ?? 0;
      try {
        const value = await settings.get(key);
        if ((revisions.get(key) ?? 0) !== revision) return false;
        apply(value);
        return true;
      } catch (error) {
        await reportObservedError(onError, error);
        return false;
      }
    },
    write(key, value) {
      revisions.set(key, (revisions.get(key) ?? 0) + 1);
      const previous = writeTails.get(key) ?? Promise.resolve();
      const operation = previous.then(() => settings.set(key, value));
      const observed = operation.then(
        () => true,
        async (error) => {
          await reportObservedError(onError, error);
          return false;
        },
      );
      writeTails.set(key, observed.then(() => undefined));
      return observed;
    },
  };
}

export function createSecureSessionCoordinator({ secureSession }) {
  let revision = 0;
  let writeTail = Promise.resolve();

  const enqueueWrite = (operation) => {
    const result = writeTail.then(operation);
    writeTail = result.catch(() => {});
    return result;
  };

  return {
    async hydrate(apply) {
      const readRevision = revision;
      let token = "";
      try {
        const value = await secureSession.get();
        token = typeof value === "string" ? value : "";
      } catch {
        token = "";
      }
      if (revision !== readRevision) return false;
      apply(token);
      return Boolean(token);
    },
    async establish(token, commit, { isCurrent = () => true } = {}) {
      const writeRevision = ++revision;
      await enqueueWrite(() => secureSession.set(token));
      if (revision !== writeRevision) return false;
      let requestIsCurrent = false;
      try {
        requestIsCurrent = isCurrent();
      } catch {
        requestIsCurrent = false;
      }
      if (!requestIsCurrent) {
        revision += 1;
        await enqueueWrite(() => secureSession.clear());
        return false;
      }
      commit();
      return true;
    },
    async invalidate(commit) {
      const writeRevision = ++revision;
      commit();
      await enqueueWrite(() => secureSession.clear());
      return revision === writeRevision;
    },
  };
}

export function createOrderedSnapshotStore(store) {
  let operationTail = Promise.resolve();

  const enqueue = (operation) => {
    const result = operationTail.then(operation);
    operationTail = result.catch(() => {});
    return result;
  };

  return {
    load: () => enqueue(() => store.load()),
    save: (state) => enqueue(() => store.save(state)),
    clear: () => enqueue(() => store.clear()),
  };
}

export function createLatestClientCoordinator({ createClient, onChange = () => {} }) {
  let generation = 0;
  let current = null;

  const isCurrent = (clientGeneration) => (
    current?.generation === clientGeneration
  );

  const closeCurrent = () => {
    generation += 1;
    const active = current;
    current = null;
    try {
      active?.client.close();
    } catch {
      // Closing a superseded client is best-effort.
    }
    onChange(null);
  };

  const start = (handlers, onStart) => {
    closeCurrent();
    const clientGeneration = generation;
    const currentCheck = () => isCurrent(clientGeneration);
    const client = createClient(guardHandlers(handlers, currentCheck));
    current = { generation: clientGeneration, client };
    guardClientConnection(client, currentCheck);
    onChange(client);
    onStart?.(client);
    return { client, isCurrent: currentCheck };
  };

  return {
    close: closeCurrent,
    async run({ handlers = {}, operation, onStart, onSuccess, onError = () => {} }) {
      let lease;
      try {
        lease = start(handlers, onStart);
        const result = await operation(lease.client, lease.isCurrent);
        if (!lease.isCurrent()) {
          try {
            lease.client.close();
          } catch {}
          return { status: "stale" };
        }
        await onSuccess?.(result, lease.client);
        return lease.isCurrent() ? { status: "active", value: result } : { status: "stale" };
      } catch (error) {
        if (lease && !lease.isCurrent()) {
          try {
            lease.client.close();
          } catch {}
          return { status: "stale" };
        }
        closeCurrent();
        await onError(error);
        return { status: "error", error };
      }
    },
  };
}

function guardClientConnection(client, isCurrent) {
  if (typeof client.connect !== "function") return;
  const connect = client.connect.bind(client);
  client.connect = (...args) => {
    if (isCurrent()) return connect(...args);
    try {
      client.close();
    } catch {}
    return Promise.reject(new Error("Online client was superseded"));
  };
}

function guardHandlers(handlers, isCurrent) {
  return Object.fromEntries(
    Object.entries(handlers).map(([name, value]) => [
      name,
      typeof value === "function"
        ? (...args) => (isCurrent() ? value(...args) : undefined)
        : value,
    ]),
  );
}

export function parseSalvoDeepLink(rawUrl) {
  if (typeof rawUrl !== "string" || rawUrl.trim() !== rawUrl) return null;
  try {
    const url = new URL(rawUrl);
    if (url.username || url.password || url.port) return null;

    if (url.protocol === "salvo:") {
      if (url.search || url.hash) return null;
      const path = decodedPathSegments(url.pathname);
      const segments = url.hostname === "open" ? ["open", ...path] : path;
      if (url.hostname && url.hostname !== "open") return null;
      return parseDeepLinkRoute(segments);
    }

    if (
      url.protocol !== "https:"
      || url.origin !== canonicalDeepLinkOrigin
      || hasExplicitPort(rawUrl)
      || !isCanonicalDeepLinkPath(url.pathname)
      || url.hash
    ) {
      return null;
    }

    const relativePath = url.pathname.slice(canonicalDeepLinkBasePath.length);
    const segments = decodedPathSegments(relativePath);
    if (segments.length > 0) {
      if (url.search) return null;
      return parseDeepLinkRoute(segments);
    }
    if ([...url.searchParams.keys()].some((key) => key !== "replay")) return null;
    const replayId = url.searchParams.get("replay")?.trim() ?? "";
    return replayIdPattern.test(replayId) ? { type: "replay", replayId } : null;
  } catch {
    return null;
  }
}

function parseDeepLinkRoute(segments) {
  if (segments.length !== 3 || segments[0] !== "open") return null;
  const [, type, target] = segments;
  if (type === "room" && roomCodePattern.test(target)) {
    return { type: "room", roomCode: target.toUpperCase() };
  }
  if (type === "replay" && replayIdPattern.test(target)) {
    return { type: "replay", replayId: target };
  }
  return null;
}

function decodedPathSegments(pathname) {
  return pathname.split("/").filter(Boolean).map((segment) => decodeURIComponent(segment));
}

function isCanonicalDeepLinkPath(pathname) {
  return pathname === canonicalDeepLinkBasePath
    || pathname === `${canonicalDeepLinkBasePath}/`
    || pathname.startsWith(`${canonicalDeepLinkBasePath}/`);
}

function hasExplicitPort(rawUrl) {
  const authority = rawUrl.match(/^https:\/\/([^/?#]+)/i)?.[1] ?? "";
  const host = authority.split("@").at(-1);
  return /:\d+$/.test(host);
}

export function createDialogFocusController({
  root,
  document,
  dialogSelector = '[role="dialog"]',
  onCancel,
}) {
  let listening = false;

  const focusableControls = () => {
    const dialog = root.querySelector(dialogSelector);
    return dialog
      ? [...dialog.querySelectorAll("button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])")]
      : [];
  };

  const handleKeydown = (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onCancel();
      return;
    }
    if (event.key !== "Tab") return;
    const controls = focusableControls();
    if (controls.length === 0) {
      event.preventDefault();
      return;
    }
    const dialog = root.querySelector(dialogSelector);
    const first = controls[0];
    const last = controls.at(-1);
    const active = document.activeElement;
    if (event.shiftKey && (active === first || !dialog?.contains(active))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (active === last || !dialog?.contains(active))) {
      event.preventDefault();
      first.focus();
    }
  };

  return {
    captureReturnFocus() {
      const active = document.activeElement;
      if (active?.id) return { id: active.id };
      if (active?.dataset?.action) return { action: active.dataset.action };
      return null;
    },
    activate() {
      const background = root.querySelector("[data-dialog-background]");
      if (background) {
        background.inert = true;
        background.setAttribute("aria-hidden", "true");
      }
      if (!listening) {
        document.addEventListener("keydown", handleKeydown);
        listening = true;
      }
      const dialog = root.querySelector(dialogSelector);
      if (!dialog?.contains(document.activeElement)) {
        focusableControls()[0]?.focus();
      }
    },
    deactivate() {
      const background = root.querySelector("[data-dialog-background]");
      if (background) {
        background.inert = false;
        background.removeAttribute("aria-hidden");
      }
      if (listening) {
        document.removeEventListener("keydown", handleKeydown);
        listening = false;
      }
    },
    restoreFocus(descriptor) {
      const target = findFocusTarget(root, descriptor);
      if (target?.isConnected !== false) target?.focus();
    },
  };
}

function findFocusTarget(root, descriptor) {
  if (!descriptor) return null;
  if (descriptor.id) {
    return [...root.querySelectorAll("[id]")].find((element) => element.id === descriptor.id) ?? null;
  }
  if (descriptor.action) {
    return [...root.querySelectorAll("[data-action]")]
      .find((element) => element.dataset.action === descriptor.action) ?? null;
  }
  return null;
}

async function settleOperation(operation, onError) {
  try {
    return { ok: true, value: await Promise.resolve().then(operation) };
  } catch (error) {
    await reportObservedError(onError, error);
    return { ok: false, error };
  }
}

async function reportObservedError(observer, error) {
  try {
    await observer?.(error);
  } catch {
    // Error observers must not create unhandled rejections.
  }
}
