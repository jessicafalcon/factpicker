import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { printSchema } from "graphql";
import { createContext, execute, schema } from "../src/app.ts";
import { createEmbeddingClient, loadFromArtifacts } from "../src/sources.ts";

const dataset = loadFromArtifacts();
const ctx = createContext(dataset, createEmbeddingClient({}));
const run = (source: string, variableValues?: Record<string, unknown>) => execute({ source, variableValues, context: ctx });

test("the schema is valid and exposes the v0.1 surface", () => {
  const sdl = printSchema(schema);
  assert.ok(sdl.includes("type Query"));
  for (const field of ["story", "events", "event", "eventImpact", "issueGroups", "facts", "fact", "search", "creator", "video", "candidates", "candidate", "timeline", "apiVersion"]) {
    assert.ok(new RegExp(`\\b${field}\\(`).test(sdl) || new RegExp(`\\b${field}:`).test(sdl), `Query.${field} missing`);
  }
  // No field may be both nullable and required in the type system by accident.
  assert.ok(sdl.includes("changePct: Float"));
});

test("apiVersion and candidates resolve", async () => {
  const result = await run("{ apiVersion candidates { id name tier status } }");
  assert.deepEqual(result.errors, undefined);
  assert.equal(result.data.apiVersion, "0.1.0");
  assert.equal(result.data.candidates.length, dataset.candidates.length);
  assert.ok(result.data.candidates.every((candidate: any) => candidate.tier && candidate.status));
});

test("story: a fact's stories and targets reconcile with its videos", async () => {
  const result = await run(`{
    story(factId: "pension_2023_64") {
      id statement videos creators
      stories { label videos favorable critical neutral unclear }
      aimedAt { candidate { id } leaning videos }
    }
  }`);
  assert.deepEqual(result.errors, undefined);
  const story = result.data.story;
  assert.ok(story.videos > 0);
  const storySum = story.stories.reduce((sum: number, row: any) => sum + row.videos, 0);
  const labelled = story.stories.reduce((sum: number, row: any) => sum + row.favorable + row.critical + row.neutral + row.unclear, 0);
  assert.equal(storySum, story.videos, "stories must partition the cited videos");
  assert.equal(labelled, story.videos, "each video contributes exactly one leaning");
  assert.ok(story.aimedAt.every((row: any) => row.videos > 0));
});

test("events: filtering and scandal consistency", async () => {
  const all = await run("{ events(filter: { limit: 100 }) { id isScandal majorIssue subIssue kind } }");
  assert.deepEqual(all.errors, undefined);
  assert.equal(all.data.events.length, dataset.events.events.length);

  const scandals = await run("{ events(filter: { isScandal: true }) { id isScandal } }");
  assert.ok(scandals.data.events.length >= 5);
  assert.ok(scandals.data.events.every((event: any) => event.isScandal === true));

  const scoped = await run(`{ events(filter: { majorIssue: "Economy & work" }) { majorIssue } }`);
  assert.ok(scoped.data.events.length > 0);
  assert.ok(scoped.data.events.every((event: any) => event.majorIssue === "Economy & work"));

  const campaign = await run(`{ events(filter: { kind: CAMPAIGN }) { kind } }`);
  assert.ok(campaign.data.events.every((event: any) => event.kind === "CAMPAIGN"));
});

test("eventImpact: windows exclude the event day and percentages are honest", async () => {
  const result = await run(`{
    eventImpact(id: "protest_17_october", windowDays: 7) {
      candidate { id } before after changePct favorableAfter criticalAfter neutralAfter unclearAfter
    }
  }`);
  assert.deepEqual(result.errors, undefined);
  const rows = result.data.eventImpact;
  assert.ok(rows.length > 0);

  // Recompute one candidate by hand from the raw dataset.
  const event = dataset.events.events.find((item) => item.id === "protest_17_october")!;
  const start = new Date(`${event.commencement}T00:00:00Z`);
  const day = (iso: string | null) => (iso ? iso.slice(0, 10) : null);
  const add = (days: number) => new Date(start.valueOf() + days * 86_400_000).toISOString().slice(0, 10);
  const row = rows.find((item: any) => item.candidate.id === "lepen");
  const lepenVideos = dataset.videos.filter((video) => {
    const text = [video.caption ?? "", ...(video.on_screen_text ?? []), video.transcript ?? ""].join(" ");
    return /le\s*pen/i.test(text);
  });
  const before = lepenVideos.filter((video) => { const d = day(video.posted_at)!; return d >= add(-7) && d <= add(-1); }).length;
  const after = lepenVideos.filter((video) => { const d = day(video.posted_at)!; return d >= add(1) && d <= add(7); }).length;
  assert.equal(row.before, before);
  assert.equal(row.after, after);
  assert.equal(
    row.changePct,
    before === 0 ? null : Number((((after - before) / before) * 100).toFixed(1)),
  );
  // Leaning counts must sum to the after total.
  assert.equal(row.favorableAfter + row.criticalAfter + row.neutralAfter + row.unclearAfter, row.after);
});

