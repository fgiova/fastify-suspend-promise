import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import type { Redis } from "ioredis";

export type FastifySuspendPromiseOptions = {
	defaultTimeoutMs?: number;
	channelPrefix?: string;
	redis?: {
		url?: string;
		namespaces?: {
			publisher: string;
			subscriber: string;
		};
		connections?: {
			publisher: Redis;
			subscriber: Redis;
		};
	};
};

export type SuspendMessage<T> = { error: string } | { response: T };

export type SuspendedPromise<T> = {
	promiseName: string;
	promise: Promise<T>;
	resolver: (message: SuspendMessage<T>) => Promise<void>;
	cleanup: () => void;
};

declare module "fastify" {
	interface FastifyInstance {
		suspendPromise<T = unknown>(
			promiseName?: string,
			timeoutMs?: number,
		): Promise<SuspendedPromise<T>>;
		resolveSuspendedPromise<T = unknown>(
			promiseName: string,
			message: SuspendMessage<T>,
		): Promise<void>;
		getSuspendedPromise(promiseName: string): Promise<unknown> | undefined;
	}
}

const resultKey = (promiseName: string) => `${promiseName}:result`;

async function bootstrapRedis(
	fastify: FastifyInstance,
	options: FastifySuspendPromiseOptions,
) {
	if (options.redis?.connections) {
		return options.redis.connections;
	}

	const namespaces = options.redis?.namespaces || {
		publisher: "publisher",
		subscriber: "subscriber",
	};

	if (!fastify.redis && options.redis?.url) {
		await fastify
			.register(import("@fastify/redis"), {
				url: options.redis.url,
				namespace: namespaces.publisher,
			})
			.register(import("@fastify/redis"), {
				url: options.redis.url,
				namespace: namespaces.subscriber,
			});
	} else if (fastify.redis) {
		if (!fastify.redis[namespaces.publisher]) {
			await fastify.register(import("@fastify/redis"), {
				client: fastify.redis,
				namespace: namespaces.publisher,
			});
		}
		if (!fastify.redis[namespaces.subscriber]) {
			const subscriberClient = fastify.redis.duplicate();
			fastify.addHook("onClose", async (_instance) => {
				await subscriberClient.quit();
			});
			await fastify.register(import("@fastify/redis"), {
				client: subscriberClient,
				namespace: namespaces.subscriber,
			});
		}
	} else {
		throw new Error(
			"Redis is not configured. Please provide a Redis URL or existing connections.",
		);
	}

	return {
		publisher: fastify.redis[namespaces.publisher],
		subscriber: fastify.redis[namespaces.subscriber],
	};
}

const promiseCache = new Map<
	string,
	{
		namedSymbol: symbol;
		promise: Promise<unknown>;
		settle: (raw: string) => void;
		abort: (err: Error) => void;
		cleanup: () => void;
	}
>();

