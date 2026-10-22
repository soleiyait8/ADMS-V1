import pino from "pino";

// Redact anything that could carry secrets or personal data.
export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  redact: {
    paths: [
      "req.headers.authorization",
      "req.headers.cookie",
      "res.headers['set-cookie']",
      "*.password",
      "*.passwordHash",
      "*.token",
      "*.refreshToken",
      "*.secret",
      "*.body",
    ],
    censor: "[redacted]",
  },
});
