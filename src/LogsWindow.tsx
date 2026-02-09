import { useEffect, useState, useRef, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import "./App.css";

interface LogEntry {
  timestamp: string;
  level: string;
  message: string;
}

const LEVELS = ["ERROR", "WARN", "INFO", "DEBUG"] as const;

const LEVEL_COLORS: Record<string, string> = {
  ERROR: "#ff5555",
  WARN: "#f1fa8c",
  INFO: "#50fa7b",
  DEBUG: "#8be9fd",
};

export function LogsWindow() {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [autoScroll, setAutoScroll] = useState(true);
  const [filterText, setFilterText] = useState("");
  const [activeLevels, setActiveLevels] = useState<Set<string>>(
    () => new Set(LEVELS)
  );
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    invoke<LogEntry[]>("get_logs").then(setLogs).catch(console.error);

    const unlisten = listen<LogEntry>("log-event", (event) => {
      setLogs((prev) => [...prev, event.payload]);
    });

    return () => {
      unlisten.then((f) => f());
    };
  }, []);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.metaKey && e.altKey && (e.key === "l" || e.key === "L")) {
        e.preventDefault();
        invoke("toggle_logs").catch(console.error);
      }
      if (e.key === "Escape") {
        window.close();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  useEffect(() => {
    if (autoScroll && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [logs, autoScroll]);

  const filteredLogs = useMemo(() => {
    const lowerFilter = filterText.toLowerCase();
    return logs.filter((log) => {
      if (!activeLevels.has(log.level)) return false;
      if (lowerFilter && !log.message.toLowerCase().includes(lowerFilter) && !log.timestamp.includes(lowerFilter)) return false;
      return true;
    });
  }, [logs, activeLevels, filterText]);

  const toggleLevel = (level: string) => {
    setActiveLevels((prev) => {
      const next = new Set(prev);
      if (next.has(level)) {
        // Don't allow deselecting all
        if (next.size > 1) next.delete(level);
      } else {
        next.add(level);
      }
      return next;
    });
  };

  const copyLogs = () => {
    const text = filteredLogs
      .map((l) => `[${l.timestamp}] [${l.level}] ${l.message}`)
      .join("\n");
    navigator.clipboard.writeText(text);
  };

  const clearLogs = () => setLogs([]);

  return (
    <div style={{ padding: "20px", height: "100vh", display: "flex", flexDirection: "column", boxSizing: "border-box", background: "#1e1e1e", color: "#d4d4d4" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "10px" }}>
        <h2 style={{ margin: 0 }}>Application Logs</h2>
        <div style={{ display: "flex", gap: "10px", alignItems: "center" }}>
            <label style={{ display: "flex", alignItems: "center", gap: "5px", cursor: "pointer", userSelect: "none", fontSize: "13px" }}>
                <input 
                    type="checkbox" 
                    checked={autoScroll} 
                    onChange={(e) => setAutoScroll(e.target.checked)} 
                />
                Auto-scroll
            </label>
            <button
                onClick={clearLogs}
                style={{ padding: "6px 12px", cursor: "pointer", background: "#333", border: "1px solid #555", borderRadius: "4px", color: "#d4d4d4", fontSize: "12px" }}
            >
                Clear
            </button>
            <button 
                onClick={copyLogs} 
                style={{ padding: "6px 12px", cursor: "pointer", background: "#333", border: "1px solid #555", borderRadius: "4px", color: "#d4d4d4", fontSize: "12px" }}
            >
                Copy All
            </button>
        </div>
      </div>

      {/* Filter Bar */}
      <div style={{ display: "flex", gap: "8px", marginBottom: "10px", alignItems: "center" }}>
        {/* Level Toggles */}
        {LEVELS.map((level) => (
          <button
            key={level}
            onClick={() => toggleLevel(level)}
            style={{
              padding: "3px 10px",
              fontSize: "11px",
              fontWeight: 600,
              borderRadius: "12px",
              border: "1px solid",
              borderColor: activeLevels.has(level) ? LEVEL_COLORS[level] : "#555",
              background: activeLevels.has(level) ? `${LEVEL_COLORS[level]}22` : "transparent",
              color: activeLevels.has(level) ? LEVEL_COLORS[level] : "#888",
              cursor: "pointer",
              transition: "all 0.15s",
            }}
          >
            {level}
          </button>
        ))}

        <input
          type="text"
          placeholder="Filter logs…"
          value={filterText}
          onChange={(e) => setFilterText(e.target.value)}
          style={{
            flex: 1,
            padding: "5px 10px",
            borderRadius: "4px",
            border: "1px solid #555",
            background: "#111",
            color: "#d4d4d4",
            fontSize: "12px",
            outline: "none",
          }}
        />
        <span style={{ fontSize: "11px", color: "#888", whiteSpace: "nowrap" }}>
          {filteredLogs.length}/{logs.length}
        </span>
      </div>

      <div
        ref={scrollRef}
        style={{
          flex: 1,
          overflowY: "auto",
          fontFamily: "monospace",
          whiteSpace: "pre-wrap",
          border: "1px solid #333",
          padding: "10px",
          borderRadius: "4px",
          backgroundColor: "#000",
        }}
      >
        {filteredLogs.map((log, index) => (
          <div key={index} style={{ marginBottom: "4px" }}>
            <span style={{ color: "#888" }}>[{log.timestamp}]</span>{" "}
            <span
              style={{
                color: LEVEL_COLORS[log.level] || "#50fa7b",
                fontWeight: "bold",
              }}
            >
              [{log.level}]
            </span>{" "}
            <span>{log.message}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
