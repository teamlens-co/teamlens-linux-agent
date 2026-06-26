import { useEffect, useMemo, useRef, useState } from "react"; 
import { invoke } from "@tauri-apps/api/core";
import { fetch } from "@tauri-apps/plugin-http";
import { getVersion } from "@tauri-apps/api/app";

import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { openUrl } from "@tauri-apps/plugin-opener";
import { relaunch } from "@tauri-apps/plugin-process";
import { check } from "@tauri-apps/plugin-updater";
import { useEmployeeLiveScreen } from "./liveScreen";
import "./App.css";

type SessionEntry = {
  dayLabel: string;
  totalLabel: string;
  clockIn: string;
  clockOut: string;
};

type WorkSession = {
  id: string;
  userId: string;
  clockInAt: string;
  clockOutAt?: string;
};



type AgentLoginData = {
  token: string;
  expiresAt: string;
  user: {
    id: string;
    fullName: string;
    email: string;
    role: "MANAGER" | "EMPLOYEE";
  };
  organization: {
    id: string;
    name: string;
    slug: string;
  };
};

type AnalyticsPayload = {
  workSeconds: number;
  activeSeconds: number;
  productivityPercent: number;
  totalMouseMoves: number;
  totalKeyPresses: number;
  sessions: WorkSession[];
};

type ApiSuccess<T> = {
  success: true;
  data: T;
};

type GlobalInputCounts = {
  mouse_moves: number;
  key_presses: number;
};

type ActiveWindowInfo = {
  app_name: string;
  window_title: string;
  process_path: string;
  browser_url?: string;
};

type RecordingUploadStatus = "idle" | "recording" | "uploading" | "pending" | "paused" | "error";

type RecordingSessionResponse = {
  id: string;
  status: string;
};


const getApiBase = (): string => {
  const configured = import.meta.env.VITE_API_URL?.trim();
  if (configured) {
    return configured.replace(/\/$/, "");
  }

  return "https://api.teamlens.co";
};

const getWebBase = (): string => {
  const configured = import.meta.env.VITE_WEB_URL?.trim();
  if (configured) {
    return configured.replace(/\/$/, "");
  }

  return "https://test.teamlens.co";
};

const getWsBase = (): string => {
  const configured = import.meta.env.VITE_WS_URL?.trim();
  if (configured) {
    return configured.replace(/\/$/, "");
  }

  return "https://api.teamlens.co";
};

const isAutoUpdateEnabled = (): boolean => import.meta.env.VITE_ENABLE_AUTO_UPDATE === "true";


const formatSeconds = (seconds: number): string => {
  const hrs = Math.floor(seconds / 3600)
    .toString()
    .padStart(2, "0");
  const mins = Math.floor((seconds % 3600) / 60)
    .toString()
    .padStart(2, "0");
  const secs = Math.floor(seconds % 60)
    .toString()
    .padStart(2, "0");

  return `${hrs}:${mins}:${secs} h`;
};

const formatTime = (iso?: string): string => {
  if (!iso) {
    return "--:--";
  }

  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return "--:--";
  }

  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
};

const formatDayLabel = (iso: string): string => {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return "Recent";
  }

  const today = new Date();
  const isToday =
    date.getFullYear() === today.getFullYear() &&
    date.getMonth() === today.getMonth() &&
    date.getDate() === today.getDate();

  if (isToday) {
    return "Today";
  }

  return date.toLocaleDateString(undefined, { weekday: "short", day: "2-digit", month: "short" });
};

const getLocalDayRange = (): { start: Date; end: Date } => {
  const start = new Date();
  start.setHours(0, 0, 0, 0);

  const end = new Date(start);
  end.setHours(23, 59, 59, 999);

  return { start, end };
};

const isSameLocalDay = (iso: string): boolean => {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return false;
  }

  const today = new Date();
  return (
    date.getFullYear() === today.getFullYear() &&
    date.getMonth() === today.getMonth() &&
    date.getDate() === today.getDate()
  );
};

const normalizeCoordinate = (value: unknown): number | undefined => {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }

  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  return undefined;
};

/**
 * Safely parse JSON from a plugin-http Response.
 * @tauri-apps/plugin-http can append trailing garbage bytes after the JSON body,
 * causing response.json() to throw. This function extracts the first complete JSON
 * object by tracking brace depth, then parses manually.
 */
const safeParseJson = async <T,>(response: Response): Promise<T> => {
  const bodyText = await response.text();
  let depth = 0;
  let jsonStart = -1;
  let cleanJson = "";
  for (let i = 0; i < bodyText.length; i++) {
    if (bodyText[i] === "{") {
      if (depth === 0) jsonStart = i;
      depth++;
    } else if (bodyText[i] === "}") {
      depth--;
      if (depth === 0 && jsonStart !== -1) {
        cleanJson = bodyText.slice(jsonStart, i + 1);
        break;
      }
    }
  }
  if (!cleanJson) throw new Error(`No valid JSON object found in response body (len=${bodyText.length}): "${bodyText.substring(0, 60)}"`);
  return JSON.parse(cleanJson) as T;
};

const fetchJsonWithTimeout = async <T,>(url: string, timeoutMs: number): Promise<T> => {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, { signal: controller.signal });
    return await safeParseJson<T>(response);
  } finally {
    window.clearTimeout(timeoutId);
  }
};

