// Re-export the canonical protocol types via a RELATIVE path: Node's native
// TypeScript loading refuses .ts files under node_modules, so the workspace
// alias (@connected/protocol) can't be used at runtime here. Same file, same
// types — just reached directly.

export * from "../../../packages/protocol/src/index.ts";
