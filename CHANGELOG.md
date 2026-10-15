# [2.0.0](https://github.com/fgiova/fastify-suspend-promise/compare/1.0.1...2.0.0) (2026-10-15)


* feat!: fail fast when subscribing to a suspended promise fails ([0bdfa47](https://github.com/fgiova/fastify-suspend-promise/commit/0bdfa47eff7d622721e5ad85f11901d7a34d6fab))


### BREAKING CHANGES

* suspendPromise() rejects on subscribe/GET errors;
previously the error was only delivered through the returned promise.

## [1.0.1](https://github.com/fgiova/fastify-suspend-promise/compare/1.0.0...1.0.1) (2026-10-15)


### Bug Fixes

* prevent unhandled rejection on unawaited suspended promises ([22ca0bd](https://github.com/fgiova/fastify-suspend-promise/commit/22ca0bd7cb75e7603a21fb2b5649d8c12d1c575c))

# 1.0.0 (2026-10-08)


### Features

* suspend promises until a Redis pub/sub signal resolves them ([24d3697](https://github.com/fgiova/fastify-suspend-promise/commit/24d369716f92b7b3f6cc721ef07774fe4867317b))
