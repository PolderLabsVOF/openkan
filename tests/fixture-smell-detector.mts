// tests/fixture-smell-detector.mts — re-export from ok/fixture-detector.mts
//
// This file re-exports the fixture detector from the central location.
// The actual detection logic lives in ok/fixture-detector.mts to avoid
// import path issues when tests/windows-cli-entry.test.mjs copies
// ok/commands/task.ts into a tmpdir.

export { detectFixtureSmells, OWNERS_INCLUDES_AGENT_PATTERN, FIXTURE_PATTERNS } from "../ok/fixture-detector.mts";
export type { SmellDetection } from "../ok/fixture-detector.mts";
