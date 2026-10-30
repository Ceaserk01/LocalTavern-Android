# Stage the existing frozen alpha.3 assets

This temporary branch is an upload transport. Do not merge its binary payload into main. It does not rebuild the application, move `v0.1.0-alpha.3`, replace any asset, or publish the draft.

Frozen source: `e557b2515f7c14afa7a9f66abb3cf3edce776e1d`. Existing draft: `428768489`. Owner/repository: `Ceaserk01/LocalTavern-Android`. Workflow branch: `codex/release-assembly`.

The two ~1.18 MB copy/literal patches reconstruct the exact signed APK bytes from the already public alpha.2 APKs. Local reconstruction matched both frozen alpha.3 SHA-256 values and passed `apksigner verify` with certificate digest `d2b4fe538d483bdea3bc80653f7d0e5fefa806ccd90dac63728a6f7574c3bfbe`. Inputs, output sizes, copy bounds and final SHA-256 are checked. No ZIP paths are extracted and no APK is executed.

The six other files are the already reviewed, frozen corresponding-source archive, provenance, validation, checksums and signature reports. They are copied verbatim, with fixed size/SHA checks. No private keys, account credentials or browser data are present.

The job grants `contents: write` only to the staging job and uses its temporary `GITHUB_TOKEN`. Authenticated calls are fixed to `api.github.com` and `uploads.github.com`; authenticated API redirects are rejected. Public base-APK downloads receive no token. The only write operation is POST of an absent allowlisted asset into the specified existing draft. Existing uploaded assets must match their size and server SHA-256; pending, failed, duplicate or unverified assets are deferred. There is no DELETE, PATCH, retag, draft creation or publication operation.

ARM upload is deferred by default even when the API lists no ARM asset: a browser storage transfer may still be live. Only change `ARM_MODE` to `allow` in a separate reviewed workflow commit after the owner confirms that browser transfer is terminal and any failed placeholder has been handled. Re-running an older job keeps its old frozen environment.

Tag resolution supports lightweight and annotated tags with a bounded, cycle-checked peel. A draft tag-name mismatch emits only bounded tag/source metadata and fails before writes; it must be investigated rather than silently retagged. The final report distinguishes successful partial staging from all eight files being verified. Publication remains a separate owner action.

Primary GitHub references checked 2026-10-30:

- [Release asset API](https://docs.github.com/en/rest/releases/assets): the release-specific upload URL, binary body, Content-Length, upload response and server digest; failed uploads may leave a `starter` asset. This helper deliberately leaves such assets untouched.
- [Release API](https://docs.github.com/en/rest/releases/releases): release-ID lookup and draft access.
- [Temporary job token and permissions](https://docs.github.com/en/actions/tutorials/authenticate-with-github_token): job-level permissions and authenticated API use.
- [Push workflow events](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#push): a branch push can run a workflow that has not been merged into the default branch.
- [Supported REST versions](https://docs.github.com/en/rest/about-the-rest-api/api-versions): the pinned `2022-11-28` API remains supported until 2028-03-10.
