const { GenericContainer, Wait } = require("testcontainers");

const startRedis = async () => {
	const redis = await new GenericContainer("redis:7-alpine")
		.withLabels({
			"org.testcontainers.reaper-session-id": process.env.REAPER_SESSION_ID, // This is mandatory for the reaper to clean up the container
		})
		.withExposedPorts(6379)
		.withWaitStrategy(Wait.forLogMessage("Ready to accept connections"))
		.start();
	return {
		container: redis,
		port: redis.getMappedPort(6379),
		host: redis.getHost(),
	};
};

module.exports = {
	startRedis,
};
