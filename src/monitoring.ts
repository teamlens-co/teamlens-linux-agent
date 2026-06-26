import * as Sentry from "@sentry/browser";
import posthog from "posthog-js";

type ErrorContext = Record<string, string | number | boolean | null | undefined>;

const MAX_CONTEXT_LENGTH = 180;
const MAX_ERRORS_PER_MINUTE = 20;

let initialized = false;
let posthogEnabled = false;
let sentryEnabled = false;
let identifiedUserId: string | null = null;
let appVersion: string | null = null;
let originalConsoleError: typeof console.error | null = null;
let currentMinute = 0;
let errorsThisMinute = 0;
let isCapturingConsoleError = false;
const recentFingerprints = new Map<string, number>();

const cleanText = (value: unknown): string => {
  if (value instanceof Error) return value.message.slice(0, MAX_CONTEXT_LENGTH);
  if (typeof value === "string") return value.slice(0, MAX_CONTEXT_LENGTH);
  if (value == null) return "";
  return String(value).slice(0, MAX_CONTEXT_LENGTH);
};

const cleanContext = (context: ErrorContext = {}): ErrorContext => {
  const safe: ErrorContext = {
    app: "teamlens-desktop-agent",
    appVersion,
    platform: navigator.platform || "unknown",
  };

  for (const [key, value] of Object.entries(context)) {
    if (typeof value === "string") {
      safe[key] = value.slice(0, MAX_CONTEXT_LENGTH);
    } else {
      safe[key] = value;
    }
  }

  return safe;
};

const normalizeError = (error: unknown): Error => {
  if (error instanceof Error) return error;
  return new Error(cleanText(error) || "Unknown agent error");
};

const shouldCapture = (error: Error, context: ErrorContext): boolean => {
  const now = Date.now();
  const minute = Math.floor(now / 60_000);
  if (minute !== currentMinute) {
    currentMinute = minute;
    errorsThisMinute = 0;
  }
  if (errorsThisMinute >= MAX_ERRORS_PER_MINUTE) return false;

  const fingerprint = [
    context.source,
    context.feature,
    error.name,
    error.message,
  ].join("|");
  const lastSeen = recentFingerprints.get(fingerprint) ?? 0;
  if (now - lastSeen < 30_000) return false;

  recentFingerprints.set(fingerprint, now);
  errorsThisMinute += 1;
  return true;
};

export const setAgentMonitoringVersion = (version: string): void => {
  appVersion = version;
  if (sentryEnabled) {
    Sentry.setTag("appVersion", version);
  }
};

export const initAgentMonitoring = (): void => {
  if (initialized || typeof window === "undefined") return;

  const apiKey = import.meta.env.VITE_AGENT_POSTHOG_KEY || import.meta.env.VITE_POSTHOG_KEY;
  const apiHost =
    import.meta.env.VITE_AGENT_POSTHOG_HOST ||
    import.meta.env.VITE_POSTHOG_HOST ||
    "https://us.i.posthog.com";
  const sentryDsn = import.meta.env.VITE_AGENT_SENTRY_DSN?.trim();

  if (!apiKey && !sentryDsn) return;

  if (apiKey) {
    posthog.init(apiKey, {
      api_host: apiHost,
      defaults: "2026-01-30",
      person_profiles: "identified_only",
      capture_pageview: false,
      autocapture: false,
      disable_session_recording: true,
    });
    posthogEnabled = true;
  }

  if (sentryDsn) {
    Sentry.init({
      dsn: sentryDsn,
      environment: import.meta.env.MODE,
      tracesSampleRate: import.meta.env.PROD ? 0.1 : 1.0,
      beforeSend(event) {
        event.tags = {
          ...event.tags,
          app: "teamlens-desktop-agent",
          appVersion: appVersion ?? "unknown",
          platform: navigator.platform || "unknown",
        };
        return event;
      },
    });
    sentryEnabled = true;
  }

  initialized = true;

  window.addEventListener("error", (event) => {
    captureAgentException(event.error || event.message, {
      source: "window.onerror",
      filename: event.filename,
      lineno: event.lineno,
      colno: event.colno,
    });
  });

  window.addEventListener("unhandledrejection", (event) => {
    captureAgentException(event.reason, { source: "window.unhandledrejection" });
  });

  originalConsoleError = console.error.bind(console);
  console.error = (...args: unknown[]) => {
    originalConsoleError?.(...args);
    if (isCapturingConsoleError) return;
    isCapturingConsoleError = true;
    const errorArg = args.find((arg) => arg instanceof Error) ?? args[1] ?? args[0];
    try {
      captureAgentException(errorArg, {
        source: "console.error",
        message: cleanText(args[0]),
      });
    } finally {
      isCapturingConsoleError = false;
    }
  };
};

export const identifyAgentUser = (payload: {
  userId: string;
  organizationId?: string;
  organizationName?: string;
}): void => {
  if (!initialized) return;
  identifiedUserId = payload.userId;
  if (posthogEnabled) {
    posthog.identify(payload.userId, {
      organizationId: payload.organizationId,
      organizationName: payload.organizationName,
      app: "teamlens-desktop-agent",
      appVersion,
    });
  }
  if (sentryEnabled) {
    Sentry.setUser({
      id: payload.userId,
      organizationId: payload.organizationId,
      organizationName: payload.organizationName,
    });
  }
};

export const resetAgentMonitoringUser = (): void => {
  if (!initialized || !identifiedUserId) return;
  identifiedUserId = null;
  if (posthogEnabled) {
    posthog.reset();
  }
  if (sentryEnabled) {
    Sentry.setUser(null);
  }
};

export const captureAgentException = (error: unknown, context: ErrorContext = {}): void => {
  if (!initialized) return;

  const normalized = normalizeError(error);
  const safeContext = cleanContext(context);
  if (!shouldCapture(normalized, safeContext)) return;

  if (sentryEnabled) {
    Sentry.captureException(normalized, {
      extra: safeContext,
      tags: {
        source: cleanText(safeContext.source),
        feature: cleanText(safeContext.feature),
      },
    });
  }

  const client = posthog as typeof posthog & {
    captureException?: (error: unknown, properties?: Record<string, unknown>) => void;
  };

  if (posthogEnabled && typeof client.captureException === "function") {
    client.captureException(normalized, safeContext);
  } else if (posthogEnabled) {
    posthog.capture("agent_exception", {
      ...safeContext,
      errorName: normalized.name,
      errorMessage: normalized.message,
      stack: normalized.stack,
    });
  }
};