const normalizeTrackedUrl = (value?: string): string | undefined => {
  const trimmed = value?.trim();
  if (!trimmed || /\s/.test(trimmed)) return undefined;
  if (/^(https?:\/\/|file:\/\/|chrome:\/\/|edge:\/\/|brave:\/\/|about:)/i.test(trimmed)) return trimmed;
  if (/^(localhost|(?:[a-z0-9-]+\.)+[a-z]{2,})(?::\d+)?(?:[/?#].*)?$/i.test(trimmed)) {
    return `https://${trimmed}`;
  }
  return undefined;
};

const inferUrlFromTitle = (title: string, browserUrl?: string): string | undefined => {
  const normalizedBrowserUrl = normalizeTrackedUrl(browserUrl);
  if (normalizedBrowserUrl) return normalizedBrowserUrl;
  const match = title.match(/https?:\/\/[^\s|]+/i);
  return normalizeTrackedUrl(match?.[0]);
};

const invalidDomainSuffixes = new Set(["app", "css", "html", "js", "jsx", "json", "md", "py", "rs", "tsx", "ts", "txt", "vue", "xml"]);
const SCREENSHOT_INTERVAL_MIN_MS = 60_000;
const SCREENSHOT_INTERVAL_MAX_MS = 60_000;
const AUTO_RECORDING_FPS = 3;
const AUTO_RECORDING_CHUNK_MS = 30_000;
const AUTO_RECORDING_MIN_CHUNK_BYTES = 25 * 1024; // Reject tiny/broken chunks
let lastZeroInputTimestamp = 0; // watchdog: restarts tracker after 30s of no input
const AUTO_RECORDING_WIDTH = 1280;
const AUTO_RECORDING_HEIGHT = 720;
const AUTO_RECORDING_MIME_CANDIDATES = [
  "video/webm;codecs=vp8",
  "video/webm;codecs=vp9",
  "video/webm",
];

const nextScreenshotDelayMs = () =>
  Math.floor(Math.random() * (SCREENSHOT_INTERVAL_MAX_MS - SCREENSHOT_INTERVAL_MIN_MS + 1)) + SCREENSHOT_INTERVAL_MIN_MS;

const selectRecordingMimeType = () => {
  if (typeof MediaRecorder === "undefined") return "";
  return AUTO_RECORDING_MIME_CANDIDATES.find((candidate) => MediaRecorder.isTypeSupported(candidate)) ?? "";
};

const codecFromMimeType = (mimeType: string) => {
  const match = mimeType.match(/codecs=([^;]+)/i);
  return match?.[1]?.toLowerCase() || "webm";
};

const cleanInferredDomain = (value?: string): string | undefined => {
  const domain = value?.replace(/^https?:\/\//i, "").replace(/^www\./i, "").split(/[/?#]/)[0]?.toLowerCase();
  if (!domain) return undefined;
  const parts = domain.split(".");
  const suffix = parts[parts.length - 1] ?? "";
  if (parts.length < 2 || invalidDomainSuffixes.has(suffix) || !/^[a-z0-9.-]+$/.test(domain) || parts.some((part) => !part)) {
    return undefined;
  }
  return domain;
};

const inferDomain = (activeWindow: ActiveWindowInfo): string | undefined => {
  const explicitUrl = inferUrlFromTitle(activeWindow.window_title, activeWindow.browser_url);
  if (explicitUrl) {
    try {
      return cleanInferredDomain(new URL(explicitUrl).hostname);
    } catch {
      return undefined;
    }
  }

  const title = activeWindow.window_title.toLowerCase();
  const domainMatch = title.match(/(?:^|\s|\||-)((?:[a-z0-9-]+\.)+[a-z]{2,})(?::\d+)?(?:\s|$|\/|\||-)/i);
  const inferredDomain = cleanInferredDomain(domainMatch?.[1]);
  if (inferredDomain) return inferredDomain;

  const configuredWebHost = (() => {
    const configured = import.meta.env.VITE_WEB_URL?.trim();
    if (!configured) return undefined;

    try {
      return cleanInferredDomain(new URL(configured).hostname);
    } catch {
      return undefined;
    }
  })();

  const knownDomains = [
    "chatgpt.com",
    "github.com",
    "gitlab.com",
    "stackoverflow.com",
    "youtube.com",
    "reddit.com",
    "figma.com",
    "notion.so",
    "linear.app",
    "atlassian.net",
    configuredWebHost,
  ].filter((domain): domain is string => Boolean(domain));

  return knownDomains.find((domain) => title.includes(domain));
};

const toSessionEntries = (sessions: WorkSession[]): SessionEntry[] => {
  return sessions.map((session, index) => {
    const start = new Date(session.clockInAt);
    const end = session.clockOutAt ? new Date(session.clockOutAt) : new Date();
    const seconds = Number.isNaN(start.getTime()) ? 0 : Math.max(0, Math.floor((end.getTime() - start.getTime()) / 1000));

    return {
      dayLabel: index === 0 ? formatDayLabel(session.clockInAt) : "",
      totalLabel: formatSeconds(seconds),
      clockIn: formatTime(session.clockInAt),
      clockOut: formatTime(session.clockOutAt),
    };
  });
};

function App() {
  const appWindow = getCurrentWebviewWindow();
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [authToken, setAuthToken] = useState<string | null>(null);
  const [authUserId, setAuthUserId] = useState<string | null>(null);
  const [authUserName, setAuthUserName] = useState<string>("");
  const [organizationName, setOrganizationName] = useState<string>("");
  const [appVersion, setAppVersion] = useState<string>("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [isLoginLoading, setIsLoginLoading] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);

  const [isClockedIn, setIsClockedIn] = useState(false);
  const [startedAt, setStartedAt] = useState<Date | null>(null);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [lastSync, setLastSync] = useState("Never");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [isClockActionLoading, setIsClockActionLoading] = useState(false);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);
  const [history, setHistory] = useState<SessionEntry[]>([]);
  const [workSeconds, setWorkSeconds] = useState(0);
  const [activeSeconds, setActiveSeconds] = useState(0);
  const [productivity, setProductivity] = useState(0);
  const [totalMouseMoves, setTotalMouseMoves] = useState(0);
  const [totalKeyPresses, setTotalKeyPresses] = useState(0);
  const [lastSentMouseMoves, setLastSentMouseMoves] = useState(0);
  const [lastSentKeyPresses, setLastSentKeyPresses] = useState(0);
  const [lastInputSource, setLastInputSource] = useState<"global" | "fallback" | "synthetic">("global");
  const [debugLocation, setDebugLocation] = useState<{ lat?: number; lng?: number; source?: string } | null>(null);
  const [activeWindow, setActiveWindow] = useState<ActiveWindowInfo | null>(null);
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [, setRecordingStatus] = useState<RecordingUploadStatus>("idle");
  const [, setRecordingMessage] = useState<string | null>(null);

  const mouseMovesRef = useRef(0);
  const keyPressesRef = useRef(0);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordingCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const recordingFrameTimerRef = useRef<number | null>(null);
  const recordingSessionIdRef = useRef<string | null>(null);
  const recordingChunkIndexRef = useRef(0);
  const recordingChunkStartedAtRef = useRef<number>(0);
  const recordingStopRequestedRef = useRef(false);
  const recordingCleanupRef = useRef<(() => void) | null>(null);

  const apiBase = useMemo(() => getApiBase(), []);
  const webBase = useMemo(() => getWebBase(), []);
  const wsBase = useMemo(() => getWsBase(), []);
  const {
    stopLiveScreen,
  } = useEmployeeLiveScreen({
    apiBase,
    wsBase,
    authToken,
    enabled: isAuthenticated,
    captureEnabled: isClockedIn,
  });

  const authHeaders = useMemo(() => {
    if (!authToken) {
      return null;
    }

    return {
      Authorization: `Bearer ${authToken}`,
      "Content-Type": "application/json",
    };
  }, [authToken]);

  // No aggressive webview focus stealing — it can interfere with input delivery.

  const applyAuth = (payload: AgentLoginData) => {
    setAuthToken(payload.token);
    setAuthUserId(payload.user.id);
    setAuthUserName(payload.user.fullName);
    setOrganizationName(payload.organization?.name || "");
    setIsAuthenticated(true);
    setAuthError(null);
  };

  const restoreAuthToken = async () => {
    try {
      const stored = await invoke<string | null>("get_auth_token");
      if (!stored) {
        return;
      }

      const response = await fetch(`${apiBase}/api/agent/auth/me`, {
        headers: {
          Authorization: `Bearer ${stored}`,
          "Content-Type": "application/json",
        },
      });

      const payload = await safeParseJson<{ success: boolean; data?: AgentLoginData; message?: string }>(response);

      if (!response.ok || !payload.success || !payload.data || payload.data.user.role !== "EMPLOYEE") {
        await invoke("clear_auth_token");
        setAuthToken(null);
        setIsAuthenticated(false);
        return;
      }

      applyAuth({ ...payload.data, token: payload.data.token || stored });
    } catch (error) {
      console.error("Unable to restore auth token", error);
      setAuthToken(null);
      setIsAuthenticated(false);
    }
  };

  const login = async () => {
    setIsLoginLoading(true);
    setAuthError(null);

    try {
      const response = await fetch(`${apiBase}/api/agent/auth/login`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          email,
          password,
          deviceLabel: "Desktop Agent",
        }),
      });

      const bodyText = await response.text();
      console.log("Login response body:", bodyText.substring(0, 200));
      console.log("Body length:", bodyText.length);
      console.log("Body last 20 chars:", JSON.stringify(bodyText.slice(-20)));
      let payload: { success: boolean; message?: string; data: AgentLoginData };
      try {
        // Reuse bodyText from above (response.text() can only be called once)
        console.log("Login response body length:", bodyText.length);
        console.log("Login body last 20:", JSON.stringify(bodyText.slice(-20)));
        // Re-create response-like object with cached text for safeParseJson
        const patchedResponse = new Response(bodyText, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
        payload = await safeParseJson<{ success: boolean; message?: string; data: AgentLoginData }>(patchedResponse);
      } catch (parseError) {
        console.error("JSON parse failed:", parseError);
        setAuthError(`Parse error: ${parseError instanceof Error ? parseError.message : String(parseError)}`);
        return;
      }
      if (!response.ok || !payload.success) {
        setAuthError(payload.message ?? "Login failed");
        return;
      }

      await invoke("set_auth_token", { token: payload.data.token });
      applyAuth(payload.data);
      setPassword("");
    } catch (error) {
      console.error("Agent login failed", error);
      setAuthError(`Error: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setIsLoginLoading(false);
    }
  };

  const uploadRecordingChunk = async (recordingSessionId: string, chunkIndex: number, blob: Blob, durationMs: number) => {
    if (!authHeaders) return false;

    const formData = new FormData();
    formData.append("chunkIndex", String(chunkIndex));
    formData.append("durationMs", String(durationMs));
    formData.append("chunk", blob, `chunk-${chunkIndex}.webm`);

    try {
      setRecordingStatus("uploading");
      const response = await fetch(`${apiBase}/api/agent/recording-sessions/${recordingSessionId}/chunks`, {
        method: "POST",
        headers: {
          Authorization: authHeaders.Authorization,
        },
        body: formData,
      });
      if (!response.ok) {
        setRecordingStatus("pending");
        setRecordingMessage("Recording upload pending. Backend will be retried on the next chunk.");
        return false;
      }
      setRecordingStatus("recording");
      setRecordingMessage(null);
      return true;
    } catch (error) {
      console.error("Recording chunk upload failed", error);
      setRecordingStatus("pending");
      setRecordingMessage("Recording upload pending. Network is unavailable.");
      return false;
    }
  };

  const stopAutoRecording = async (failed = false) => {
    recordingStopRequestedRef.current = true;

    // Call cleanup (removes focus/blur listeners, stops frame timer)
    if (recordingCleanupRef.current) {
      recordingCleanupRef.current();
      recordingCleanupRef.current = null;
    }

    // Also clear frame timer explicitly as fallback
    if (recordingFrameTimerRef.current !== null) {
      window.clearInterval(recordingFrameTimerRef.current);
      recordingFrameTimerRef.current = null;
    }

    const recorder = mediaRecorderRef.current;
    if (recorder && recorder.state !== "inactive") {
      recorder.stop();
    }

    mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
    mediaStreamRef.current = null;
    recordingCanvasRef.current = null;
    mediaRecorderRef.current = null;
    setIsRecording(false);
    setRecordingStatus(failed ? "error" : "idle");

    const recordingSessionId = recordingSessionIdRef.current;
    recordingSessionIdRef.current = null;
    recordingChunkIndexRef.current = 0;

    if (recordingSessionId && authHeaders) {
      try {
        await fetch(`${apiBase}/api/agent/recording-sessions/${recordingSessionId}/finish`, {
          method: "POST",
          headers: authHeaders,
          body: JSON.stringify({
            stoppedAt: new Date().toISOString(),
            failed,
          }),
        });
      } catch (error) {
        console.error("Finish recording session failed", error);
      }
    }
  };

  const startAutoRecording = async (activeSessionId: string) => {
    if (!authHeaders || !activeSessionId || recordingSessionIdRef.current || isRecording) {
      return;
    }
    if (typeof MediaRecorder === "undefined") {
      setRecordingStatus("error");
      setRecordingMessage("Screen recording is not supported by this WebView.");
      return;
    }

    try {
      const mimeType = selectRecordingMimeType();
      const canvas = document.createElement("canvas");
      canvas.width = AUTO_RECORDING_WIDTH;
      canvas.height = AUTO_RECORDING_HEIGHT;
      const context = canvas.getContext("2d", { alpha: false });
      if (!context || !canvas.captureStream) {
        throw new Error("Canvas recording is not supported by this WebView.");
      }
      context.fillStyle = "#111111";
      context.fillRect(0, 0, canvas.width, canvas.height);
      recordingCanvasRef.current = canvas;
      const stream = canvas.captureStream(AUTO_RECORDING_FPS);
      mediaStreamRef.current = stream;
      let lastFrameStarted = false;
      let consecutiveCaptureFailures = 0;
      const MAX_CAPTURE_FAILURES = 3;
      const drawNativeFrame = async () => {
        if (lastFrameStarted || recordingStopRequestedRef.current || !recordingCanvasRef.current) return;
        lastFrameStarted = true;
        try {
          const frameData = await invoke<number[]>("capture_live_frame");
          if (!frameData || frameData.length === 0) {
            throw new Error("Empty frame data from native capture");
          }
          consecutiveCaptureFailures = 0;
          const blob = new Blob([new Uint8Array(frameData)], { type: "image/png" });
          const bitmap = await createImageBitmap(blob);
          const activeCanvas = recordingCanvasRef.current;
          if (!activeCanvas) {
            bitmap.close();
            return;
          }
          const ctx = activeCanvas.getContext("2d", { alpha: false });
          if (!ctx) {
            bitmap.close();
            return;
          }
          const scale = Math.min(activeCanvas.width / bitmap.width, activeCanvas.height / bitmap.height);
          const width = Math.round(bitmap.width * scale);
          const height = Math.round(bitmap.height * scale);
          const x = Math.floor((activeCanvas.width - width) / 2);
          const y = Math.floor((activeCanvas.height - height) / 2);
          ctx.fillStyle = "#111111";
          ctx.fillRect(0, 0, activeCanvas.width, activeCanvas.height);
          ctx.drawImage(bitmap, x, y, width, height);
          bitmap.close();
        } catch (frameError) {
          consecutiveCaptureFailures += 1;
          console.error("Native recording frame capture failed", frameError, "consecutive", consecutiveCaptureFailures);
          if (consecutiveCaptureFailures >= MAX_CAPTURE_FAILURES) {
            setRecordingStatus("error");
            setRecordingMessage("Screen capture failed repeatedly. Check OS screen-capture permissions and restart the agent.");
          }
        } finally {
          lastFrameStarted = false;
        }
      };

      await drawNativeFrame();

      const startFrameTimer = () => {
        if (recordingStopRequestedRef.current) return;
        recordingFrameTimerRef.current = window.setInterval(() => {
          void drawNativeFrame();
        }, Math.max(1000 / AUTO_RECORDING_FPS, 50));
      };
      const stopFrameTimer = () => {
        if (recordingFrameTimerRef.current !== null) {
          window.clearInterval(recordingFrameTimerRef.current);
          recordingFrameTimerRef.current = null;
        }
      };

      startFrameTimer();

      // Store cleanup ref for when recording stops
      const recordingCleanup = () => {
        stopFrameTimer();
      };
      recordingCleanupRef.current = recordingCleanup;

      const startResponse = await fetch(`${apiBase}/api/agent/recording-sessions/start`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({
          workSessionId: activeSessionId,
          fps: AUTO_RECORDING_FPS,
          width: AUTO_RECORDING_WIDTH,
          height: AUTO_RECORDING_HEIGHT,
          codec: codecFromMimeType(mimeType),
          mimeType: mimeType || "video/webm",
          startedAt: new Date().toISOString(),
        }),
      });
      const startPayload = await safeParseJson<ApiSuccess<RecordingSessionResponse>>(startResponse);
      if (!startResponse.ok || !startPayload.success) {
        throw new Error("Backend refused recording session start");
      }

      recordingSessionIdRef.current = startPayload.data.id;
      recordingChunkIndexRef.current = 0;
      recordingStopRequestedRef.current = false;
      setIsRecording(true);
      setRecordingStatus("recording");
      setRecordingMessage(null);

      const recordNextChunk = () => {
        if (recordingStopRequestedRef.current || !mediaStreamRef.current || !recordingSessionIdRef.current) {
          return;
        }
        const chunks: BlobPart[] = [];
        const recorder = new MediaRecorder(mediaStreamRef.current, mimeType ? { mimeType } : undefined);
        mediaRecorderRef.current = recorder;
        recordingChunkStartedAtRef.current = Date.now();

        recorder.ondataavailable = (event) => {
          if (event.data.size > 0) {
            chunks.push(event.data);
          }
        };
        recorder.onstop = () => {
          const recordingSessionId = recordingSessionIdRef.current;
          const durationMs = Date.now() - recordingChunkStartedAtRef.current;
          if (recordingSessionId && chunks.length > 0) {
            const blob = new Blob(chunks, { type: mimeType || "video/webm" });
            if (blob.size < AUTO_RECORDING_MIN_CHUNK_BYTES) {
              console.warn("Skipping tiny recording chunk", blob.size, "bytes");
              if (consecutiveCaptureFailures < MAX_CAPTURE_FAILURES) {
                consecutiveCaptureFailures += 1;
              }
              if (consecutiveCaptureFailures >= MAX_CAPTURE_FAILURES) {
                setRecordingStatus("error");
                setRecordingMessage("Screen capture produced no usable video frames. Check OS screen-capture permissions.");
              }
            } else {
              consecutiveCaptureFailures = 0;
              const chunkIndex = recordingChunkIndexRef.current;
              recordingChunkIndexRef.current += 1;
              void uploadRecordingChunk(recordingSessionId, chunkIndex, blob, durationMs);
            }
          }
          if (!recordingStopRequestedRef.current) {
            window.setTimeout(recordNextChunk, 0);
          }
        };
        recorder.onerror = (event) => {
          console.error("MediaRecorder error", event);
          setRecordingStatus("error");
          setRecordingMessage("Recording error occurred.");
          void stopAutoRecording(true);
        };
        recorder.start();
        window.setTimeout(() => {
          if (recorder.state === "recording") {
            recorder.stop();
          }
        }, AUTO_RECORDING_CHUNK_MS);
      };

      recordNextChunk();
    } catch (error) {
      console.error("Unable to start auto recording", error);
      if (recordingFrameTimerRef.current !== null) {
        window.clearInterval(recordingFrameTimerRef.current);
        recordingFrameTimerRef.current = null;
      }
      mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
      mediaStreamRef.current = null;
      recordingCanvasRef.current = null;
      setIsRecording(false);
      setRecordingStatus("error");
      setRecordingMessage("Unable to start native screen recording. Check OS screen-capture permission.");
    }
  };

  const logout = async () => {
    await stopAutoRecording(false);
    try {
      await invoke("clear_auth_token");
    } catch (error) {
      console.error("Unable to clear auth token", error);
    }

    setIsAuthenticated(false);
    setAuthToken(null);
    setAuthUserId(null);
    setAuthUserName("");
    setIsClockedIn(false);
    setStartedAt(null);
    setElapsedSeconds(0);
    setSessionId(null);
    stopLiveScreen("logout");
  };

  const [updateStatus, setUpdateStatus] = useState<string | null>(null);
  const [isCheckingUpdate, setIsCheckingUpdate] = useState(false);

  const checkForAgentUpdate = async (showResult = false) => {
    if (!isAutoUpdateEnabled()) {
      if (showResult) {
        setUpdateStatus("Auto-update not configured. Download manually from the dashboard.");
      }
      return;
    }

    setIsCheckingUpdate(true);
    setUpdateStatus(null);

    try {
      const update = await check();
      if (!update) {
        if (showResult) {
          setUpdateStatus(`Already on latest version (${appVersion}). ✅`);
        }
        return;
      }

      setSyncMessage(`Installing TeamLens update ${update.version}...`);
      await update.downloadAndInstall();
      await relaunch();
    } catch (error) {
      console.error("Agent update check failed", error);
      if (showResult) {
        setUpdateStatus("Update check failed. Download manually from dashboard.");
      }
    } finally {
      setIsCheckingUpdate(false);
    }
  };

  const refreshAnalytics = async () => {
    if (!authUserId || !authHeaders) {
      return;
    }

    try {
      const { start, end } = getLocalDayRange();
      const params = new URLSearchParams({
        userId: authUserId,
        startDate: start.toISOString(),
        endDate: end.toISOString(),
      });
      const res = await fetch(`${apiBase}/api/web/dashboard/analytics?${params.toString()}`, {
        headers: authHeaders,
      });
      const json = await safeParseJson<ApiSuccess<AnalyticsPayload>>(res);

      if (!res.ok || !json.success) {
        return;
      }

      setWorkSeconds(json.data.workSeconds);
      setActiveSeconds(json.data.activeSeconds);
      setProductivity(json.data.productivityPercent);
      setTotalMouseMoves(json.data.totalMouseMoves);
      setTotalKeyPresses(json.data.totalKeyPresses);
      setHistory(toSessionEntries(json.data.sessions));
    } catch (error) {
      console.error("Failed to refresh analytics", error);
    }
  };

  const sendData = async () => {
    if (!isClockedIn || !authHeaders) {
      return;
    }

    let mouseMoves = 0;
    let keyPresses = 0;
    let inputSource: "global" | "fallback" | "synthetic" = "global";

    try {
      const globalCounts = await invoke<GlobalInputCounts>("get_and_reset_input_counts");
      mouseMoves = Number(globalCounts.mouse_moves) || 0;
      keyPresses = Number(globalCounts.key_presses) || 0;
    } catch (error) {
      console.error("Unable to read global input counters", error);
      inputSource = "fallback";
    }

    // If the native tracker reports zero, fall back to the JS counters.
    // This usually means the native global hook is not working in this session
    // (e.g. missing permissions or multi-monitor/Desktop Window Manager issues).
    if (mouseMoves === 0 && keyPresses === 0) {
      const jsMouseMoves = mouseMovesRef.current;
      const jsKeyPresses = keyPressesRef.current;
      if (jsMouseMoves > 0 || jsKeyPresses > 0) {
        mouseMoves = jsMouseMoves;
        keyPresses = jsKeyPresses;
        inputSource = "fallback";
      }
    }

    // Last-resort fallback: use Windows GetLastInputInfo to detect system-wide activity.
    // This catches cases where the native global hook silently returns zero even though
    // the user is actively using the machine in another window.
    if (mouseMoves === 0 && keyPresses === 0) {
      try {
        const idleMs = await invoke<number>("get_last_input_idle_ms");
        // If the user moved the mouse or pressed a key in the last 60 seconds,
        // report a synthetic interaction so the backend counts this sample as active.
        if (typeof idleMs === "number" && idleMs < 60_000) {
          mouseMoves = 1;
          keyPresses = 0;
          inputSource = "synthetic";
          console.log("[InputTracker] Native counters zero but system idle", idleMs, "ms — using synthetic mouse active sample only");
        }
      } catch (err) {
        console.warn("Unable to read last input idle time", err);
      }
    }

    // ── Watchdog: If all counters return 0 repeatedly,
    // the native tracker thread may have panicked. Restart it.
    if (mouseMoves === 0 && keyPresses === 0) {
      const now = Date.now();
      if (!lastZeroInputTimestamp) { lastZeroInputTimestamp = now; }
      else if (now - lastZeroInputTimestamp > 30_000) {
        // 30 seconds of consecutive zeros → restart the tracker
        console.warn("[InputTracker] 30s of zero input — restarting tracker");
        invoke("stop_global_input_tracker").catch(() => {});
        invoke("start_global_input_tracker").catch(() => {});
        lastZeroInputTimestamp = 0;
      }
    } else {
      lastZeroInputTimestamp = 0;
    }

    setLastInputSource(inputSource);
    setLastSentMouseMoves(mouseMoves);
    setLastSentKeyPresses(keyPresses);

    mouseMovesRef.current = 0;
    keyPressesRef.current = 0;

    try {
      let windowInfo: ActiveWindowInfo = activeWindow ?? {
        app_name: "Unknown",
        window_title: "",
        process_path: "",
      };

      try {
        windowInfo = await invoke<ActiveWindowInfo>("get_active_window_info");
        setActiveWindow(windowInfo);
      } catch (windowError) {
        console.error("Unable to read active window", windowError);
      }

      const res = await fetch(`${apiBase}/api/agent/activity`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({
          sessionId,
          mouseMoves,
          keyPresses,
          capturedAt: new Date().toISOString(),
        }),
      });

      const data = await safeParseJson<Record<string, unknown>>(res);
      console.log("Sent:", data);

      const url = inferUrlFromTitle(windowInfo.window_title, windowInfo.browser_url);
      const domain = inferDomain(windowInfo);
      await fetch(`${apiBase}/api/agent/usage`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({
          sessionId,
          appName: windowInfo.app_name || "Unknown",
          windowTitle: windowInfo.window_title || undefined,
          domain,
          url,
          durationSeconds: 10,
          idleSeconds: mouseMoves === 0 && keyPresses === 0 ? 10 : 0,
          isIdle: mouseMoves === 0 && keyPresses === 0,
          capturedAt: new Date().toISOString(),
        }),
      }).catch((usageError) => {
        console.error("Usage sync failed", usageError);
      });

      const now = new Date();
      setLastSync(`Today at ${now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`);
      setSyncMessage(null);
      await refreshAnalytics();
    } catch (err) {
      console.error("Error:", err);
      setSyncMessage("Backend sync failed. Tracking continues locally.");
    }
  };

  const captureAndUploadScreenshot = async (options?: { sessionId?: string; force?: boolean }) => {
    const activeSessionId = options?.sessionId ?? sessionId;

    if ((!isClockedIn && !options?.force) || !authHeaders || !activeSessionId) {
      return;
    }

    try {
      let windowInfo: ActiveWindowInfo = activeWindow ?? {
        app_name: "Unknown",
        window_title: "",
        process_path: "",
      };
      try {
        windowInfo = await invoke<ActiveWindowInfo>("get_active_window_info");
        setActiveWindow(windowInfo);
      } catch (windowError) {
        console.error("Unable to read active window for screenshot", windowError);
      }

      // Capture screenshot using Tauri command
      const screenshotData = await invoke<number[]>("capture_screenshot");
      const screenshotBlob = new Blob([new Uint8Array(screenshotData)], { type: "image/png" });

      // Upload to backend
      const formData = new FormData();
      formData.append("sessionId", activeSessionId);
      formData.append("capturedAt", new Date().toISOString());
      formData.append("activeApplication", windowInfo.app_name || "Unknown");
      formData.append("windowTitle", windowInfo.window_title || "");
      formData.append("projectName", "Default Project");
      const domain = inferDomain(windowInfo);
      const url = inferUrlFromTitle(windowInfo.window_title, windowInfo.browser_url);
      if (domain) formData.append("domain", domain);
      if (url) formData.append("url", url);
      formData.append("screenshot", screenshotBlob, "screenshot.png");

      const response = await fetch(`${apiBase}/api/agent/screenshots`, {
        method: "POST",
        headers: {
          Authorization: authHeaders.Authorization,
        },
        body: formData,
      });

      if (!response.ok) {
        console.error("Failed to upload screenshot:", response.statusText);
        return;
      }

      const result = await safeParseJson<{ success: boolean; data: { id: string } }>(response);
      if (result.success) {
        console.log("Screenshot uploaded:", result.data.id);
      }
    } catch (error) {
      console.error("Screenshot capture/upload failed:", error);
    }
  };

  useEffect(() => {
    void restoreAuthToken();
    getVersion().then(setAppVersion).catch(() => setAppVersion("0.1.0"));
  }, []);

  useEffect(() => {
    const handleMouseDown = async (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      // Only drag if the click started in the top bar (header)
      const header = target.closest(".top-bar");
      if (!header) return;

      // Do NOT drag if clicking on buttons, inputs, profile-icon, or close/minimize controls
      if (target.closest("button, input, a, .profile-icon, .control-dot")) {
        return;
      }

      try {
        await appWindow.startDragging();
      } catch (err) {
        console.error("Failed to start window dragging", err);
      }
    };

    window.addEventListener("mousedown", handleMouseDown);
    return () => {
      window.removeEventListener("mousedown", handleMouseDown);
    };
  }, [appWindow]);

  useEffect(() => {
    if (isClockedIn) {
      invoke("start_input_tracking").catch((err) =>
        console.error("Failed to start input tracking:", err)
      );
    } else {
      invoke("stop_input_tracking").catch((err) =>
        console.error("Failed to stop input tracking:", err)
      );
    }
  }, [isClockedIn]);

  useEffect(() => {
    const onMouseMove = () => {
      if (isClockedIn) {
        mouseMovesRef.current += 1;
      }
    };

    const onKeyDown = () => {
      if (isClockedIn) {
        keyPressesRef.current += 1;
      }
    };

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("keydown", onKeyDown);

    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [isClockedIn]);

  useEffect(() => {
    if (!isClockedIn || !startedAt) {
      return;
    }

    const timer = setInterval(() => {
      const seconds = Math.floor((Date.now() - startedAt.getTime()) / 1000);
      setElapsedSeconds(seconds);
    }, 1000);

    const activityInterval = setInterval(sendData, 10000);

    let screenshotTimeout: number | undefined;
    const scheduleScreenshot = () => {
      screenshotTimeout = window.setTimeout(() => {
        void captureAndUploadScreenshot();
        scheduleScreenshot();
      }, nextScreenshotDelayMs());
    };

    scheduleScreenshot();

    return () => {
      clearInterval(timer);
      clearInterval(activityInterval);
      if (screenshotTimeout !== undefined) {
        clearTimeout(screenshotTimeout);
      }
    };
  }, [isClockedIn, startedAt, sessionId]);

  useEffect(() => {
    if (!isAuthenticated) {
      return;
    }

    void refreshAnalytics();
    const interval = setInterval(() => {
      void refreshAnalytics();
    }, 30000);

    return () => clearInterval(interval);
  }, [isAuthenticated, authUserId, authHeaders]);

  useEffect(() => {
    if (!isAuthenticated) {
      return;
    }

    void checkForAgentUpdate();

    const handleFocus = () => {
      void checkForAgentUpdate();
    };
    window.addEventListener("focus", handleFocus);

    const interval = setInterval(() => {
      void checkForAgentUpdate();
    }, 5 * 60 * 1000);

    return () => {
      window.removeEventListener("focus", handleFocus);
      clearInterval(interval);
    };
  }, [isAuthenticated]);

  const resolveClockInLocation = async (): Promise<{ lat?: number; lng?: number; source?: "gps" | "ip" }> => {
    try {
      const pos = await new Promise<GeolocationPosition>((resolve, reject) => {
        navigator.geolocation.getCurrentPosition(resolve, reject, { timeout: 5000 });
      });
      return { lat: pos.coords.latitude, lng: pos.coords.longitude, source: "gps" };
    } catch (err) {
      console.warn("Could not get native location, falling back to Rust IP lookup:", err);
      try {
        const ipLoc = await invoke<{ lat: number; lon: number; source: string }>("get_ip_location");
        return { lat: ipLoc.lat, lng: ipLoc.lon, source: "ip" };
      } catch (ipErr) {
        console.error("Rust IP location fallback failed:", ipErr);
        try {
          const ipData = await fetchJsonWithTimeout<{ latitude?: unknown; longitude?: unknown }>(
            "https://ipapi.co/json/",
            3000,
          );
          const parsedLat = normalizeCoordinate(ipData?.latitude);
          const parsedLng = normalizeCoordinate(ipData?.longitude);
          if (parsedLat !== undefined && parsedLng !== undefined) {
            return { lat: parsedLat, lng: parsedLng, source: "ip" };
          }
        } catch (e) {
          console.error("Frontend IP fallback also failed:", e);
        }
        return {};
      }
    }
  };

  const autoClockIn = async () => {
    if (!authHeaders || isClockedIn || isClockActionLoading) {
      return;
    }
    setIsClockActionLoading(true);
    const now = new Date();
    try {
      setStartedAt(now);
      setElapsedSeconds(0);
      setIsClockedIn(true);
      setSyncMessage(null);

      const location = await resolveClockInLocation();
      setDebugLocation({ lat: location.lat, lng: location.lng, source: location.source });

      const res = await fetch(`${apiBase}/api/agent/clock-in`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({
          timestamp: now.toISOString(),
          activeAfter: getLocalDayRange().start.toISOString(),
          latitude: location.lat,
          longitude: location.lng,
          locationSource: location.source,
        }),
      });
      if (!res.ok) {
        setSyncMessage("Auto clock-in started locally. Backend sync pending.");
        return;
      }
      const json = await safeParseJson<ApiSuccess<{ id: string }>>(res);
      setSessionId(json.data.id);
      void captureAndUploadScreenshot({ sessionId: json.data.id, force: true });
      void startAutoRecording(json.data.id);
      await sendData();
    } catch (error) {
      console.error("Auto clock-in failed", error);
      setSyncMessage("Auto clock-in failed. Please check your connection.");
      setIsClockedIn(false);
      setStartedAt(null);
    } finally {
      setIsClockActionLoading(false);
    }
  };

  useEffect(() => {
    if (!isAuthenticated || !authHeaders) {
      return;
    }

    const recoverSession = async () => {
      try {
        const { start } = getLocalDayRange();
        const params = new URLSearchParams({ activeAfter: start.toISOString() });
        const res = await fetch(`${apiBase}/api/agent/active-session?${params.toString()}`, {
          headers: authHeaders,
        });
        if (!res.ok) {
          if (res.status === 401) {
            await logout();
          }
          return;
        }

        const payload = await safeParseJson<{
          success: boolean;
          data: WorkSession | null;
        }>(res);

        if (!payload.success || !payload.data) {
          void autoClockIn();
          return;
        }

        const active = payload.data;
        if (!isSameLocalDay(active.clockInAt)) {
          setSessionId(null);
          setIsClockedIn(false);
          setStartedAt(null);
          setElapsedSeconds(0);
          return;
        }

        setSessionId(active.id);
        setIsClockedIn(true);

        const started = new Date(active.clockInAt);
        if (!Number.isNaN(started.getTime())) {
          setStartedAt(started);
          setElapsedSeconds(Math.max(0, Math.floor((Date.now() - started.getTime()) / 1000)));
        }

        void captureAndUploadScreenshot({ sessionId: active.id, force: true });
        void startAutoRecording(active.id);
      } catch (error) {
        console.error("Session recovery failed", error);
        void autoClockIn();
      }
    };

    void recoverSession();
  }, [apiBase, isAuthenticated, authHeaders]);

  const toggleClockStatus = () => {
    if (isClockedIn) {
      const activeSessionId = sessionId;
      setSessionId(null);
      setIsClockedIn(false);
      setStartedAt(null);
      setElapsedSeconds(0);
      setSyncMessage(null);
      setIsClockActionLoading(false);

      void (async () => {
        await sendData();

        try {
          const response = await fetch(`${apiBase}/api/agent/clock-out`, {
            method: "POST",
            headers: authHeaders ?? { "Content-Type": "application/json" },
            body: JSON.stringify({
              sessionId: activeSessionId ?? undefined,
              timestamp: new Date().toISOString(),
            }),
          });

          if (!response.ok) {
            console.warn("Clock-out backend update pending.");
          }
        } catch (error) {
          console.error("Clock-out failed", error);
        }

        await stopAutoRecording(false);
        await refreshAnalytics();
      })();

      return;
    }

    void (async () => {
      setIsClockActionLoading(true);
      const now = new Date();

      try {
        const optimisticSessionId = crypto.randomUUID();

        // Optimistic mode: instantly start timer so the button always feels responsive.
        setSessionId(optimisticSessionId);
        setStartedAt(now);
        setElapsedSeconds(0);
        setIsClockedIn(true);
        setSyncMessage(null);

        const location = await resolveClockInLocation();

        setDebugLocation({ lat: location.lat, lng: location.lng, source: location.source });

        try {
          const res = await fetch(`${apiBase}/api/agent/clock-in`, {
            method: "POST",
            headers: authHeaders ?? { "Content-Type": "application/json" },
            body: JSON.stringify({
              timestamp: now.toISOString(),
              activeAfter: getLocalDayRange().start.toISOString(),
              latitude: location.lat,
              longitude: location.lng,
              locationSource: location.source,
            }),
          });

          if (res.ok) {
            const json = await safeParseJson<ApiSuccess<{ id: string }>>(res);
            setSessionId(json.data.id);
            void captureAndUploadScreenshot({ sessionId: json.data.id, force: true });
            void startAutoRecording(json.data.id);
          } else {
            setSyncMessage("Clock-in started locally. Backend sync pending.");
          }
        } catch (error) {
          console.error("Clock-in failed", error);
          setSyncMessage("Clock-in started locally. Backend is unreachable.");
        }

        await sendData();
      } catch (error) {
        console.error("Clock-in action failed", error);
        setSyncMessage("Clock-in action failed. Please try again.");
      } finally {
        setIsClockActionLoading(false);
      }
    })();
  };

  const todayLabel = useMemo(
    () =>
      new Date().toLocaleDateString(undefined, {
        weekday: "short",
        month: "short",
        day: "numeric",
        year: "numeric",
      }),
    [],
  );

  const startedAtLabel = startedAt
    ? startedAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : "--:--";

  const handleClose = async () => {
    await appWindow.hide();
  };

  const handleMinimize = async () => {
    await appWindow.minimize();
  };

  const openDashboard = async () => {
    try {
      await openUrl(webBase);
    } catch {
      window.open(webBase, "_blank");
    }
  };

  const openCreateAccount = async () => {
    const signupUrl = `${webBase}/signup`;

    try {
      await openUrl(signupUrl);
    } catch {
      window.open(signupUrl, "_blank");
    }
  };


  if (!isAuthenticated || !authToken) {
    return (
      <div className="agent-shell">
        <header className="top-bar">
          <div className="window-controls">
            <button className="control-dot red" onClick={() => void handleClose()} aria-label="Close window" />
            <button
              className="control-dot yellow"
              onClick={() => void handleMinimize()}
              aria-label="Minimize window"
            />
            <button
              className="control-dot green"
              disabled
              aria-label="Window size locked"
            />
          </div>
          <div className="brand-name" data-tauri-drag-region>
            <span className="tl-brand-mark" aria-hidden="true" data-tauri-drag-region>
              <span data-tauri-drag-region></span>
              <span data-tauri-drag-region></span>
              <span data-tauri-drag-region></span>
              <span data-tauri-drag-region></span>
            </span>{" "}
            TeamLens
          </div>
          <div className="bar-spacer" data-tauri-drag-region />
        </header>

        <div className="auth-shell">
          <section className="auth-card">
            <h1>TeamLens Agent Login</h1>
            <p>Sign in to start secure desktop activity tracking.</p>

            <label>
              Email
              <input
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="you@company.com"
              />
            </label>

            <label>
              Password
              <input
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder="Enter password"
              />
            </label>

            <button className="clock-btn clock-in" onClick={() => void login()} disabled={isLoginLoading}>
              {isLoginLoading ? "Logging in..." : "Login"}
            </button>

            <button className="create-account-btn" onClick={() => void openCreateAccount()}>
              Create Account
            </button>

            {authError ? <p className="sync-message">{authError}</p> : null}
          </section>
        </div>
      </div>
    );
  }

  return (
    <div className="agent-shell">
      <section className="top-card">
        <header className="top-bar">
          <div className="window-controls">
            <button className="control-dot red" onClick={() => void handleClose()} aria-label="Close window" />
            <button
              className="control-dot yellow"
              onClick={() => void handleMinimize()}
              aria-label="Minimize window"
            />
            <button
              className="control-dot green"
              disabled
              aria-label="Window size locked"
            />
          </div>
          <div className="brand-name" data-tauri-drag-region>
            <span className="tl-brand-mark" aria-hidden="true" data-tauri-drag-region>
              <span data-tauri-drag-region></span>
              <span data-tauri-drag-region></span>
              <span data-tauri-drag-region></span>
              <span data-tauri-drag-region></span>
            </span>{" "}
            TeamLens
          </div>
          <div className="bar-spacer" data-tauri-drag-region>
            <div className="profile-icon" onClick={() => setIsSidebarOpen(true)} title="Profile">
              {authUserName.substring(0, 2).toUpperCase() || "PM"}
            </div>
          </div>
        </header>

        {isSidebarOpen && (
          <>
            <div className="sidebar-overlay" onClick={() => setIsSidebarOpen(false)} />
            <aside className="profile-sidebar">
              <div className="sidebar-header">
                <h2>Account</h2>
                <button className="close-btn" onClick={() => setIsSidebarOpen(false)}>×</button>
              </div>

              <div className="sidebar-tabs">
                <div className="active-tab">Profile</div>
              </div>

              <div className="sidebar-content account-content">
                <div className="profile-info">
                  <div className="profile-avatar-large">
                    {authUserName.substring(0, 2).toUpperCase() || "PM"}
                  </div>
                  <h3>{authUserName || "User"}</h3>
                  <p>{email || ""}</p>
                </div>

                <div className="companies-section">
                  <h4 className="section-title">Companies</h4>
                  <div className="company-item">
                    <span>{organizationName || "Company"}</span>
                    <span className="check-icon">✓</span>
                  </div>
                </div>
              </div>

              <div className="sidebar-footer account-footer">
                <button className="signout-link" onClick={() => { setIsSidebarOpen(false); void logout(); }}>
                  Sign out
                </button>
                <div className="update-section">
                  <button
                    className="check-update-link"
                    onClick={() => void checkForAgentUpdate(true)}
                    disabled={isCheckingUpdate}
                  >
                    {isCheckingUpdate ? "Checking..." : "Check for Updates"}
                  </button>
                  {updateStatus && <span className="update-status">{updateStatus}</span>}
                  <span className="app-version">Version: {appVersion}</span>
                </div>
              </div>
            </aside>
          </>
        )}

        <div className="timer-panel">
          <p className="date-label">{todayLabel}</p>
          <h1 className="live-timer">{formatSeconds(elapsedSeconds)}</h1>
          <p className="started-at">
            Started at {startedAtLabel}
          </p>

          <div className="clock-actions">
            <button
              className={`clock-btn ${isClockedIn ? "clock-out" : "clock-in"}`}
              onClick={toggleClockStatus}
              disabled={isClockActionLoading}
            >
              {isClockedIn ? "Clock Out" : "Clock In"}
            </button>
          </div>
          {syncMessage ? <p className="sync-message">{syncMessage}</p> : null}
        </div>
      </section>

      <main className="sessions-panel">
        <section className="day-block">
          <div className="day-header">
            <h2>Today</h2>
            <span>{formatSeconds(workSeconds)}</span>
          </div>
          <article className="session-card">
            <div>
              <p>Active Time</p>
              <strong>{formatSeconds(activeSeconds)}</strong>
            </div>
            <div>
              <p>Productivity</p>
              <strong>{productivity}%</strong>
            </div>
            <div className="session-total">
            </div>
          </article>
          <article className="session-card">
            <div>
              <p>Mouse Activity</p>
              <strong>{totalMouseMoves.toLocaleString()} moves</strong>
            </div>
            <div>
              <p>Keyboard Activity</p>
              <strong>{totalKeyPresses.toLocaleString()} keys</strong>
            </div>
            <div className="session-total">
            </div>
          </article>
        </section>

        {history.map((entry, index) => (
          <section key={`${entry.totalLabel}-${index}`} className="day-block">
            {(entry.dayLabel || index === 0) && (
              <div className="day-header">
                <h2>{entry.dayLabel || "Records"}</h2>
                <span>{entry.totalLabel}</span>
              </div>
            )}

            <article className="session-card">
              <div>
                <p>Clock In</p>
                <strong>{entry.clockIn}</strong>
              </div>
              <div>
                <p>Clock Out</p>
                <strong>{entry.clockOut}</strong>
              </div>
              <div className="session-total">
                {entry.totalLabel}
              </div>
            </article>
          </section>
        ))}
      </main>

      <footer className="bottom-bar">
        <div className="sync-container">
          <button className="sync-btn" onClick={() => void sendData()}>
            ↻
          </button>
          <div className="sync-status">
            <span>Last sync</span>
            <strong>{lastSync}</strong>
            <p className="debug-telemetry">
              Last sent: mouse {lastSentMouseMoves} | keys {lastSentKeyPresses} | source {lastInputSource}
            </p>
            {debugLocation && (
              <p className="debug-telemetry" style={{ marginTop: "2px", color: "#94a3b8" }}>
                Loc: {debugLocation.source?.toUpperCase() || "N/A"} | {debugLocation.lat?.toFixed(4) || "N/A"},{" "}
                {debugLocation.lng?.toFixed(4) || "N/A"}
              </p>
            )}
          </div>
        </div>
        <button className="dashboard-btn" onClick={() => void openDashboard()}>
          Open Dashboard
        </button>
      </footer>
    </div>
  );
}

export default App;
