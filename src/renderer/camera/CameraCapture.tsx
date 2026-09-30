import React, { useEffect, useRef, useState } from "react";

interface CameraCaptureProps {
  onCapture: (file: File) => void;
  onClose: () => void;
}

/**
 * Live camera capture — take a photo of a whiteboard, circuit, datasheet,
 * anything physical, right from a live preview, and attach it the same way
 * as a file picked from Finder (goes through the same Attachment pipeline,
 * so vision works identically regardless of source). Uses the browser's
 * standard getUserMedia permission flow — the same mechanism voice/stt.ts
 * already relies on for the microphone — so no Electron main-process
 * permission wiring is needed beyond what mic capture already exercises.
 */
export default function CameraCapture({ onCapture, onClose }: CameraCaptureProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    navigator.mediaDevices
      .getUserMedia({ video: { facingMode: "environment", width: { ideal: 1280 } } })
      .then((stream) => {
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        if (videoRef.current) videoRef.current.srcObject = stream;
        setReady(true);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    };
  }, []);

  function capture() {
    const video = videoRef.current;
    if (!video || video.videoWidth === 0) return;
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.drawImage(video, 0, 0);
    canvas.toBlob(
      (blob) => {
        if (blob) onCapture(new File([blob], `camera-${Date.now()}.jpg`, { type: "image/jpeg" }));
      },
      "image/jpeg",
      0.9
    );
  }

  return (
    <div className="camera-overlay" role="dialog" aria-label="Camera capture">
      <div className="camera-panel">
        <div className="camera-heading">
          <span>CAMERA</span>
          <button type="button" className="camera-close" onClick={onClose} aria-label="Close camera" title="Close">
            ×
          </button>
        </div>
        {error ? (
          <div className="camera-error">Could not access the camera — {error}</div>
        ) : (
          <video ref={videoRef} className="camera-video" autoPlay muted playsInline />
        )}
        <div className="camera-actions">
          <button type="button" className="btn btn--reject" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn--approve" onClick={capture} disabled={!ready || !!error}>
            Capture
          </button>
        </div>
      </div>
    </div>
  );
}
