# fastify suspend-promise
[![NPM version](https://img.shields.io/npm/v/@fgiova/fastify-suspend-promise.svg?style=flat)](https://www.npmjs.com/package/@fgiova/fastify-suspend-promise)
![CI workflow](https://github.com/fgiova/fastify-suspend-promise/actions/workflows/node.js.yml/badge.svg)
[![TypeScript](https://img.shields.io/badge/%3C%2F%3E-TypeScript-%230074c1.svg)](http://www.typescriptlang.org/)
[![Linted with Biome](https://img.shields.io/badge/Linted_with-Biome-60a5fa?style=flat&logo=biome)](https://biomejs.dev)
[![Maintainability](https://qlty.sh/gh/fgiova/projects/fastify-suspend-promise/maintainability.svg)](https://qlty.sh/gh/fgiova/projects/fastify-suspend-promise)
[![Code Coverage](https://qlty.sh/gh/fgiova/projects/fastify-suspend-promise/coverage.svg)](https://qlty.sh/gh/fgiova/projects/fastify-suspend-promise)

## Description
This plugin for fastify 5.x lets you suspend a promise until a Redis pub/sub signal resolves or rejects it.
The signal can come from the same process or from any other process connected to the same Redis (e.g. another pod),
so a request can wait for work completed elsewhere.

Promises are identified by name. Names can be deterministic (e.g. `job:123`): a result published before the waiter
subscribed is not lost, because every resolution is also stored in Redis for a short time and read back after subscribing.

## Install
```bash
npm i @fgiova/fastify-suspend-promise ioredis
```

`ioredis` is a peer dependency: the plugin uses its types and accepts `ioredis` clients through the `connections` option.

## Usage

### ESM
```js
import fastify from "fastify";
import suspendPromise from "@fgiova/fastify-suspend-promise";

const app = fastify();

app.register(suspendPromise, {
    defaultTimeoutMs: 60_000,
    redis: {
        url: "redis://localhost:6379"
    }
});

// waiting side
app.post("/jobs/:id", async (request) => {
    const { promise } = await app.suspendPromise(`job:${request.params.id}`);
    // Promise.all attaches the handler before the job can complete
    const [result] = await Promise.all([promise, enqueueJob(request.params.id)]);
    return result;
});

// resolving side, in this or any other process
await app.resolveSuspendedPromise(`job:${id}`, { response: { status: "done" } });
// or reject it
await app.resolveSuspendedPromise(`job:${id}`, { error: "job failed" });
```

### CommonJS
```js
const fastify = require("fastify")();

fastify.register(require("@fgiova/fastify-suspend-promise").default, {
    redis: {
        url: "redis://localhost:6379"
    }
});
```

## Options

| Option            | Type                                       | Description                                                                                                                                                                                    |
|-------------------|--------------------------------------------|------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| defaultTimeoutMs  | number                                     | Timeout applied when `suspendPromise` is called without one. Default: 30000ms.                                                                                                                 |
| channelPrefix     | string                                     | Prefix added, followed by `:`, to the Redis channel and result key of every promise (e.g. `app` → `app:<promiseName>`). Instances that share promises must use the same prefix. Default: none. |
| redis.url         | string                                     | Redis URL used to create the publisher and subscriber connections.                                                                                                                             |
| redis.namespaces  | {publisher: string, subscriber: string}    | [@fastify/redis](https://github.com/fastify/fastify-redis) namespaces of the two connections. Default: `{ publisher: "publisher", subscriber: "subscriber" }`.                                 |
| redis.connections | {publisher: Redis, subscriber: Redis}      | Already created `ioredis` clients. The plugin does not close them.                                                                                                                             |

### Redis connections

Pub/sub needs a dedicated subscriber connection: a Redis connection in subscriber mode cannot run other commands.
The plugin picks the connections in this order:

1. `redis.connections`: the given clients are used as they are. Use two different clients.
2. An existing `fastify.redis` (registered with [@fastify/redis](https://github.com/fastify/fastify-redis) before this plugin):
   the publisher reuses it, the subscriber is a `duplicate()` of it, closed on fastify shutdown.
   Namespaces already registered with the configured names are reused as they are.
3. `redis.url`: two connections are registered with @fastify/redis under the configured namespaces and closed on fastify shutdown.

If none of them is available the plugin fails to load with `Redis is not configured`.

## Decorators

### suspendPromise(promiseName?, timeoutMs?)

```ts
fastify.suspendPromise<T>(promiseName?: string, timeoutMs?: number): Promise<SuspendedPromise<T>>
```

Subscribes to the promise channel and returns once the subscription is active, so a resolution published
after this call returns is always received.

| Param       | Description                                                                          |
|-------------|--------------------------------------------------------------------------------------|
| promiseName | Name of the promise, used as Redis channel. Default: `promise:<random uuid>`.        |
| timeoutMs   | Time after which the promise is rejected. Default: `defaultTimeoutMs` option.        |

The returned `SuspendedPromise<T>` has:

| Property    | Type                                              | Description                                                            |
|-------------|---------------------------------------------------|------------------------------------------------------------------------|
| promiseName | string                                            | Name of the promise.                                                   |
| promise     | Promise\<T\>                                      | Resolved with `response` or rejected with `error`.                     |
| resolver    | (message: SuspendMessage\<T\>) => Promise\<void\> | Shortcut for `resolveSuspendedPromise(promiseName, message)`.          |
| cleanup     | () => void                                        | Stops waiting and rejects the promise.                                 |

### resolveSuspendedPromise(promiseName, message)

```ts
fastify.resolveSuspendedPromise<T>(promiseName: string, message: SuspendMessage<T>): Promise<void>

type SuspendMessage<T> = { error: string } | { response: T };
```

Resolves (`{ response }`) or rejects (`{ error }`) every promise suspended with that name, in any process.
It does not need to know the waiting process: this is the function to call from other pods.
Publish errors are logged, not thrown.

### getSuspendedPromise(promiseName)

```ts
fastify.getSuspendedPromise(promiseName: string): Promise<unknown> | undefined
```

Returns the promise suspended with that name **in the current process**, or `undefined`.
Promises cannot be shared between processes: use `suspendPromise` with the same name to wait on another process.

## Behavior

- **Same name, same process**: callers of `suspendPromise` with a name already waiting share the same promise and the same subscription.
  `cleanup()` called by any of them rejects the promise for all of them.
- **Stored result**: every resolution is stored in the `<channelPrefix>:<promiseName>:result` key with a 10 seconds TTL.
  A waiter subscribing within that time resolves immediately with the stored result,
  so reusing a name within 10 seconds returns the previous result.
- **Rejections**: the promise is rejected with:
  - the `error` string of the message;
  - `Timed out waiting for promise <name> response` on timeout;
  - `Promise <name> was cleaned up` on `cleanup()` and on fastify shutdown;
  - `Invalid message received` for a message without `response` or `error`;
  - a `SyntaxError` for a message that is not valid JSON.
- **Attach handlers early**: the promise can settle as soon as `suspendPromise` returns.
  Await it (or attach `.catch`) before awaiting other work, otherwise a rejection is reported as unhandled.
- **Timeout timer**: the timer is `unref`'d, it does not keep the process alive on its own.
- **Payload**: messages are serialized with JSON: `Date` becomes a string, errors carry only their message.
- **Channel names**: the Redis channel is `<channelPrefix>:<promiseName>`, or `<promiseName>` without a prefix. Without a prefix, choose names that do not collide with other pub/sub users.
  The prefix also appears in the timeout and cleanup error messages, which use the channel name.

## License
Licensed under [MIT](./LICENSE).
