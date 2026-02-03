import { useEffect, useState, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import "./App.css";

interface LogEntry {
  timestamp: string;
  level: string;
  message: string;
}

export function LogsWindow() {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [autoScroll, setAutoScroll] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Fetch initial logs
    invoke<LogEntry[]>("get_logs").then(setLogs).catch(console.error);

    // Listen for new logs
    const unlisten = listen<LogEntry>("log-event", (event) => {
      setLogs((prev) => [...prev, event.payload]);
    });

    return () => {
      unlisten.then((f) => f());
    };
  }, []);

  useEffect(() => {
    // Shortcuts to close logs or toggle off
    const handleKeyDown = (e: KeyboardEvent) => {
      // Toggle Logs: Cmd+Option+L
      if (e.metaKey && e.altKey && (e.key === 'l' || e.key === 'L')) {
        e.preventDefault();
        invoke("toggle_logs").catch(console.error);
      }
      // Esc to close
      if (e.key === 'Escape') {
         window.close(); // Closes the current webview window
      }
    };
    
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  useEffect(() => {
    if (autoScroll && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [logs, autoScroll]);

  const copyLogs = () => {
    const text = logs
      .map((l) => `[${l.timestamp}] [${l.level}] ${l.message}`)
      .join("\n");
    navigator.clipboard.writeText(text);
  };

  return (
    <div style={{ padding: "20px", height: "100vh", display: "flex", flexDirection: "column", boxSizing: "border-box", background: "#1e1e1e", color: "#d4d4d4" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "10px" }}>
        <h2 style={{ margin: 0 }}>Application Logs</h2>
        <div style={{ display: "flex", gap: "10px" }}>
            <label style={{ display: "flex", alignItems: "center", gap: "5px", cursor: "pointer", userSelect: "none" }}>
                <input 
                    type="checkbox" 
                    checked={autoScroll} 
                    onChange={(e) => setAutoScroll(e.target.checked)} 
                />
                Auto-scroll
            </label>
            <button 
                onClick={copyLogs} 
                className="btn btn-primary"
                style={{ padding: "8px 16px", cursor: "pointer" }}
            >
                Copy All
            </button>
        </div>
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
        {logs.map((log, index) => (
          <div key={index} style={{ marginBottom: "4px" }}>
            <span style={{ color: "#888" }}>[{log.timestamp}]</span>{" "}
            <span
              style={{
                color: log.level === "ERROR" ? "#ff5555" : "#50fa7b",
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
