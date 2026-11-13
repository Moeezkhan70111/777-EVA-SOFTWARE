// The release stays a draft until it is whole (releasePublication.mjs), tested against a fake
// GitHub. Run: node --test scripts/releasePublication.test.mjs

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ReleaseStop, draftProblems, findOrCreateDraft, planUploads, publishDraft, uploadAssets, verifyDraft } from "./releasePublication.mjs";

const TAG = "v0.6.0";

/** A GitHub that keeps releases in memory and records every call made to it. */
function fakeGitHub(releases = []) {
  const calls = [];
  let nextId = 100;
  const reply = (status, body) => ({ status, text: JSON.stringify(body) });
  const github = async (method, path, body) => {
    calls.push({ method, path, body });
    if (method === "GET" && path.startsWith("/releases?")) return reply(200, releases);
    if (method === "POST" && path === "/releases") {
      const release = { id: nextId++, tag_name: body.tag_name, name: body.name, draft: body.draft, assets: [] };
      releases.push(release);
      return reply(201, release);
    }
    const byId = /^\/releases\/(\d+)$/.exec(path);
    if (byId) {
      const release = releases.find((candidate) => candidate.id === Number(byId[1]));
      if (!release) return reply(404, { message: "Not Found" });
      if (method === "PATCH") Object.assign(release, { draft: body.draft });
      return reply(200, release);
    }
    const asset = /^\/releases\/assets\/(\d+)$/.exec(path);
    if (method === "DELETE" && asset) {
      for (const release of releases) release.assets = release.assets.filter((candidate) => candidate.id !== Number(asset[1]));
      return { status: 204, text: "" };
    }
    return reply(500, { message: `unexpected ${method} ${path}` });
  };
  return { github, calls, releases };
}

const asset = (id, name, size, state = "uploaded") => ({ id, name, size, state });
const expected = [
  { name: "777-ERP-Setup-0.6.0.exe", size: 1000 },
  { name: "777-ERP-Setup-0.6.0.exe.blockmap", size: 50 },
  { name: "latest.yml", size: 300 },
];
const uploads = expected.map(({ name, size }) => ({ as: name, size, from: name, type: "application/octet-stream" }));

describe("finding or creating the draft", () => {
  it("creates the release as a DRAFT, never public", async () => {
    const gh = fakeGitHub();
    const draft = await findOrCreateDraft({ github: gh.github, tag: TAG, name: "777 ERP 0.6.0" });
    assert.equal(draft.reused, false);
    const post = gh.calls.find((call) => call.method === "POST");
    assert.equal(post.body.draft, true);
    assert.equal(gh.releases[0].draft, true);
  });

  it("reuses an existing draft for the tag instead of creating a second one", async () => {
    const gh = fakeGitHub([{ id: 7, tag_name: TAG, draft: true, assets: [asset(1, "latest.yml", 300)] }]);
    const draft = await findOrCreateDraft({ github: gh.github, tag: TAG, name: "x" });
    assert.deepEqual({ id: draft.id, reused: draft.reused, assets: draft.assets.length }, { id: 7, reused: true, assets: 1 });
    assert.equal(gh.calls.some((call) => call.method === "POST"), false);
  });

  it("refuses a tag that is already published, changing nothing", async () => {
    const gh = fakeGitHub([{ id: 7, tag_name: TAG, draft: false, assets: [] }]);
    await assert.rejects(findOrCreateDraft({ github: gh.github, tag: TAG, name: "x" }), (error) => error instanceof ReleaseStop && /already published/.test(error.message));
    assert.equal(gh.calls.filter((call) => call.method !== "GET").length, 0);
  });

  it("refuses when two releases already exist for the tag, so assets cannot split", async () => {
    const gh = fakeGitHub([{ id: 7, tag_name: TAG, draft: true, assets: [] }, { id: 8, tag_name: TAG, draft: true, assets: [] }]);
    await assert.rejects(findOrCreateDraft({ github: gh.github, tag: TAG, name: "x" }), ReleaseStop);
  });
});

