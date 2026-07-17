export function createMobileRuntime({
  platform,
  snapshots,
  getState,
  applySnapshot,
  onRestoreError,
  onNetwork,
  onDeepLink,
  onBack,
  onSettings = () => {},
  onThemeChange = () => {},
  onViewportChange = () => {},
  pauseAudio,
  resumeAudio,
  onRuntimeError,
}) {
  let activeRemovers = [];
  let desiredStarted = false;
  let lastNetworkStatus = null;
  let lifecycleTail = Promise.resolve();
  let networkEventVersion = 0;
  let networkTail = Promise.resolve();
  let platformReady = false;
  let started = false;
  let transitionTail = Promise.resolve();

  const reportRuntimeError = async (error) => {
    if (!onRuntimeError) return;
    try {
      await onRuntimeError(error);
    } catch {
      // Error observers must not make platform callbacks reject.
    }
  };

  const performLifecycle = async ({ active }) => {
    if (active) {
      try {
        await resumeAudio();
      } catch (error) {
        await reportRuntimeError(error);
      }
      return;
    }

    const failures = [];
    try {
      await pauseAudio();
    } catch (error) {
      failures.push(error);
    }
    try {
      await snapshots.save(getState());
    } catch (error) {
      failures.push(error);
    }
    for (const error of failures) await reportRuntimeError(error);
  };

  const handleLifecycle = (event) => {
    const operation = lifecycleTail.then(() => performLifecycle(event));
    lifecycleTail = operation.catch(reportRuntimeError);
    return lifecycleTail;
  };

  const deliverNetwork = async (status) => {
    const nextNetworkStatus = {
      connected: status?.connected,
      connectionType: status?.connectionType,
    };
    if (
      lastNetworkStatus
      && lastNetworkStatus.connected === nextNetworkStatus.connected
      && lastNetworkStatus.connectionType === nextNetworkStatus.connectionType
    ) {
      return;
    }
    await onNetwork(status);
    lastNetworkStatus = nextNetworkStatus;
  };

  const queueNetworkDelivery = (status, observeFailure) => {
    const operation = networkTail.then(() => deliverNetwork(status));
    networkTail = operation.catch((error) => (
      observeFailure ? reportRuntimeError(error) : undefined
    ));
    return observeFailure ? networkTail : operation;
  };

  const handleNetworkChange = (status) => {
    networkEventVersion += 1;
    return queueNetworkDelivery(status, true);
  };

  const removeSubscriptions = async (removers) => {
    const results = await Promise.allSettled(
      removers.map((remove) => Promise.resolve().then(remove)),
    );
    const errors = [];
    const failedRemovers = [];

    results.forEach((result, index) => {
      if (result.status === "rejected") {
        errors.push(result.reason);
        failedRemovers.push(removers[index]);
      }
    });

    return { errors, failedRemovers };
  };

  const registerSubscriptions = async () => {
    const removers = [];
    const registerOptional = async (name, listener) => {
      const subscribe = platform[name];
      if (typeof subscribe !== "function") return;
      const remove = await subscribe.call(platform, listener);
      if (typeof remove === "function") removers.push(remove);
    };
    try {
      removers.push(await platform.onNetworkChange(handleNetworkChange));
      removers.push(await platform.onDeepLink(onDeepLink));
      removers.push(await platform.onBack(onBack));
      removers.push(await platform.onLifecycleChange(handleLifecycle));
      await registerOptional("onSettings", onSettings);
      await registerOptional("onThemeChange", onThemeChange);
      await registerOptional("onViewportChange", onViewportChange);
      return removers;
    } catch (error) {
      const cleanup = await removeSubscriptions(removers);
      await Promise.all([networkTail, lifecycleTail]);
      if (cleanup.errors.length > 0) {
        activeRemovers = cleanup.failedRemovers;
        throw new AggregateError(
          [error, ...cleanup.errors],
          "Failed to register and clean up mobile runtime subscriptions",
        );
      }
      throw error;
    }
  };

  const performStart = async () => {
    lastNetworkStatus = null;
    networkEventVersion = 0;
    await queueNetworkDelivery(await platform.getNetworkStatus(), false);

    try {
      const snapshot = await snapshots.load();
      if (snapshot) await applySnapshot(snapshot);
    } catch (error) {
      try {
        await onRestoreError(error);
      } catch (observerError) {
        await reportRuntimeError(observerError);
      }
    }

    await platform.configureSystemBars();
    await platform.hideSplash();
    const removers = await registerSubscriptions();
    try {
      const versionBeforeSample = networkEventVersion;
      const status = await platform.getNetworkStatus();
      if (networkEventVersion === versionBeforeSample) {
        await queueNetworkDelivery(status, false);
      }
      if (!platformReady && typeof platform.ready === "function") {
        await platform.ready();
        platformReady = true;
      }
    } catch (error) {
      const cleanup = await removeSubscriptions(removers);
      await Promise.all([networkTail, lifecycleTail]);
      if (cleanup.errors.length > 0) {
        activeRemovers = cleanup.failedRemovers;
        throw new AggregateError(
          [error, ...cleanup.errors],
          "Failed to sample network and clean up mobile runtime subscriptions",
        );
      }
      throw error;
    }
    activeRemovers = removers;
    started = true;
  };

  const performStop = async () => {
    started = false;
    const removers = activeRemovers;
    activeRemovers = [];
    const cleanup = await removeSubscriptions(removers);
    await Promise.all([networkTail, lifecycleTail]);
    if (cleanup.errors.length > 0) {
      activeRemovers = cleanup.failedRemovers;
      throw new AggregateError(
        cleanup.errors,
        "Failed to remove mobile runtime subscriptions",
      );
    }
  };

  const reconcileState = async () => {
    while (true) {
      if (desiredStarted) {
        if (started) return;
        if (activeRemovers.length > 0) {
          await performStop();
          continue;
        }
        await performStart();
        continue;
      }

      if (!started && activeRemovers.length === 0) return;
      await performStop();
    }
  };

  const requestState = (nextStarted) => {
    desiredStarted = nextStarted;
    const transition = transitionTail.then(reconcileState);
    transitionTail = transition.catch(() => {});
    return transition;
  };

  return {
    start: () => requestState(true),
    async persist() {
      await snapshots.save(getState());
    },
    stop: () => requestState(false),
  };
}
