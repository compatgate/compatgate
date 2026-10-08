// The napi-rs loader picks the native binary or the WASI build for the current platform.
export * as binding from '../binding.js';
// binding.js also exports the value objects `FindingKind`, `FindingConfidence`, `AllowIssueKind` and
// `ParseErrorKind`: napi registers string enums at run time. They are not part of the public API, and
// binding.d.ts declares them as string unions only.
