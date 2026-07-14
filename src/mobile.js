export function createMobileRuntime({
  platform,
  snapshots,
  getState,
  applySnapshot,
  onRestoreError,
  onNetwork,
  onDeepLink,
  onBack,
  pauseAudio,
  resumeAudio,
  onRuntimeError,
}) {
  let activeRemovers = [];
  let desiredStarted = false;
  let started = false;
  let transitionTail = Promise.resolve();

  const reportRuntimeError = async (error) => {
    if (!onRuntimeError) return;
    try {
      await onRuntimeError(error);
    } catch {
      // Error observers must not make platform lifecycle callbacks reject.
    }
  };

  const handleLifecycle = async ({ active }) => {
    try {
      if (active) {
        await resumeAudio();
        return;
      }

      await pauseAudio();
      await snapshots.save(getState());
    } catch (error) {
      await reportRuntimeError(error);
    }
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
    try {
      removers.push(await platform.onNetworkChange(onNetwork));
      removers.push(await platform.onDeepLink(onDeepLink));
      removers.push(await platform.onBack(onBack));
      removers.push(await platform.onLifecycleChange(handleLifecycle));
      return removers;
    } catch (error) {
      const cleanup = await removeSubscriptions(removers);
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
    await onNetwork(await platform.getNetworkStatus());

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
    activeRemovers = await registerSubscriptions();
    started = true;
  };

  const performStop = async () => {
    started = false;
    const removers = activeRemovers;
    activeRemovers = [];
    const cleanup = await removeSubscriptions(removers);
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
