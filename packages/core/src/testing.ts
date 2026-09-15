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
/**
 * The ONNX-free {@link EmbeddingProvider} double.
 *
 * It lives on this subpath rather than the main entry point for the same reason
 * `FakeClock` does: it is not an embedding model and must never end up
 * configured as one in a real proxy. ADR-003 put the real runtime in an
 * optional companion package because `onnxruntime-node` unpacks to ~301 MB, so
 * this is how CI and `bench/` exercise the whole semantic path — queue, window,
 * detector, breaker hand-off — while installing nothing.
 */
export { HashingProvider } from './loop/hashing-provider.js';
