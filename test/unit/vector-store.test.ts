import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VectorStore, textSha } from "../../pipeline/vector-store.ts";

test("text hashes are stable and content-addressed", () => {
  assert.equal(textSha("same text"), textSha("same text"));
  assert.notEqual(textSha("same text"), textSha("same text "));
  assert.equal(textSha("x").length, 32);
});

test("sqlite store persists vectors and answers cosine search", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fp-vector-"));
  const path = join(dir, "vectors.db");
  try {
    const store = await VectorStore.open({ path, model: "test-model", backend: "sqlite" });
    assert.equal(store.has(textSha("alpha")), false);
    store.upsert([
      { videoId: "a", text: "alpha", vector: [1, 0, 0] },
      { videoId: "b", text: "beta", vector: [0, 1, 0] },
    ]);
    assert.equal(store.has(textSha("alpha")), true);
    const hit = store.search([1, 0, 0], 2)[0];
    assert.equal(hit.videoId, "a");
    assert.equal(Number(hit.score.toFixed(3)), 1);
    assert.equal(store.nearest("b", 1)[0].videoId, "a");
    const stats = store.stats();
    assert.equal(stats.backend, "sqlite");
    assert.equal(stats.vectors, 2);
    assert.equal(stats.dims, 3);
    assert.equal(stats.model, "test-model");
    store.close();

    const reopened = await VectorStore.open({ path, model: "test-model", backend: "sqlite" });
    assert.equal(reopened.stats().vectors, 2);
    assert.equal(reopened.stats().dims, 3);
    reopened.upsert([{ videoId: "a", text: "alpha v2", vector: [0, 1, 0] }]);
    assert.equal(reopened.stats().vectors, 2);
    assert.equal(reopened.search([0, 1, 0], 1)[0].videoId, "a");
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a model change clears the space instead of mixing dimensions", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fp-vector-"));
  const path = join(dir, "vectors.db");
  try {
    const first = await VectorStore.open({ path, model: "model-a", backend: "sqlite" });
    first.upsert([{ videoId: "a", text: "alpha", vector: [1, 0] }]);
    first.close();

    const second = await VectorStore.open({ path, model: "model-b", backend: "sqlite" });
    assert.equal(second.stats().vectors, 0);
    assert.equal(second.has(textSha("alpha")), false);
    second.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("json fallback keeps the same search contract", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fp-vector-"));
  const path = join(dir, "vectors.db");
  try {
    const store = await VectorStore.open({ path, model: "json-model", backend: "json" });
    store.upsert([
      { videoId: "a", text: "alpha", vector: [1, 0] },
      { videoId: "b", text: "beta", vector: [0, 1] },
    ]);
    assert.equal(store.stats().backend, "json");
    assert.ok(store.stats().path.endsWith("vectors.json"));
    assert.equal(store.search([1, 0], 1)[0].videoId, "a");
    store.close();

    const reopened = await VectorStore.open({ path, model: "json-model", backend: "json" });
    assert.equal(reopened.stats().vectors, 2);
    assert.equal(reopened.search([0, 1], 1)[0].videoId, "b");
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