describe("uploading into a draft", () => {
  it("keeps an asset already whole, replaces a half-uploaded one, and uploads what is missing", () => {
    const plan = planUploads([asset(1, "777-ERP-Setup-0.6.0.exe", 1000), asset(2, "777-ERP-Setup-0.6.0.exe.blockmap", 50, "starter")], uploads);
    assert.deepEqual(plan.map((step) => step.action), ["SKIP", "REPLACE", "UPLOAD"]);
  });

  it("replaces an asset of the wrong size rather than trusting it", () => {
    const plan = planUploads([asset(1, "latest.yml", 299)], uploads);
    assert.equal(plan.find((step) => step.as === "latest.yml").action, "REPLACE");
  });

  it("stops at a refused upload, so the release stays an invisible draft", async () => {
    const gh = fakeGitHub([{ id: 7, tag_name: TAG, draft: true, assets: [] }]);
    const sent = [];
    const uploadAsset = async (name) => {
      sent.push(name);
      return name === "777-ERP-Setup-0.6.0.exe.blockmap" ? { status: 502, text: "Bad Gateway" } : { status: 201, text: "{}" };
    };
    await assert.rejects(uploadAssets({ github: gh.github, uploadAsset, existingAssets: [], uploads }), /stays a draft/);
    assert.deepEqual(sent, ["777-ERP-Setup-0.6.0.exe", "777-ERP-Setup-0.6.0.exe.blockmap"]);
    assert.equal(gh.releases[0].draft, true);
  });
});

describe("verifying the draft before it is published", () => {
  const whole = () => ({ tag_name: TAG, draft: true, assets: expected.map(({ name, size }, index) => asset(index, name, size)) });

  it("finds nothing wrong with a whole draft", () => {
    assert.deepEqual(draftProblems(whole(), { tag: TAG, expected }), []);
  });

  it("names every way a draft can be incomplete", () => {
    const release = whole();
    release.assets = [asset(0, "777-ERP-Setup-0.6.0.exe", 999), asset(1, "777-ERP-Setup-0.6.0.exe.blockmap", 50, "starter")];
    const problems = draftProblems(release, { tag: TAG, expected });
    assert.equal(problems.length, 3);
    assert.match(problems.join("\n"), /999 bytes on GitHub/);
    assert.match(problems.join("\n"), /not fully uploaded/);
    assert.match(problems.join("\n"), /latest\.yml is missing/);
  });

  it("refuses an empty asset and a draft for the wrong tag", () => {
    const release = whole();
    release.tag_name = "v0.5.9";
    release.assets[2].size = 0;
    const problems = draftProblems(release, { tag: TAG, expected });
    assert.match(problems.join("\n"), /not v0\.6\.0/);
    assert.match(problems.join("\n"), /latest\.yml is empty/);
  });

  it("never publishes an incomplete draft: verify stops before any PATCH", async () => {
    const gh = fakeGitHub([{ id: 7, tag_name: TAG, draft: true, assets: [asset(1, "777-ERP-Setup-0.6.0.exe", 1000)] }]);
    await assert.rejects(verifyDraft({ github: gh.github, releaseId: 7, tag: TAG, expected }), /NOT published/);
    assert.equal(gh.calls.some((call) => call.method === "PATCH"), false);
    assert.equal(gh.releases[0].draft, true);
  });
});

describe("publishing", () => {
  it("runs the whole order: draft, upload, verify, and only then public", async () => {
    const gh = fakeGitHub();
    const draft = await findOrCreateDraft({ github: gh.github, tag: TAG, name: "777 ERP 0.6.0" });
    const uploadAsset = async (name, upload) => {
      gh.releases[0].assets.push(asset(gh.releases[0].assets.length + 1, name, upload.size));
      assert.equal(gh.releases[0].draft, true, "nothing may be public while uploading");
      return { status: 201, text: "{}" };
    };
    await uploadAssets({ github: gh.github, uploadAsset, existingAssets: draft.assets, uploads });
    await verifyDraft({ github: gh.github, releaseId: draft.id, tag: TAG, expected });
    const published = await publishDraft({ github: gh.github, releaseId: draft.id, tag: TAG });
    assert.equal(published.draft, false);
    const patch = gh.calls.find((call) => call.method === "PATCH");
    assert.deepEqual(patch.body, { draft: false, make_latest: "true" });
    assert.equal(gh.calls.indexOf(patch), gh.calls.length - 1, "making it public is the last call");
  });

  it("reports a publish GitHub refused, leaving the complete draft for a person to publish", async () => {
    const github = async () => ({ status: 422, text: '{"message":"Validation Failed"}' });
    await assert.rejects(publishDraft({ github, releaseId: 7, tag: TAG }), /publish it on GitHub by hand/);
  });
});
