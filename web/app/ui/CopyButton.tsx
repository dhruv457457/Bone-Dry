"use client";

import { useState } from "react";

export function CopyButton({
  value,
  title = "Copy address",
  size = 12,
}: {
  value: string;
  title?: string;
  size?: number;
}) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      if (typeof navigator !== "undefined" && navigator.clipboard) {
        await navigator.clipboard.writeText(value);
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      }
    } catch {
      // Fallback for restricted clipboard contexts
      try {
        const ta = document.createElement("textarea");
        ta.value = value;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      } catch {
        // Silently fail if clipboard completely unavailable
      }
    }
  };

  return (
    <button
      type="button"
      onClick={handleCopy}
      title={copied ? "Copied!" : title}
      aria-label={copied ? "Copied address" : "Copy address"}
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "2px 4px",
        margin: "0 0 0 4px",
        background: copied ? "rgba(27, 102, 62, 0.12)" : "transparent",
        border: "none",
        borderRadius: "3px",
        cursor: "pointer",
        color: copied ? "var(--emerald, #1b663e)" : "var(--ink-soft, #5c5550)",
        opacity: copied ? 1 : 0.65,
        transition: "opacity 0.15s, color 0.15s, background 0.15s",
        verticalAlign: "middle",
        lineHeight: 1,
      }}
      onMouseEnter={(e) => {
        if (!copied) e.currentTarget.style.opacity = "1";
      }}
      onMouseLeave={(e) => {
        if (!copied) e.currentTarget.style.opacity = "0.65";
      }}
    >
      {copied ? (
        <svg
          width={size}
          height={size}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <polyline points="20 6 9 17 4 12" />
        </svg>
      ) : (
        <svg
          width={size}
          height={size}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
        </svg>
      )}
    </button>
  );
}
