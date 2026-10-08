import { type Test, test } from "tap";
// biome-ignore lint/suspicious/noTsIgnore: is a Test file
// @ts-ignore
import "../helpers/localtest";
import { setTimeout } from "node:timers/promises";
import fastifyRedis from "@fastify/redis";
import Fastify, { type FastifyInstance } from "fastify";
import { Redis } from "ioredis";
// biome-ignore lint/suspicious/noTsIgnore: is a Test file
// @ts-ignore
import suspendPromise from "../../src";

const redisUrl = process.env.REDIS_URL as string;

const gate = () => {
	let open!: () => void;
	const wait = new Promise<void>((resolve) => {
		open = resolve;
	});
	return { open, wait };
};

test("suspend-promise", async (t) => {
	const redis = new Redis(redisUrl);

	t.teardown(async () => {
		redis.disconnect();
		process.exit(0);
	});

	const connections = (t: Test) => {
		const publisher = new Redis(redisUrl);
		const subscriber = new Redis(redisUrl);
		t.teardown(() => {
			publisher.disconnect();
			subscriber.disconnect();
		});
		return { publisher, subscriber };
	};

	const captureErrors = (t: Test, app: FastifyInstance) => {
		const errors: string[] = [];
		const original = app.log.error;
		app.log.error = ((_obj: unknown, msg: string) => {
			errors.push(msg);
		}) as typeof app.log.error;
		t.teardown(() => {
			app.log.error = original;
		});
		return errors;
	};

	t.beforeEach(async (t) => {
		await redis.flushall();
		const app = Fastify({
			logger: false,
		});
		t.context = {
			app,
		};
	});

	t.afterEach(async (t) => {
		try {
			await t.context.app.close();
		} catch (e) {
			console.error(e);
		}
	});

	await t.test("plugin definition with url", async (t) => {
		const { app } = t.context as { app: FastifyInstance };
		app.register(suspendPromise, { redis: { url: redisUrl } });
		await t.resolves(app.ready() as unknown as Promise<FastifyInstance>);
		t.ok(app.suspendPromise);
		t.ok(app.resolveSuspendedPromise);
		t.ok(app.getSuspendedPromise);
		t.not(app.redis.publisher, app.redis.subscriber);
	});

	await t.test("plugin definition without redis", async (t) => {
		const { app } = t.context as { app: FastifyInstance };
		app.register(suspendPromise, {});
		await t.rejects(async () => app.ready(), /Redis is not configured/);
	});

	await t.test("plugin definition with custom namespaces", async (t) => {
		const { app } = t.context as { app: FastifyInstance };
		app.register(suspendPromise, {
			redis: {
				url: redisUrl,
				namespaces: { publisher: "pub", subscriber: "sub" },
			},
		});
		await app.ready();
		t.ok(app.redis.pub);
		t.ok(app.redis.sub);
		const waiter = await app.suspendPromise("namespaces");
		await waiter.resolver({ response: 1 });
		t.equal(await waiter.promise, 1);
	});

	await t.test("plugin reuses an existing fastify.redis client", async (t) => {
		const { app } = t.context as { app: FastifyInstance };
		app.register(fastifyRedis, { url: redisUrl, closeClient: true });
		app.register(suspendPromise, {});
		await app.ready();
		t.equal(app.redis.publisher, app.redis);
		t.not(app.redis.subscriber, app.redis);

		const waiter = await app.suspendPromise("existing");
		t.equal(await app.redis.set("user-key", "1"), "OK");
		await app.resolveSuspendedPromise("existing", { response: "done" });
		t.equal(await waiter.promise, "done");

		const subscriber = app.redis.subscriber;
		await app.close();
		t.equal(subscriber.status, "end");
	});

	await t.test("plugin reuses pre-registered namespaces", async (t) => {
		const { app } = t.context as { app: FastifyInstance };
		app.register(fastifyRedis, { url: redisUrl, closeClient: true });
		app.register(fastifyRedis, {
			url: redisUrl,
			namespace: "publisher",
			closeClient: true,
		});
		app.register(fastifyRedis, {
			url: redisUrl,
			namespace: "subscriber",
			closeClient: true,
		});
		app.register(suspendPromise, {});
		await app.ready();
		const waiter = await app.suspendPromise("pre-registered");
		await waiter.resolver({ response: "ok" });
		t.equal(await waiter.promise, "ok");
	});

	await t.test("suspend with generated name", async (t) => {
		const { app } = t.context as { app: FastifyInstance };
		app.register(suspendPromise, { redis: { url: redisUrl } });
		await app.ready();
		const waiter = await app.suspendPromise();
		t.match(waiter.promiseName, /^promise:[0-9a-f-]{36}$/);
		await waiter.resolver({ response: true });
		t.equal(await waiter.promise, true);
	});

	await t.test("resolve with response", async (t) => {
		const { app } = t.context as { app: FastifyInstance };
		app.register(suspendPromise, { redis: { url: redisUrl } });
		await app.ready();
		const waiter = await app.suspendPromise<{ id: number }>("resolve");
		await app.resolveSuspendedPromise("resolve", { response: { id: 1 } });
		t.same(await waiter.promise, { id: 1 });
		t.equal(app.getSuspendedPromise("resolve"), undefined);
		await setTimeout(50);
		t.same(await redis.pubsub("NUMSUB", "resolve"), ["resolve", 0]);
		t.ok((await redis.ttl("resolve:result")) > 0);
	});

	await t.test("resolve with falsy response", async (t) => {
		const { app } = t.context as { app: FastifyInstance };
		app.register(suspendPromise, { redis: { url: redisUrl } });
		await app.ready();
		const waiter = await app.suspendPromise("falsy");
		await waiter.resolver({ response: 0 });
		t.equal(await waiter.promise, 0);
	});

	await t.test("reject with error", async (t) => {
		const { app } = t.context as { app: FastifyInstance };
		app.register(suspendPromise, { redis: { url: redisUrl } });
		await app.ready();
		const waiter = await app.suspendPromise("error");
		const rejected = t.rejects(waiter.promise, { message: "remote failure" });
		await waiter.resolver({ error: "remote failure" });
		await rejected;
	});

	await t.test("reject invalid message", async (t) => {
		const { app } = t.context as { app: FastifyInstance };
		app.register(suspendPromise, { redis: { url: redisUrl } });
		await app.ready();
		const waiter = await app.suspendPromise("invalid");
		const rejected = t.rejects(waiter.promise, {
			message: "Invalid message received",
		});
		await redis.publish("invalid", JSON.stringify({ foo: 1 }));
		await rejected;
	});

	await t.test("reject non JSON message", async (t) => {
		const { app } = t.context as { app: FastifyInstance };
		app.register(suspendPromise, { redis: { url: redisUrl } });
		await app.ready();
		const waiter = await app.suspendPromise("not-json");
		const rejected = t.rejects(waiter.promise, SyntaxError);
		await redis.publish("not-json", "not json");
		await rejected;
	});

	await t.test("messages for other promises are ignored", async (t) => {
		const { app } = t.context as { app: FastifyInstance };
		app.register(suspendPromise, { redis: { url: redisUrl } });
		await app.ready();
		const first = await app.suspendPromise("first");
		const second = await app.suspendPromise("second");
		await second.resolver({ response: "second" });
		t.equal(await second.promise, "second");
		t.equal(app.getSuspendedPromise("first"), first.promise);
		await first.resolver({ response: "first" });
		t.equal(await first.promise, "first");
	});

	await t.test("result published before subscribe", async (t) => {
		const { app } = t.context as { app: FastifyInstance };
		app.register(suspendPromise, { redis: { url: redisUrl } });
		await app.ready();
		await app.resolveSuspendedPromise("early", { response: "early" });
		const waiter = await app.suspendPromise("early");
		t.equal(await waiter.promise, "early");
	});

	await t.test("channel prefix", async (t) => {
		const { app } = t.context as { app: FastifyInstance };
		const unprefixed = Fastify({ logger: false });
		t.teardown(() => unprefixed.close());
		app.register(suspendPromise, {
			channelPrefix: "app",
			redis: { url: redisUrl },
		});
		unprefixed.register(suspendPromise, { redis: { url: redisUrl } });
		await Promise.all([app.ready(), unprefixed.ready()]);

		const waiter = await app.suspendPromise("prefixed");
		t.equal(waiter.promiseName, "prefixed");
		t.equal(app.getSuspendedPromise("prefixed"), waiter.promise);
		t.same(await redis.pubsub("NUMSUB", "app:prefixed"), ["app:prefixed", 1]);

		await unprefixed.resolveSuspendedPromise("prefixed", {
			response: "wrong",
		});
		t.equal(app.getSuspendedPromise("prefixed"), waiter.promise);

		await waiter.resolver({ response: "right" });
		t.equal(await waiter.promise, "right");
		t.ok((await redis.ttl("app:prefixed:result")) > 0);
	});

	await t.test("waiters with the same name share the promise", async (t) => {
		const { app } = t.context as { app: FastifyInstance };
		app.register(suspendPromise, { redis: { url: redisUrl } });
		await app.ready();
		const first = await app.suspendPromise("shared");
		const second = await app.suspendPromise("shared");
		t.equal(second.promise, first.promise);
		t.same(await redis.pubsub("NUMSUB", "shared"), ["shared", 1]);
		await second.resolver({ response: "both" });
		t.equal(await first.promise, "both");
	});

	await t.test("promise resolved by another instance", async (t) => {
		const { app } = t.context as { app: FastifyInstance };
		const other = Fastify({ logger: false });
		t.teardown(() => other.close());
		app.register(suspendPromise, { redis: { url: redisUrl } });
		other.register(suspendPromise, { redis: { url: redisUrl } });
		await Promise.all([app.ready(), other.ready()]);
		const waiter = await app.suspendPromise("cross-instance");
		await other.resolveSuspendedPromise("cross-instance", {
			response: "from another pod",
		});
		t.equal(await waiter.promise, "from another pod");
	});

	await t.test("timeout per call", async (t) => {
		const { app } = t.context as { app: FastifyInstance };
		app.register(suspendPromise, { redis: { url: redisUrl } });
		await app.ready();
		const waiter = await app.suspendPromise("timeout", 50);
		await t.rejects(waiter.promise, {
			message: "Timed out waiting for promise timeout response",
		});
		t.equal(app.getSuspendedPromise("timeout"), undefined);
	});

	await t.test("timeout from defaultTimeoutMs", async (t) => {
		const { app } = t.context as { app: FastifyInstance };
		app.register(suspendPromise, {
			defaultTimeoutMs: 50,
			redis: { url: redisUrl },
		});
		await app.ready();
		const waiter = await app.suspendPromise("default-timeout");
		await t.rejects(waiter.promise, { message: /Timed out/ });
	});

	await t.test("cleanup rejects the pending promise", async (t) => {
		const { app } = t.context as { app: FastifyInstance };
		app.register(suspendPromise, { redis: { url: redisUrl } });
		await app.ready();
		const waiter = await app.suspendPromise("cleanup");
		const rejected = t.rejects(waiter.promise, {
			message: "Promise cleanup was cleaned up",
		});
		waiter.cleanup();
		await rejected;
		await setTimeout(50);
		t.same(await redis.pubsub("NUMSUB", "cleanup"), ["cleanup", 0]);
	});

	await t.test(
		"cleanup from a shared waiter rejects every waiter",
		async (t) => {
			const { app } = t.context as { app: FastifyInstance };
			app.register(suspendPromise, { redis: { url: redisUrl } });
			await app.ready();
			const first = await app.suspendPromise("shared-cleanup");
			const second = await app.suspendPromise("shared-cleanup");
			const rejected = t.rejects(first.promise, { message: /was cleaned up/ });
			second.cleanup();
			await rejected;
		},
	);

	await t.test(
		"late cleanup does not touch a newer waiter with the same name",
		async (t) => {
			const { app } = t.context as { app: FastifyInstance };
			app.register(suspendPromise, { redis: { url: redisUrl } });
			await app.ready();
			const old = await app.suspendPromise("reuse");
			await old.resolver({ response: "old" });
			t.equal(await old.promise, "old");
			await redis.del("reuse:result");

			const current = await app.suspendPromise("reuse");
			old.cleanup();
			await setTimeout(50);
			t.equal(app.getSuspendedPromise("reuse"), current.promise);
			t.same(await redis.pubsub("NUMSUB", "reuse"), ["reuse", 1]);

			await current.resolver({ response: "new" });
			t.equal(await current.promise, "new");
		},
	);

	await t.test("onClose rejects pending promises", async (t) => {
		const { app } = t.context as { app: FastifyInstance };
		app.register(suspendPromise, { redis: { url: redisUrl } });
		await app.ready();
		const waiter = await app.suspendPromise("close");
		const rejected = t.rejects(waiter.promise, { message: /was cleaned up/ });
		await app.close();
		await rejected;
	});

	await t.test(
		"stored result is ignored after cleanup during GET",
		async (t) => {
			const { app } = t.context as { app: FastifyInstance };
			const { publisher, subscriber } = connections(t);
			const getGate = gate();
			const originalGet = publisher.get.bind(publisher);
			publisher.get = (async (key: string) => {
				await getGate.wait;
				return originalGet(key);
			}) as typeof publisher.get;
			app.register(suspendPromise, {
				redis: { connections: { publisher, subscriber } },
			});
			await app.ready();
			await redis.set("get-race:result", JSON.stringify({ response: "late" }));

			const pending = app.suspendPromise("get-race");
			await setTimeout(50);
			const other = await app.suspendPromise("get-race");
			const rejected = t.rejects(other.promise, { message: /was cleaned up/ });
			other.cleanup();
			getGate.open();
			await pending;
			await rejected;
		},
	);

	await t.test("subscribe failure rejects the promise", async (t) => {
		const { app } = t.context as { app: FastifyInstance };
		const { publisher, subscriber } = connections(t);
		app.register(suspendPromise, {
			redis: { connections: { publisher, subscriber } },
		});
		await app.ready();
		subscriber.disconnect();
		const waiter = await app.suspendPromise("subscribe-fail");
		await t.rejects(waiter.promise, { message: /Connection is closed/ });
		t.equal(app.getSuspendedPromise("subscribe-fail"), undefined);
	});

	await t.test("subscribe failure is ignored after cleanup", async (t) => {
		const { app } = t.context as { app: FastifyInstance };
		const { publisher, subscriber } = connections(t);
		const subscribeGate = gate();
		const originalSubscribe = subscriber.subscribe.bind(subscriber);
		subscriber.subscribe = (async (channel: string) => {
			await subscribeGate.wait;
			return originalSubscribe(channel);
		}) as typeof subscriber.subscribe;
		app.register(suspendPromise, {
			redis: { connections: { publisher, subscriber } },
		});
		await app.ready();

		const pending = app.suspendPromise("subscribe-race");
		await setTimeout(10);
		const other = await app.suspendPromise("subscribe-race");
		const rejected = t.rejects(other.promise, { message: /was cleaned up/ });
		other.cleanup();
		subscriber.disconnect();
		subscribeGate.open();
		await pending;
		await rejected;
	});

	await t.test("unsubscribe failure is logged", async (t) => {
		const { app } = t.context as { app: FastifyInstance };
		const { publisher, subscriber } = connections(t);
		app.register(suspendPromise, {
			redis: { connections: { publisher, subscriber } },
		});
		await app.ready();
		const errors = captureErrors(t, app);
		const waiter = await app.suspendPromise("unsubscribe-fail");
		const rejected = t.rejects(waiter.promise, { message: /was cleaned up/ });
		subscriber.disconnect();
		waiter.cleanup();
		await rejected;
		await setTimeout(50);
		t.same(errors, [
			"Failed to unsubscribe from promise unsubscribe-fail channel",
		]);
	});

	await t.test("publish failure is logged", async (t) => {
		const { app } = t.context as { app: FastifyInstance };
		const { publisher, subscriber } = connections(t);
		app.register(suspendPromise, {
			redis: { connections: { publisher, subscriber } },
		});
		await app.ready();
		const errors = captureErrors(t, app);
		publisher.disconnect();
		await app.resolveSuspendedPromise("publish-fail", { response: 1 });
		t.same(errors, ["Failed to publish response for promise publish-fail"]);
	});
});
