import { test } from "node:test";
import assert from "node:assert/strict";
import { createContext, execute } from "../src/app.ts";
import { createEmbeddingClient, loadFromArtifacts } from "../src/sources.ts";
import { buildIndex, buildFact, buildSankey } from "../src/derive.ts";

const dataset = loadFromArtifacts();
const index = buildIndex(dataset);
const ctx = createContext(dataset, createEmbeddingClient({}));
const run = (source: string, variableValues?: Record<string, unknown>) => execute({ source, variableValues, context: ctx });

test("sankey: node and link weights reconcile with the fact's video count", () => {
  for (const fact of dataset.facts) {
    const { nodes, links, summary } = buildSankey(index, fact);
    const factNode = nodes.find((node) => node.column === 0)!;
    const readings = nodes.filter((node) => node.column === 1);
    const verdicts = nodes.filter((node) => node.column === 2);

    assert.equal(factNode.videos, summary.videos, `${fact.id}: fact node != summary`);
    assert.equal(readings.reduce((sum, node) => sum + node.videos, 0), summary.videos, `${fact.id}: readings do not sum to videos`);
    assert.equal(verdicts.reduce((sum, node) => sum + node.videos, 0), summary.videos, `${fact.id}: verdicts do not sum to videos`);
    assert.equal(links.filter((link) => link.source === "fact").reduce((sum, link) => sum + link.videos, 0), summary.videos, `${fact.id}: fact links`);

    for (const node of readings) {
      const out = links.filter((link) => link.source === node.id);
      assert.equal(out.reduce((sum, link) => sum + link.videos, 0), node.videos, `${fact.id}/${node.id}: outgoing links`);
    }
    for (const node of verdicts) {
      const incoming = links.filter((link) => link.target === node.id);
      assert.equal(incoming.reduce((sum, link) => sum + link.videos, 0), node.videos, `${fact.id}/${node.id}: incoming links`);
    }
  }
});

test("sankey: shares are percentages of the whole and add to 100", () => {
  for (const fact of dataset.facts) {
    const { summary } = buildSankey(index, fact);
    for (const value of [summary.forPct, summary.againstPct, summary.nonePct]) {
      assert.ok(value >= 0 && value <= 100, `${fact.id}: share out of range`);
    }
    assert.ok(Math.abs(summary.forPct + summary.againstPct + summary.nonePct - 100) <= 0.11, `${fact.id}: shares do not add to 100`);
  }
});

test("sankey: structure is fixed — fact, ≤5 readings, ≤3 verdicts", () => {
  for (const fact of dataset.facts) {
    const { nodes, links, summary } = buildSankey(index, fact);
    assert.equal(nodes.filter((node) => node.column === 0).length, 1);
    assert.ok(nodes.filter((node) => node.column === 1).length <= 5, `${fact.id}: too many readings`);
    assert.ok(nodes.filter((node) => node.column === 2).length <= 3);
    assert.equal(new Set(nodes.map((node) => node.id)).size, nodes.length, `${fact.id}: duplicate node ids`);
    assert.equal(new Set(nodes.map((node) => node.label)).size, nodes.length, `${fact.id}: duplicate labels`);
    // Every link endpoint exists.
    const ids = new Set(nodes.map((node) => node.id));
    for (const link of links) {
      assert.ok(ids.has(link.source) && ids.has(link.target), `${fact.id}: dangling link`);
      assert.ok(link.videos > 0);
    }
    if (summary.topReading) {
      const top = nodes.filter((node) => node.column === 1).sort((a, b) => b.videos - a.videos)[0];
      assert.equal(summary.topReading, top.label);
    }
  }
});

test("sankey: identical on every call (no hidden ordering)", () => {
  const fact = dataset.facts.find((item) => item.id === "pension_2023_64")!;
  assert.deepEqual(buildSankey(index, fact), buildSankey(index, fact));
});

test("sankey: the pension fact reads as protests against a candidate", () => {
  const fact = dataset.facts.find((item) => item.id === "pension_2023_64")!;
  const { summary, nodes } = buildSankey(index, fact);
  assert.equal(summary.videos, 17);
  assert.equal(summary.topReading, "Sparked protests");
  assert.ok(summary.againstPct > summary.forPct);
  assert.ok(nodes.some((node) => node.label === "Sparked protests"));
});

test("graphql: facts expose the sankey and it is shaped for the client", async () => {
  const result = await run(`{
    facts {
      id videos
      sankey {
        nodes { id label column videos views }
        links { source target videos views }
        summary { videos forPct againstPct nonePct topReading }
      }
    }
  }`);
  assert.deepEqual(result.errors, undefined);
  assert.equal(result.data.facts.length, dataset.facts.length);
  for (const fact of result.data.facts) {
    assert.ok(fact.sankey.nodes.length >= 2);
    assert.equal(typeof fact.sankey.summary.againstPct, "number");
    assert.ok(fact.sankey.links.every((link: any) => typeof link.source === "string"));
  }
});

test("anatomy: attribution carries a platform embed URL", async () => {
  const result = await run(`{
    entryPage(limit: 6) {
      attribution { handle platform platformId embedUrl url }
    }
  }`);
  assert.deepEqual(result.errors, undefined);
  for (const item of result.data.entryPage) {
    const a = item.attribution;
    assert.ok(a.platformId, `${a.handle}: missing platformId`);
    assert.ok(a.embedUrl?.startsWith("https://"), `${a.handle}: missing embed URL`);
    if (a.platform === "INSTAGRAM") assert.ok(a.embedUrl.includes("instagram.com/p/"));
    if (a.platform === "TIKTOK") assert.ok(a.embedUrl.includes("tiktok.com/embed/v2/"));
    assert.ok(a.embedUrl.includes(a.platformId));
  }
});
