import assert from "node:assert/strict";
import test from "node:test";

import { createMaxMiniAppAuthClient } from "../src/max-mini-app-auth.js";

const token = "a".repeat(43);
const maxUser = {
  provider: "max",
  id: "67890",
  name: "Max User",
  username: "max_user",
  photoUrl: "https://example.test/max-user.jpg",
};

test("MAX Mini App client posts signed initData and accepts only MAX sessions", async () => {
  const requests = [];
  const client = createMaxMiniAppAuthClient({
    workerUrl: "https://worker.test/api///",
    async fetcher(input, init) {
      requests.push([input, init]);
      return Response.json({ token, user: maxUser });
    },
  });

  assert.deepEqual(await client.authenticate("signed-max-data"), {
    token,
    user: maxUser,
  });
  assert.equal(requests[0][0], "https://worker.test/api/auth/max/miniapp");
  const { signal, ...init } = requests[0][1];
  assert.equal(signal instanceof AbortSignal, true);
  assert.deepEqual(init, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: '{"initData":"signed-max-data"}',
  });

  const wrongProvider = createMaxMiniAppAuthClient({
    workerUrl: "https://worker.test",
    fetcher: async () => Response.json({
      token,
      user: { ...maxUser, provider: "telegram" },
    }),
  });
  await assert.rejects(wrongProvider.authenticate("signed-max-data"), {
    message: "MAX authentication unavailable",
    status: 200,
  });
});

test("MAX Mini App client rejects empty and oversized UTF-8 initData before fetching", async () => {
  let fetchCalls = 0;
  const client = createMaxMiniAppAuthClient({
    workerUrl: "https://worker.test",
    async fetcher() {
      fetchCalls += 1;
      return Response.json({ token, user: maxUser });
    },
  });

  for (const value of [undefined, null, "", 42, "a".repeat(16 * 1024 + 1)]) {
    await assert.rejects(client.authenticate(value), { name: "TypeError" });
  }
  await assert.rejects(client.authenticate(`${"a".repeat(16 * 1024 - 1)}é`), {
    name: "TypeError",
  });
  assert.equal(fetchCalls, 0);
});
