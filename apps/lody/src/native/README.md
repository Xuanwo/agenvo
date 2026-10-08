# Native Lody local transport

These two files are adapted from `packages/shared/src/local-loro-{data-plane,transport}.ts` in LodyAI/Lody at `a8aa4c221e9a0f6f80f6e69cb5e72718fcf66576` (Apache-2.0). Attribution is in the repository NOTICE and source headers.

Local changes: ES module import suffix, repository formatting, and `LocalLoroTransportAdapter.confirmRoom`. Confirmation uses a separate read-only peer to compare the daemon frontier against the captured write frontier; it acknowledges import into daemon memory, not disk persistence. The rest of the native room reconciliation, chunking and reconnect behavior is retained.

The upstream workspace package is unpublished. Update these files together against the native wire schema and run `tests/lody-local.test.ts` plus `tests/system/lody-events.test.ts`. CLI version numbers are not runtime compatibility gates; the negotiated wire protocol is.
