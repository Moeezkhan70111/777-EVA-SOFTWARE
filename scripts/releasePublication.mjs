// THE GITHUB RELEASE, AS A DRAFT UNTIL IT IS WHOLE (13 Nov 2026).
//
// THE BUG THIS FIXES. release.mjs used to create the release PUBLIC before packaging, then spend
// minutes building and uploading. For all of that time GitHub's "latest release" was a release
// with no latest.yml, and every office PC that checked was answered 404 — reported on screen as
// "No published version was found". Pressing Update in that window failed the same way.
//
// THE ORDER NOW:
//
//   1. find or create a DRAFT for the tag        findOrCreateDraft   (drafts are invisible to the PCs)
//   2. build and verify the installer            release.mjs
//   3. upload into the draft                     uploadAssets        (skips an asset already whole)
//   4. read the draft back: every asset present,
//      fully uploaded, the right size, the tag
//      and version right                         verifyDraft
//   5. only then make it public                  publishDraft        (draft=false, make_latest)
//
// A failure anywhere before 5 leaves a draft nobody's PC can see; re-running the workflow resumes
// it. Nothing is ever public before its installer and latest.yml are.
//
// RERUNS. GitHub's /releases/tags/{tag} lookup does not return drafts, so a rerun that relied on
// it would create a second draft for the same tag. The release LIST does include drafts (for a
// token with push access), so that is what is searched.
//
// Every function takes `github(method, path, body?) -> { status, text }` and throws ReleaseStop
// with a reason a person can act on. No token is ever put in a URL, a message or a log line.

export class ReleaseStop extends Error {
  constructor(reason, detail) {
    super(reason);
    this.name = "ReleaseStop";
    this.detail = detail;
  }
}

const ok = (response) => response.status >= 200 && response.status < 300;

const parse = (response, what) => {
  try {
    return JSON.parse(response.text);
  } catch {
    throw new ReleaseStop(`GitHub's answer about ${what} could not be read, so nothing was published.`, response.text);
  }
};

/**
 * The draft release for `tag`, reused when one exists, created when none does.
 *
 * Refuses when the tag is already PUBLIC (that version has shipped; uploading into it would change
 * what PCs are downloading) or when more than one release exists for it (the assets would split).
 */
export async function findOrCreateDraft({ github, tag, name }) {
  const listed = await github("GET", "/releases?per_page=100");
  if (!ok(listed)) throw new ReleaseStop("GitHub would not list the releases, so nothing was published.", listed.text);
  const matches = parse(listed, "the releases").filter((release) => release.tag_name === tag);

  if (matches.length > 1) {
    throw new ReleaseStop(
      `${String(matches.length)} releases already exist for ${tag}, so nothing was uploaded.`,
      "Delete the extra ones on GitHub (keep the one with the most assets) and run the workflow again."
    );
  }
  if (matches.length === 1) {
    const existing = matches[0];
    if (existing.draft !== true) {
      throw new ReleaseStop(`${tag} is already published (release ${String(existing.id)}), so nothing was changed.`, "That version has shipped. Release the next patch instead.");
    }
    return { id: existing.id, reused: true, assets: existing.assets ?? [] };
  }

  const created = await github("POST", "/releases", { tag_name: tag, name, draft: true, prerelease: false });
  if (!ok(created)) throw new ReleaseStop("the draft release could not be created, so nothing was published.", created.text);
  const release = parse(created, "the new draft");
  if (release.draft !== true || release.tag_name !== tag) {
    throw new ReleaseStop(`GitHub did not create a draft for ${tag} as asked. Check the releases page by hand before going further.`, created.text);
  }
  return { id: release.id, reused: false, assets: [] };
}

/**
 * What to do with each upload, given what a reused draft already carries.
 *
 *   UPLOAD   not there yet
 *   SKIP     there, fully uploaded and the same size: re-uploading would only risk it
 *   REPLACE  there but half-uploaded (state "starter") or a different size: delete, then upload
 */
export function planUploads(existingAssets, uploads) {
  return uploads.map((upload) => {
    const existing = existingAssets.find((asset) => asset.name === upload.as);
    if (!existing) return { ...upload, action: "UPLOAD" };
    if (existing.state === "uploaded" && existing.size === upload.size && upload.size > 0) return { ...upload, action: "SKIP", assetId: existing.id };
    return { ...upload, action: "REPLACE", assetId: existing.id };
  });
}

/**
 * Uploads what the plan says into the draft. `uploadAsset(name, upload)` does the POST to
 * uploads.github.com and answers `{ status, text }`. Stops at the first refusal.
 */
export async function uploadAssets({ github, uploadAsset, existingAssets, uploads, log = () => undefined }) {
  for (const planned of planUploads(existingAssets, uploads)) {
    if (planned.action === "SKIP") {
      log(`  ${planned.as} is already on the draft, whole — kept`);
      continue;
    }
    if (planned.action === "REPLACE") {
      const removed = await github("DELETE", `/releases/assets/${String(planned.assetId)}`);
      if (!ok(removed) && removed.status !== 404) throw new ReleaseStop(`the incomplete ${planned.as} on the draft could not be removed.`, removed.text);
    }
    const response = await uploadAsset(planned.as, planned);
    if (!ok(response)) throw new ReleaseStop(`${planned.as} was refused by GitHub (${String(response.status)}), so the release stays a draft.`, response.text);
    log(`  uploaded ${planned.as} (${(planned.size / (1024 * 1024)).toFixed(2)} MB)`);
  }
}

/** Every reason the draft is not ready to publish. Empty means it is. */
export function draftProblems(release, { tag, expected }) {
  const problems = [];
  if (release.tag_name !== tag) problems.push(`the draft is for ${String(release.tag_name)}, not ${tag}`);
  if (release.draft !== true) problems.push("the release is no longer a draft");
  const assets = release.assets ?? [];
  for (const { name, size } of expected) {
    const asset = assets.find((candidate) => candidate.name === name);
    if (!asset) problems.push(`${name} is missing`);
    else if (asset.state !== "uploaded") problems.push(`${name} is not fully uploaded (state ${String(asset.state)})`);
    else if (!(asset.size > 0)) problems.push(`${name} is empty`);
    else if (asset.size !== size) problems.push(`${name} is ${String(asset.size)} bytes on GitHub, ${String(size)} on disk`);
  }
  return problems;
}

/** Reads the draft back from GitHub and refuses to go on unless it is whole. */
export async function verifyDraft({ github, releaseId, tag, expected }) {
  const read = await github("GET", `/releases/${String(releaseId)}`);
  if (!ok(read)) throw new ReleaseStop("the draft could not be read back, so it was not published.", read.text);
  const problems = draftProblems(parse(read, "the draft"), { tag, expected });
  if (problems.length > 0) {
    throw new ReleaseStop(`the draft for ${tag} is not complete, so it was NOT published.`, `${problems.join("\n")}\n\nRun the workflow again: it resumes this draft.`);
  }
}

/** Makes the verified draft public and the latest release — the moment PCs can see it. */
export async function publishDraft({ github, releaseId, tag }) {
  const patched = await github("PATCH", `/releases/${String(releaseId)}`, { draft: false, make_latest: "true" });
  if (!ok(patched)) throw new ReleaseStop(`the draft for ${tag} could not be published. It is complete; publish it on GitHub by hand.`, patched.text);
  const release = parse(patched, "the published release");
  if (release.draft !== false || release.tag_name !== tag) {
    throw new ReleaseStop(`GitHub did not confirm ${tag} as published. Check the releases page by hand.`, patched.text);
  }
  return release;
}
