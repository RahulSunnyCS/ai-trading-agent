import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import type { Clock } from "../../utils/clock.js";

/**
 * Options passed in when the plugin is registered via fastify.register().
 * clock is required because the /health route returns clock.now() — this lets
 * tests inject a FixedClock for a deterministic response.
 */
export interface StatusRoutesOptions {
  clock: Clock;
}

/**
 * Fastify plugin that mounts the /health status endpoint.
 *
 * Exported as a named export (no default exports per project convention).
 *
 * The response schema is defined inline using Fastify's native JSON Schema
 * format (not Zod) to keep the dependency surface minimal and allow Fastify's
 * built-in AJV serializer to validate and fast-serialize the response.
 */
export const statusRoutes: FastifyPluginAsync<StatusRoutesOptions> = async (
  fastify: FastifyInstance,
  opts: StatusRoutesOptions,
): Promise<void> => {
  fastify.get(
    "/health",
    {
      schema: {
        response: {
          200: {
            type: "object",
            properties: {
              status: { type: "string" },
              // time is epoch-ms from clock.now() — a JS number (integer).
              time: { type: "number" },
            },
            required: ["status", "time"],
          },
        },
      },
    },
    async (_request, _reply) => {
      return { status: "ok", time: opts.clock.now() };
    },
  );
};
