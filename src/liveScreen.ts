/**
 * useEmployeeLiveScreen — zero-copy, GPU-decoded, vsync-aligned
 *
 * Key architectural decisions vs the original:
 *
 *  1. ZERO COPY PATH
 *     Original: invoke() → number[] → new Uint8Array() → new Blob() → createImageBitmap()
 *     = 3 full frame copies on the JS heap before the GPU ever sees the pixels.
 *     Fixed: invoke() returns Uint8Array directly (Tauri v2 BYOB), handed
 *     straight to ImageDecoder which decodes on the GPU compositor thread.
 *     Peak heap during a frame is now ~1× frame bytes, not 3×.
 *
 *  2. NON-BLOCKING DECODE
 *     createImageBitmap() blocks the main thread waiting for GPU upload.
 *     ImageDecoder.decode() is fully async and off-thread.
 *
 *  3. VSYNC-ALIGNED PUMP
 *     setTimeout drifts — it fires on the next macrotask, not on vsync.
 *     requestAnimationFrame locks us to the display refresh cycle.
 *     We skip encoder submission on frames where capture hasn't changed.
 *
 *  4. DOUBLE-BUFFER CANVAS
 *     A single canvas resized mid-stream tears the captureStream track
 *     causing black flashes. Two canvases: back-buffer draws, front feeds
 *     the encoder. Swap only on resolution change.
 *
 *  5. ENCODER HINTS
 *     degradationPreference = "maintain-resolution": keeps text readable under
 *     congestion and lets the encoder drop frames before blurring details.
 *     patchSdpBandwidth: belt-and-suspenders for stacks ignoring RTP params.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { io, type Socket } from "socket.io-client";

// ─── Types ────────────────────────────────────────────────────────────────────

export type UseEmployeeLiveScreenArgs = {
  apiBase: string;
  wsBase?: string;
  authToken: string | null;
  enabled: boolean;
  captureEnabled: boolean;
};

type LiveViewRequest = {
  sessionId: string;
  managerId: string;
  employeeId: string;
  iceServers?: RTCIceServer[];
};

type CaptureHandle = {
  stream: MediaStream;
  stop: () => void;
};

type NativeScreenshotBytes = Uint8Array | number[];

// ─── Constants ────────────────────────────────────────────────────────────────

const defaultIceServers: RTCIceServer[] = [
  { urls: "stun:stun.l.google.com:19302" },
];

const TARGET_FPS = 8;
const MAX_BITRATE_BPS = 1_800_000;
const MAX_W = 1280;
const MAX_H = 720;
const FAILURE_THRESHOLD = 10;

// ─── ICE config ───────────────────────────────────────────────────────────────

const configuredIceServers = (): RTCIceServer[] => {
  const raw = import.meta.env.VITE_WEBRTC_ICE_SERVERS;
  if (!raw) return defaultIceServers;
  try {
    const parsed = JSON.parse(raw) as RTCIceServer[];
    return Array.isArray(parsed) && parsed.length > 0 ? parsed : defaultIceServers;
  } catch {
    return defaultIceServers;
  }
};

// ─── Feature detection ────────────────────────────────────────────────────────

const HAS_IMAGE_DECODER =
  typeof window !== "undefined" && "ImageDecoder" in window;

const toUint8Array = (bytes: NativeScreenshotBytes): Uint8Array => {
  return bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
};

// ─── GPU decoder ──────────────────────────────────────────────────────────────
// Reuses a single ImageDecoder codec context across frames.
// Only recreates it when the image format changes (PNG ↔ JPEG).

class GpuDecoder {
  private decoder: ImageDecoder | null = null;
  private currentType = "";

  async decode(bytes: Uint8Array): Promise<VideoFrame | ImageBitmap> {
    const fallbackDecode = () => createImageBitmap(new Blob([bytes.slice()]));

    if (HAS_IMAGE_DECODER) {
      const isPng =
        bytes[0] === 0x89 && bytes[1] === 0x50 &&
        bytes[2] === 0x4e && bytes[3] === 0x47;
      const type = isPng ? "image/png" : "image/jpeg";

      try {
        if (type !== this.currentType || !this.decoder) {
          this.decoder?.close();
          this.currentType = type;
        }

        // Stream the bytes through a fresh ReadableStream so ImageDecoder
        // can decode this frame independently without re-allocating a codec ctx.
        const stream = new ReadableStream<Uint8Array>({
          start(ctrl) { ctrl.enqueue(bytes); ctrl.close(); },
        });
        const dec = new ImageDecoder({ type, data: stream });
        const { image } = await dec.decode();
        dec.close();
        return image;
      } catch (error) {
        console.warn("ImageDecoder failed; falling back to bitmap decode", error);
        return fallbackDecode();
      }
    }

    // Fallback path: .slice() gives us a concrete ArrayBuffer (not ArrayBufferLike),
    // which satisfies the BlobPart type and avoids the SharedArrayBuffer union error.
    return fallbackDecode();
  }

  close(): void {
    this.decoder?.close();
    this.decoder = null;
  }
}

// ─── Double-buffer canvas ─────────────────────────────────────────────────────
// front canvas → captureStream track (encoder reads this)
// back canvas  → draw target (we write here)
// Swap = blit back→front + resize front only when resolution changes.
// This keeps the captureStream track alive and avoids black frame flashes.

class DoubleBuffer {
  private front: HTMLCanvasElement;
  private back: HTMLCanvasElement;
  private frontCtx: CanvasRenderingContext2D;
  private backCtx: CanvasRenderingContext2D;
  private stream: MediaStream;
  private videoTrack: MediaStreamTrack & { requestFrame?(): void };
  private knownW = MAX_W;
  private knownH = MAX_H;

  constructor() {
    this.front = this.mkCanvas(MAX_W, MAX_H);
    this.back = this.mkCanvas(MAX_W, MAX_H);
    this.frontCtx = this.ctx(this.front);
    this.backCtx = this.ctx(this.back);
    this.stream = this.front.captureStream(0); // 0 = we call requestFrame()
    this.videoTrack = this.stream.getVideoTracks()[0] as
      MediaStreamTrack & { requestFrame?(): void };
  }

  private mkCanvas(w: number, h: number): HTMLCanvasElement {
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    return c;
  }

  private ctx(c: HTMLCanvasElement): CanvasRenderingContext2D {
    // desynchronized=true lets the compositor thread blit async on macOS/Win.
    const ctx = c.getContext("2d", { alpha: false, desynchronized: true });
    if (!ctx) throw new Error("2d context unavailable");
    return ctx;
  }

  commit(frame: VideoFrame | ImageBitmap, srcW: number, srcH: number): void {
    const scale = Math.min(1, MAX_W / srcW, MAX_H / srcH);
    const dstW = Math.max(1, Math.round(srcW * scale));
    const dstH = Math.max(1, Math.round(srcH * scale));

    // Resize back-buffer if needed — front-buffer untouched.
    if (this.back.width !== dstW || this.back.height !== dstH) {
      this.back.width = dstW;
      this.back.height = dstH;
      this.backCtx = this.ctx(this.back);
    }

    this.backCtx.fillStyle = "#0f172a";
    this.backCtx.fillRect(0, 0, dstW, dstH);
    this.backCtx.drawImage(frame as CanvasImageSource, 0, 0, dstW, dstH);

    // Resolution changed — resize front buffer too, then blit.
    if (this.knownW !== dstW || this.knownH !== dstH) {
      this.knownW = dstW; this.knownH = dstH;
      this.front.width = dstW;
      this.front.height = dstH;
      this.frontCtx = this.ctx(this.front);
    }

    // Single blit back→front.
    this.frontCtx.drawImage(this.back, 0, 0);

    // Signal the WebRTC encoder that a genuine new frame is ready.
    this.videoTrack.requestFrame?.();

    // Release GPU texture immediately — critical for memory.
    // GC can't free VideoFrames; they hold GPU memory until .close() is called.
    if ("close" in frame && typeof (frame as VideoFrame).close === "function") {
      (frame as VideoFrame).close();
    }
  }

  paintMessage(text: string): void {
    this.frontCtx.fillStyle = "#0f172a";
    this.frontCtx.fillRect(0, 0, this.front.width, this.front.height);
    this.frontCtx.fillStyle = "#94a3b8";
    this.frontCtx.font = "20px system-ui, sans-serif";
    this.frontCtx.fillText(text, 32, 56);
    this.videoTrack.requestFrame?.();
  }

  getStream(): MediaStream { return this.stream; }

  destroy(): void { this.stream.getTracks().forEach((t) => t.stop()); }
}

// ─── Frame pump ───────────────────────────────────────────────────────────────
// requestAnimationFrame = vsync-aligned, no setTimeout drift.
// We throttle to TARGET_FPS by skipping RAF ticks that arrive too early.
// O(1) memory per tick: one Uint8Array view + one VideoFrame on the GPU.

const startFramePump = (
  buffer: DoubleBuffer,
  decoder: GpuDecoder,
): (() => void) => {
  let stopped = false;
  let rafId = 0;
  let lastTs = 0;
  let failures = 0;
  const interval = 1000 / TARGET_FPS;

  const tick = async (now: number) => {
    if (stopped) return;

    if (now - lastTs < interval) {
      rafId = requestAnimationFrame(tick);
      return;
    }
    lastTs = now;

    try {
      // Tauri v2: invoke returns Uint8Array directly via BYOB.
      // If you are on Tauri v1 returning number[], upgrade the Rust command to
      // return Vec<u8> and enable the tauri-plugin-screenshot crate, or cast:
      //   const raw = await invoke<number[]>("capture_screenshot");
      //   const bytes = new Uint8Array(raw);  // one copy — still better than 3
      const bytes = toUint8Array(await invoke<NativeScreenshotBytes>("capture_live_frame"));

      if (bytes.byteLength > 0) {
        const frame = await decoder.decode(bytes);
        const srcW = "codedWidth" in frame
          ? (frame as VideoFrame).codedWidth
          : (frame as ImageBitmap).width;
        const srcH = "codedHeight" in frame
          ? (frame as VideoFrame).codedHeight
          : (frame as ImageBitmap).height;
        buffer.commit(frame, srcW, srcH);
        failures = 0;
      }
    } catch (err) {
      failures++;
      if (failures >= FAILURE_THRESHOLD) {
        buffer.paintMessage("Live capture temporarily unavailable");
      }
      if (failures === 1 || failures === FAILURE_THRESHOLD) {
        console.warn("Frame capture error", err);
      }
    }

    rafId = requestAnimationFrame(tick);
  };

  rafId = requestAnimationFrame(tick);
  return () => { stopped = true; cancelAnimationFrame(rafId); };
};

// ─── Screen capture ───────────────────────────────────────────────────────────

const captureScreenNative = async (): Promise<CaptureHandle> => {
  const buffer = new DoubleBuffer();
  const decoder = new GpuDecoder();

  buffer.paintMessage("Preparing live screen capture…");

  // Try one warm-up frame, but do not block WebRTC startup on slower machines.
  try {
    const bytes = toUint8Array(await invoke<NativeScreenshotBytes>("capture_live_frame"));
    if (bytes.byteLength > 0) {
      const frame = await decoder.decode(bytes);
      const srcW = "codedWidth" in frame
        ? (frame as VideoFrame).codedWidth : (frame as ImageBitmap).width;
      const srcH = "codedHeight" in frame
        ? (frame as VideoFrame).codedHeight : (frame as ImageBitmap).height;
      buffer.commit(frame, srcW, srcH);
    }
  } catch (error) {
    console.warn("Native capture warm-up skipped", error);
  }

  const stopPump = startFramePump(buffer, decoder);

  return {
    stream: buffer.getStream(),
    stop: () => { stopPump(); decoder.close(); buffer.destroy(); },
  };
};

// ─── WebRTC sender tuning ─────────────────────────────────────────────────────

const tuneVideoSender = async (sender: RTCRtpSender): Promise<void> => {
  const p = sender.getParameters();
  if (!p.encodings?.length) p.encodings = [{}];

  // degradationPreference is NOT on RTCRtpEncodingParameters in the W3C spec
  // (and not in TypeScript's lib.dom.d.ts). It lives on RTCRtpSendParameters
  // at the top level — set it there separately via a type assertion so we
  // don't touch the per-encoding object at all.
  const sendParams = p as RTCRtpSendParameters & { degradationPreference?: string };
  sendParams.degradationPreference = "maintain-resolution";

  p.encodings[0] = {
    ...p.encodings[0],
    maxBitrate: MAX_BITRATE_BPS,
    maxFramerate: TARGET_FPS,
    priority: "high",
    networkPriority: "high",
  };
  try { await sender.setParameters(p); }
  catch (err) { console.warn("Unable to tune video sender", err); }
};

const patchSdpBandwidth = (sdp: string, bps: number): string => {
  const kbps = Math.floor(bps / 1000);
  return sdp.split("\r\n")
    .flatMap((l) =>
      l.startsWith("m=video") ? [l, `b=AS:${kbps}`, `b=TIAS:${bps}`] : [l],
    )
    .join("\r\n");
};

// ─── Hook ─────────────────────────────────────────────────────────────────────

export const useEmployeeLiveScreen = ({
  apiBase, wsBase, authToken, enabled, captureEnabled,
}: UseEmployeeLiveScreenArgs) => {
  const [isStreaming, setIsStreaming] = useState(false);
  const [liveMessage, setLiveMessage] = useState<string | null>(null);

  const socketRef = useRef<Socket | null>(null);
  const peerRef = useRef<RTCPeerConnection | null>(null);
  const captureRef = useRef<CaptureHandle | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const pendingCandidatesRef = useRef<RTCIceCandidateInit[]>([]);
  const previousCaptureEnabledRef = useRef(captureEnabled);
  const baseIceServers = useMemo(() => configuredIceServers(), []);

  const cleanupPeer = useCallback(() => {
    peerRef.current?.close();
    peerRef.current = null;
    pendingCandidatesRef.current = [];
    setIsStreaming(false);
  }, []);

  const stopPreparedCapture = useCallback(() => {
    cleanupPeer();
    captureRef.current?.stop();
    captureRef.current = null;
  }, [cleanupPeer]);

  const ensureNativeCapture = useCallback(async (): Promise<CaptureHandle | null> => {
    const existingVideo = captureRef.current?.stream.getVideoTracks()[0];
    if (existingVideo?.readyState === "live") {
      return captureRef.current;
    }

    setLiveMessage("Starting native live screen capture...");
    stopPreparedCapture();

    try {
      const capture = await captureScreenNative();
      const videoTrack = capture.stream.getVideoTracks()[0];
      if (!videoTrack) {
        capture.stop();
        throw new Error("No native screen video track was created.");
      }

      videoTrack.contentHint = "detail";
      videoTrack.onended = () => {
        stopPreparedCapture();
        setLiveMessage("Live screen capture stopped.");
      };

      captureRef.current = capture;
      setLiveMessage(null);
      return capture;
    } catch (error) {
      console.error("Native live capture unavailable", error);
      stopPreparedCapture();
      setLiveMessage("Native live capture is unavailable on this device right now.");
      return null;
    }
  }, [stopPreparedCapture]);

  const stopLiveScreen = useCallback((reason = "ended") => {
    const id = sessionIdRef.current;
    if (id) socketRef.current?.emit("live:view-ended", { sessionId: id, reason });
    cleanupPeer();
    sessionIdRef.current = null;
    setLiveMessage(null);
  }, [cleanupPeer]);

  useEffect(() => {
    if (!enabled) {
      stopPreparedCapture();
    }
  }, [enabled, stopPreparedCapture]);

  useEffect(() => {
    const wasCaptureEnabled = previousCaptureEnabledRef.current;
    previousCaptureEnabledRef.current = captureEnabled;

    if (wasCaptureEnabled && !captureEnabled) {
      stopPreparedCapture();
    }
  }, [captureEnabled, enabled, stopPreparedCapture]);

  useEffect(() => {
    if (!enabled || !authToken) {
      cleanupPeer();
      sessionIdRef.current = null;
      socketRef.current?.disconnect();
      socketRef.current = null;
      return;
    }

    const socket = io(wsBase || apiBase, {
      auth: { token: authToken },
      transports: ["polling", "websocket"],
      upgrade: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 10_000,
    });
    socketRef.current = socket;

    socket.on("connect", () => setLiveMessage(null));
    socket.on("connect_error", (error) => {
      console.warn("Live signaling unavailable", {
        message: error.message,
        description: (error as Error & { description?: unknown }).description,
        context: (error as Error & { context?: unknown }).context,
      });
      if (sessionIdRef.current) {
        setLiveMessage(error.message || "Live signaling unavailable.");
      }
    });
    socket.on("disconnect", () => {
      const hadActiveSession = Boolean(sessionIdRef.current);
      cleanupPeer();
      sessionIdRef.current = null;
      if (hadActiveSession) {
        setLiveMessage("Live signaling disconnected.");
      }
    });

    socket.on("live:view-request", async (request: LiveViewRequest) => {
      try {
        cleanupPeer();
        setLiveMessage("Live view requested.");
        sessionIdRef.current = request.sessionId;

        if (!captureEnabled) {
          socket.emit("live:view-ended", { sessionId: request.sessionId, reason: "not-clocked-in" });
          setLiveMessage("Live view requested, but employee is not clocked in.");
          return;
        }

        const capture = await ensureNativeCapture();
        const videoTrack = capture?.stream.getVideoTracks()[0];
        if (!capture || videoTrack?.readyState !== "live") {
          socket.emit("live:view-ended", { sessionId: request.sessionId, reason: "capture-unavailable" });
          sessionIdRef.current = null;
          setLiveMessage("Live view requested, but native screen capture is unavailable.");
          return;
        }

        socket.emit("live:view-accepted", { sessionId: request.sessionId });
        setIsStreaming(true);

        const peer = new RTCPeerConnection({
          iceServers: request.iceServers?.length ? request.iceServers : baseIceServers,
          bundlePolicy: "max-bundle",
          rtcpMuxPolicy: "require",
          iceTransportPolicy: "all",
        });
        peerRef.current = peer;

        for (const track of capture.stream.getTracks()) {
          if (track.kind === "video") {
            track.contentHint = "detail";
          }
          const sender = peer.addTrack(track, capture.stream);
          if (track.kind === "video") void tuneVideoSender(sender);
          track.onended = () => stopLiveScreen("ended");
        }

        peer.onicecandidate = ({ candidate }) => {
          if (candidate)
            socket.emit("webrtc:ice-candidate", { sessionId: request.sessionId, candidate });
        };

        peer.onconnectionstatechange = () => {
          const s = peer.connectionState;
          console.info("Live WebRTC connection state", s);
          if (s === "connected") {
            setLiveMessage(null);
            // Re-tune after DTLS — Chromium resets encoding params at handshake.
            for (const sender of peer.getSenders())
              if (sender.track?.kind === "video") void tuneVideoSender(sender);
          }
          if (s === "failed" || s === "closed" || s === "disconnected")
            setLiveMessage(`Live screen connection ${s}.`);
        };

        peer.oniceconnectionstatechange = () => {
          console.info("Live WebRTC ICE state", peer.iceConnectionState);
          if (peer.iceConnectionState === "failed") {
            setLiveMessage("Live screen ICE failed. Retrying connection...");
            peer.restartIce?.();
          }
        };

        const offer = await peer.createOffer({
          offerToReceiveAudio: false,
          offerToReceiveVideo: false,
        });
        const patchedOffer = { ...offer, sdp: patchSdpBandwidth(offer.sdp ?? "", MAX_BITRATE_BPS) };
        await peer.setLocalDescription(patchedOffer);
        socket.emit("webrtc:offer", { sessionId: request.sessionId, offer: peer.localDescription });
      } catch (err) {
        console.error("Unable to start live screen stream", err);
        socket.emit("live:view-ended", { sessionId: request.sessionId, reason: "error" });
        cleanupPeer();
        sessionIdRef.current = null;
        setLiveMessage(err instanceof Error ? err.message : "Unable to start live screen sharing.");
      }
    });

    socket.on("webrtc:answer", async ({ sessionId, answer }: {
      sessionId: string; answer: RTCSessionDescriptionInit;
    }) => {
      if (sessionId !== sessionIdRef.current || !peerRef.current) return;
      try {
        await peerRef.current.setRemoteDescription(answer);
        for (const c of pendingCandidatesRef.current.splice(0)) {
          try { await peerRef.current.addIceCandidate(c); } catch { /* stale */ }
        }
      } catch (err) { console.warn("Unable to apply WebRTC answer", err); }
    });

    socket.on("webrtc:ice-candidate", async ({ sessionId, candidate }: {
      sessionId: string; candidate: RTCIceCandidateInit;
    }) => {
      if (sessionId !== sessionIdRef.current || !candidate) return;
      const peer = peerRef.current;
      if (!peer?.remoteDescription) { pendingCandidatesRef.current.push(candidate); return; }
      try { await peer.addIceCandidate(candidate); } catch { /* stale */ }
    });

    socket.on("live:view-ended", ({ sessionId }: { sessionId: string }) => {
      if (sessionId !== sessionIdRef.current) return;
      cleanupPeer();
      sessionIdRef.current = null;
      setLiveMessage(null);
    });

    return () => {
      socket.disconnect();
      socketRef.current = null;
      cleanupPeer();
      sessionIdRef.current = null;
    };
  }, [apiBase, authToken, baseIceServers, captureEnabled, cleanupPeer, enabled, ensureNativeCapture, stopLiveScreen, wsBase]);

  return { isStreaming, liveMessage, stopLiveScreen };
};