function pendingPromiseController<T>(
	promiseName: string,
	subscriber: Redis,
	logger: FastifyBaseLogger,
	timeoutMs: number = 30_000,
) {
	let cleanup!: (rejectPromise?: boolean) => void;
	let abort!: (err: Error) => void;
	let settle!: (raw: string) => void;

	const namedSymbol = Symbol(promiseName);

	const isCached = () =>
		promiseCache.get(promiseName)?.namedSymbol === namedSymbol;

	const waitingPromise = new Promise<T>((resolve, reject) => {
		cleanup = (rejectPromise = true) => {
			if (!isCached()) {
				return;
			}
			clearTimeout(responseTimeout);
			subscriber.removeListener("message", onMessage);
			subscriber.unsubscribe(promiseName).catch((err) => {
				logger.error(
					{ err, promiseName },
					`Failed to unsubscribe from promise ${promiseName} channel`,
				);
			});
			if (rejectPromise) {
				reject(new Error(`Promise ${promiseName} was cleaned up`));
			}
			promiseCache.delete(promiseName);
		};

		abort = (err) => {
			if (!isCached()) {
				return;
			}
			cleanup(false);
			reject(err);
		};

		settle = (raw) => {
			if (!isCached()) {
				return;
			}
			cleanup(false);
			try {
				const message = JSON.parse(raw);
				if ("error" in message) {
					return reject(new Error(message.error));
				}

				if ("response" in message) {
					return resolve(message.response as T);
				}

				return reject(new Error("Invalid message received"));
			} catch (e) {
				return reject(e);
			}
		};

		const onMessage = async (channel: string, messageJson: string) => {
			if (channel !== promiseName) {
				return;
			}
			return settle(messageJson);
		};

		const responseTimeout = setTimeout(() => {
			cleanup(false);
			return reject(
				new Error(`Timed out waiting for promise ${promiseName} response`),
			);
		}, timeoutMs);
		responseTimeout.unref();

		subscriber.on("message", onMessage);
	});

	promiseCache.set(promiseName, {
		namedSymbol,
		abort,
		settle,
		promise: waitingPromise,
		cleanup,
	});

	return {
		abort,
		settle,
		promise: waitingPromise,
		cleanup,
	};
}

async function promiseResolver<T>(
	promiseName: string,
	message: { error: string } | { response: T },
	publisher: Redis,
	logger: FastifyBaseLogger,
) {
	const payload = JSON.stringify(message);
	try {
		await publisher
			.multi()
			.set(resultKey(promiseName), payload, "EX", 10)
			.publish(promiseName, payload)
			.exec();
	} catch (err) {
		logger.error(
			{ err, promiseName },
			`Failed to publish response for promise ${promiseName}`,
		);
	}

	return;
}

async function suspendPromise(
	fastify: FastifyInstance,
	options: FastifySuspendPromiseOptions,
) {
	const { publisher, subscriber } = await bootstrapRedis(fastify, options);
	const toChannel = (promiseName: string) =>
		`${options.channelPrefix ? `${options.channelPrefix}:` : ""}${promiseName}`;

	fastify.decorate(
		"suspendPromise",
		async <T>(promiseName?: string, timeoutMs?: number) => {
			promiseName = promiseName ?? (`promise:${crypto.randomUUID()}` as string);
			const channel = toChannel(promiseName);

			const cached = promiseCache.get(channel);

			const resolver = (response: { error: string } | { response: T }) =>
				promiseResolver(channel, response, publisher, fastify.log);

			if (cached) {
				return {
					promiseName,
					promise: cached.promise as Promise<T>,
					resolver,
					cleanup: () => {
						cached.cleanup();
					},
				};
			}

			const promise = pendingPromiseController<T>(
				channel,
				subscriber,
				fastify.log,
				timeoutMs ?? options.defaultTimeoutMs,
			);

			try {
				await subscriber.subscribe(channel);

				const stored = await publisher.get(resultKey(channel));
				if (stored !== null) {
					promise.settle(stored);
				}
			} catch (err) {
				promise.abort(err as Error);
			}

			return {
				promiseName,
				promise: promise.promise,
				resolver,
				cleanup: () => {
					promise.cleanup();
				},
			};
		},
	);

	fastify.decorate(
		"resolveSuspendedPromise",
		async <T>(
			promiseName: string,
			message: { error: string } | { response: T },
		) => {
			return promiseResolver(
				toChannel(promiseName),
				message,
				publisher,
				fastify.log,
			);
		},
	);

	fastify.decorate("getSuspendedPromise", (promiseName: string) => {
		return promiseCache.get(toChannel(promiseName))?.promise;
	});

	fastify.addHook("onClose", (_instance, done) => {
		const promises = Array.from(promiseCache.values());
		for (const { cleanup } of promises) {
			cleanup();
		}
		done();
	});
}

export default fp(suspendPromise, {
	fastify: "5.x",
	name: "@fgiova/fastify-suspend-promise",
});
