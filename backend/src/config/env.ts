import { z } from "zod";

const bool = z.preprocess((v) => (typeof v === "string" ? v.toLowerCase() === "true" : v), z.boolean());

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().default(4000),
  DEVICE_PORT: z.coerce.number().default(8081), // separate listener for device push traffic
  DATABASE_URL: z.string().min(1),
  JWT_ACCESS_SECRET: z.string().min(32, "JWT_ACCESS_SECRET must be at least 32 chars"),
  ACCESS_TOKEN_TTL_SEC: z.coerce.number().default(900),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().default(7),
  DATA_ENCRYPTION_KEY: z.string().regex(/^[0-9a-f]{64}$/i, "DATA_ENCRYPTION_KEY must be 32 bytes hex"),
  CORS_ORIGIN: z.string().default("http://localhost:5173"),
  TRUST_PROXY_HOPS: z.coerce.number().default(1),
  DEFAULT_TIMEZONE: z.string().default("Asia/Manila"),
  DEVICE_ONLINE_THRESHOLD_SEC: z.coerce.number().default(180),
  DEVICE_MONITOR_INTERVAL_SEC: z.coerce.number().default(60),
  ALLOW_MOCK_DEVICES: bool.default(false),
  LOG_LEVEL: z.string().default("info"),
});

export type Env = z.infer<typeof schema>;

let cached: Env | undefined;
export function env(): Env {
  if (!cached) {
    const parsed = schema.safeParse(process.env);
    if (!parsed.success) {
      // Fail fast: never start with weak or missing secrets.
      const msg = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("\n");
      throw new Error(`Invalid environment configuration:\n${msg}`);
    }
    if (parsed.data.NODE_ENV === "production" && parsed.data.ALLOW_MOCK_DEVICES) {
      throw new Error("ALLOW_MOCK_DEVICES must be false in production");
    }
    cached = parsed.data;
  }
  return cached;
}
