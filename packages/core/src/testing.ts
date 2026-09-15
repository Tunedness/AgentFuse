/**
 * Test helpers, exposed as the `@agentfuse/core/testing` subpath.
 *
 * Kept off the main entry point so a production import of `@agentfuse/core`
 * cannot accidentally pull a fake clock into a real proxy. Everything here is
 * pure and dependency-free, like the rest of the package.
 */

export { type ApprovalVerdict, ScriptedApprovalGateway } from './adapters/approval.js';
export { FakeClock } from './adapters/clock.js';
export { RecordingTelemetrySink } from './adapters/telemetry.js';
export { CounterIdGenerator } from './adapters/ulid.js';