test("issueGroups: every event appears exactly once", async () => {
  const result = await run(`{ issueGroups { majorIssue videos subIssues { subIssue videos events { id } topics { id videos } } } }`);
  assert.deepEqual(result.errors, undefined);
  const ids = result.data.issueGroups.flatMap((group: any) => group.subIssues.flatMap((sub: any) => sub.events.map((event: any) => event.id)));
  assert.equal(new Set(ids).size, ids.length, "an event is duplicated across groups");
  assert.equal(ids.length, dataset.events.events.length);
  assert.ok(result.data.issueGroups.every((group: any) => group.subIssues.length > 0));
});

test("video detail: verdicts carry verified evidence and honour held-out labels", async () => {
  const withVerdict = dataset.stance.find((row) => row.label !== "unclear")!;
  const result = await run(`query($id: ID!) { video(id: $id) { id url platform format verdicts { candidate { id } leaning verified heldOut quote } } }`, { id: withVerdict.video_id });
  assert.deepEqual(result.errors, undefined);
  const video = result.data.video;
  assert.ok(video.url.startsWith("http"));
  assert.ok(video.verdicts.length > 0);
  for (const verdict of video.verdicts) {
    if (verdict.heldOut) assert.equal(verdict.leaning, "UNCLEAR");
    // Directional labels always carry a quote. A NEUTRAL may be assigned by the
    // relevance rule (a candidate inside a list) and legitimately has none.
    if (verdict.leaning === "FAVORABLE" || verdict.leaning === "CRITICAL") {
      assert.ok(verdict.quote && verdict.quote.length > 0, "a directional stance must carry a quote");
    }
  }
});

test("search: lexical by default, descending, and reports its method", async () => {
  const result = await run(`{ search(query: "réforme des retraites", limit: 5) { score method video { id } } }`);
  assert.deepEqual(result.errors, undefined);
  const hits = result.data.search;
  assert.ok(hits.length > 0);
  assert.ok(hits.every((hit: any) => hit.method === "lexical"));
  const scores = hits.map((hit: any) => hit.score);
  assert.deepEqual(scores, [...scores].sort((a: number, b: number) => b - a));
});

test("creator: aggregates stance and lists its videos", async () => {
  const handle = dataset.stance.find((row) => row.creator_handle)!.creator_handle!;
  const result = await run(`query($h: String!) {
    creator(handle: $h) {
      handle
      videos(limit: 3) { id postedAt platform }
      stanceByCandidate { candidate { id } videos favorable critical neutral unclear stanceIndex label }
    }
  }`, { h: handle });
  assert.deepEqual(result.errors, undefined);
  assert.equal(result.data.creator.handle, handle);
  assert.ok(result.data.creator.videos.length > 0);
  for (const row of result.data.creator.stanceByCandidate) {
    assert.equal(row.favorable + row.critical + row.neutral + row.unclear, row.videos);
    assert.ok(Math.abs(row.stanceIndex) <= 1);
  }
});

test("bad input fails loudly: unknown field and unknown id", async () => {
  const unknown = await run("{ events { nope } }");
  assert.ok(unknown.errors?.length, "unknown field must be a validation error");
  const missing = await run(`{ event(id: "does_not_exist") { id } }`);
  assert.equal(missing.data.event, null);
});

test("HTTP: /healthz and a POST /graphql round-trip", async () => {
  const port = 8799;
  const child = spawn(process.execPath, ["src/server.ts"], {
    cwd: new URL("..", import.meta.url).pathname,
    env: { PATH: process.env.PATH, PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => (stderr += chunk));
  try {
    let health: any = null;
    for (let attempt = 0; attempt < 60; attempt++) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/healthz`);
        if (response.ok) {
          health = await response.json();
          break;
        }
      } catch {
        /* not up yet */
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(health, `server did not start: ${stderr}`);
    assert.equal(health.ok, true);
    assert.ok(health.videos > 100);

    const response = await fetch(`http://127.0.0.1:${port}/graphql`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "{ apiVersion events(filter: { limit: 2 }) { id } }" }),
    });
    assert.equal(response.status, 200);
    const payload: any = await response.json();
    assert.equal(payload.data.apiVersion, "0.1.0");
    assert.equal(payload.data.events.length, 2);
    assert.ok(payload.extensions.durationMs >= 0);
  } finally {
    child.kill("SIGTERM");
  }
});
