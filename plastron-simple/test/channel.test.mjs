import { test } from "node:test";
import assert from "node:assert/strict";
import { createInitialState, precomputeOptional, resolveFn } from "../dist/index.js";

// ChannelCel — a channel descriptor lives as a cel; precompute builds
// a live Channel onto cel._channel that captures a queue + a drain fn
// keyed against the cel registry. Fireable cels declare
// metadata.channel: ChannelKey[] to enqueue on each fire. flushChannels
// pumps queues to fixed point.

const userManifest = {
  name: "user", version: "0.0.1", description: "test", dependencies: [],
};

// Boot a graph with: a ValueCel input, a FormulaCel that doubles it
// and is bound to channel "ch", and a ChannelCel "ch" whose drain
// pushes received items into an out-of-band array.
const bootWithChannel = async () => {
  const captured = [];
  const state = createInitialState();
  const register = resolveFn(state, "registerLambda");
  await register(state, {
    key: "captureDrain",
    fn: (items) => { for (const item of items) captured.push(item); },
    kind: "custom",
  });

  const hydrate = resolveFn(state, "hydrate");
  const seg = {
    name: "user",
    cels: [
      {
        key: "ch",
        celType: "ChannelCel",
        metadata: { key: "ch", segment: "user", drain: "captureDrain" },
        v: { drain: "captureDrain" },
      },
      { key: "x", celType: "ValueCel", metadata: { key: "x", segment: "user", v: 3 } },
      {
        key: "twoX",
        celType: "FormulaCel",
        metadata: { key: "twoX", segment: "user", parser: "f", channel: ["ch"] },
        f: "(* x 2)",
      },
    ],
  };
  await hydrate(state, [seg], [userManifest]);
  await precomputeOptional(state);
  return { state, captured };
};

test("a fired cel bound to a channel enqueues onto that channel", async () => {
  const { state, captured } = await bootWithChannel();
  const runCycle = resolveFn(state, "runCycle");
  const drain    = resolveFn(state, "drain");

  await runCycle(state);
  assert.equal(captured.length, 0, "drain hasn't run yet, queue is buffered");

  await drain(state, "ch");
  assert.equal(captured.length, 1, "one fire → one queue entry");
  assert.equal(captured[0].cel.metadata.key, "twoX", "queue entry carries the fired cel");
});

test("set triggers cascade + channel enqueue on the affected cel only", async () => {
  const { state, captured } = await bootWithChannel();
  const runCycle = resolveFn(state, "runCycle");
  const set      = resolveFn(state, "set");
  const drain    = resolveFn(state, "drain");

  await runCycle(state);
  await drain(state, "ch");
  captured.length = 0;

  await set(state, "x", 10);
  await drain(state, "ch");
  assert.equal(captured.length, 1, "set fires twoX once → one enqueue");
  assert.equal(captured[0].cel.v, 20, "fired cel sees its new value");
});

test("set with { flush: 'all' } drains channels inline", async () => {
  const { state, captured } = await bootWithChannel();
  const runCycle = resolveFn(state, "runCycle");
  const set      = resolveFn(state, "set");
  const drain    = resolveFn(state, "drain");
  await runCycle(state);
  await drain(state, "ch");
  captured.length = 0;
  await set(state, "x", 5, { flush: "all" });
  assert.equal(captured.length, 1, "channel drained inline, no separate drain() call");
  assert.equal(captured[0].cel.v, 10);
});

test("drain on an unknown channel key is a no-op", async () => {
  const { state } = await bootWithChannel();
  const drain = resolveFn(state, "drain");
  await drain(state, "no-such-channel");
});

test("a cel writing the same value doesn't re-enqueue (output diff suppresses)", async () => {
  const { state, captured } = await bootWithChannel();
  const runCycle = resolveFn(state, "runCycle");
  const set      = resolveFn(state, "set");
  const drain    = resolveFn(state, "drain");
  await runCycle(state);
  await drain(state, "ch");
  captured.length = 0;

  // Setting x to its current value: cascade walks but twoX's output
  // doesn't change, so suppression mode skips the channel enqueue.
  await set(state, "x", 3);
  await drain(state, "ch");
  assert.equal(captured.length, 0, "no enqueue when the output didn't change");
});
