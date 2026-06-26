import { useState, useEffect, useRef, useCallback } from "react";

const DATA_KEY = "arv-v5-data";
const imgKey = (id, s) => `arv-v5-img-${id}-${s}`;
const sketchKey = (trialId, idx, type) => `arv-v5-sk-${trialId}-${idx}-${type}`;

// ── Helpers ───────────────────────────────────────────────────────────────────
async function resizeImage(file, maxPx = 480) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onerror = reject;
    fr.onload = e => {
      const img = new Image();
      img.onerror = reject;
      img.onload = () => {
        let { width: w, height: h } = img;
        if (w > maxPx || h > maxPx) {
          if (w >= h) { h = Math.round(h * maxPx / w); w = maxPx; }
          else { w = Math.round(w * maxPx / h); h = maxPx; }
        }
        const cv = document.createElement("canvas");
        cv.width = w; cv.height = h;
        cv.getContext("2d").drawImage(img, 0, 0, w, h);
        resolve(cv.toDataURL("image/jpeg", 0.6));
      };
      img.src = e.target.result;
    };
    fr.readAsDataURL(file);
  });
}

async function loadTrialData() {
  try { const r = await window.storage.get(DATA_KEY, true); return r ? JSON.parse(r.value) : { trials: [] }; }
  catch { return { trials: [] }; }
}
async function saveTrialData(d) {
  const result = await window.storage.set(DATA_KEY, JSON.stringify(d), true);
  if (!result) throw new Error("Storage set returned null");
}
async function saveImg(id, side, b64) {
  if (!b64) throw new Error("No image data for " + side);
  if (b64.length > 900000) throw new Error("Image too large — try a smaller file");
  const result = await window.storage.set(imgKey(id, side), b64, true);
  if (!result) throw new Error("Failed to save image " + side);
}
async function loadImg(id, side) {
  try { const r = await window.storage.get(imgKey(id, side), true); return r ? r.value : null; }
  catch { return null; }
}
async function saveSketch(trialId, idx, type, b64) {
  if (!b64) return;
  try { await window.storage.set(sketchKey(trialId, idx, type), b64, true); } catch {}
}
async function loadSketch(trialId, idx, type) {
  try { const r = await window.storage.get(sketchKey(trialId, idx, type), true); return r ? r.value : null; }
  catch { return null; }
}
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
function genTargetRef() {
  const n = String(Math.floor(Math.random() * 100000000)).padStart(8, "0");
  return n.slice(0, 4) + " / " + n.slice(4);
}

// ── Target Dissimilarity & Non-Repetition ────────────────────────────────────
const RECENT_KEY    = "arv-v5-recent-targets";
const RECENT_WINDOW = 10; // remember last 10 trials (20 images)

// Stable identity key used for non-repetition tracking (filename is sufficient for folder-based selection)
function fileId(f) { return f.name; }

async function loadRecentTargets() {
  try {
    const r = await window.storage.get(RECENT_KEY, true);
    return r ? JSON.parse(r.value) : [];
  } catch { return []; }
}
async function addRecentTargets(idA, idB) {
  const recent = await loadRecentTargets();
  const updated = [...recent, idA, idB].slice(-(RECENT_WINDOW * 2));
  try { await window.storage.set(RECENT_KEY, JSON.stringify(updated), true); } catch {}
}

// Returns a perceptual fingerprint: 8×8 grid (192 RGB values) + global brightness & saturation
async function getImageFingerprint(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("fp:" + file.name)); };
    img.onload  = () => {
      URL.revokeObjectURL(url);
      const G  = 8;
      const cv = document.createElement("canvas");
      cv.width = G; cv.height = G;
      const ctx = cv.getContext("2d");
      ctx.drawImage(img, 0, 0, G, G);
      const px = ctx.getImageData(0, 0, G, G).data; // RGBA flat array
      const fp = [];
      let bSum = 0, sSum = 0;
      for (let i = 0; i < px.length; i += 4) {
        const r = px[i]/255, g = px[i+1]/255, b = px[i+2]/255;
        fp.push(r, g, b);
        const max = Math.max(r, g, b), min = Math.min(r, g, b);
        bSum += (max + min) / 2;
        sSum += max > 0 ? (max - min) / max : 0;
      }
      const n = G * G;
      fp.push(bSum / n, sSum / n); // global brightness, saturation as extra features
      resolve(fp);
    };
    img.src = url;
  });
}

function computeDissimilarity(fp1, fp2) {
  let sum = 0;
  for (let i = 0; i < fp1.length; i++) sum += (fp1[i] - fp2[i]) ** 2;
  return Math.sqrt(sum / fp1.length); // normalised Euclidean distance
}

// Picks the most visually dissimilar pair, preferring non-recently-used images.
// Returns { files:[a,b], score:0-1, usedFallback:bool }
async function pickSmartPair(fileList, recentIds) {
  const fresh = fileList.filter(f => !recentIds.includes(fileId(f)));
  const usedFallback = fresh.length < 2;
  const pool  = usedFallback ? fileList : fresh; // fall back to full library if needed

  const SAMPLE_MAX = 30; // cap for performance on large libraries
  const sample = pool.length <= SAMPLE_MAX
    ? [...pool]
    : [...pool].sort(() => Math.random() - 0.5).slice(0, SAMPLE_MAX);

  const fps = await Promise.all(sample.map(f => getImageFingerprint(f).catch(() => null)));

  let bestDist = -1, bestI = 0, bestJ = 1;
  for (let i = 0; i < sample.length; i++) {
    if (!fps[i]) continue;
    for (let j = i + 1; j < sample.length; j++) {
      if (!fps[j]) continue;
      const d = computeDissimilarity(fps[i], fps[j]);
      if (d > bestDist) { bestDist = d; bestI = i; bestJ = j; }
    }
  }

  // Empirical max distance ≈ 0.8; clamp score to 0-1
  const score = bestDist < 0 ? 0 : Math.min(bestDist / 0.8, 1);
  return { files: [sample[bestI], sample[bestJ]], score, usedFallback };
}

const VIEWERS_KEY = "arv-v5-viewers";
async function loadViewers() {
  try { const r = await window.storage.get(VIEWERS_KEY, true); return r ? JSON.parse(r.value) : []; }
  catch { return []; }
}
async function saveViewers(list) {
  try { await window.storage.set(VIEWERS_KEY, JSON.stringify(list), true); } catch {}
}

function sessionDurationLabel(sess) {
  if (!sess?.sessionStart || !sess?.sessionEnd) return null;
  const ms   = new Date(sess.sessionEnd) - new Date(sess.sessionStart);
  if (ms <= 0) return null;
  const mins = Math.floor(ms / 60000);
  const secs = Math.floor((ms % 60000) / 1000);
  return mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
}

function fmtDate(t) {
  if (!t) return "";
  const base = t.targetDate || t.date || "";
  return base + (t.targetTime ? " at " + t.targetTime : "");
}
function outLabel(t, which) {
  if (which === "Up") return t?.outcomeUp?.trim() || "Up ↑";
  return t?.outcomeDown?.trim() || "Down ↓";
}

// ── Styles ────────────────────────────────────────────────────────────────────
const c = {
  wrap:   { padding: "1.25rem", maxWidth: 1100, margin: "0 auto", fontFamily: "var(--font-sans)" },
  h1:     { fontSize: 21, fontWeight: 500, margin: "0 0 0.2rem", color: "var(--color-text-primary)" },
  h2:     { fontSize: 17, fontWeight: 500, margin: "0 0 0.75rem", color: "var(--color-text-primary)" },
  h3:     { fontSize: 14, fontWeight: 500, margin: "0 0 0.4rem", color: "var(--color-text-primary)" },
  muted:  { fontSize: 13, color: "var(--color-text-secondary)", margin: "0 0 1rem", lineHeight: 1.5 },
  card:   { background: "var(--color-background-primary)", border: "0.5px solid var(--color-border-tertiary)", borderRadius: "var(--border-radius-lg)", padding: "1rem 1.25rem", marginBottom: "0.75rem" },
  field:  { marginBottom: "1rem" },
  label:  { fontSize: 11, color: "var(--color-text-secondary)", marginBottom: 5, display: "block", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.04em" },
  input:  { width: "100%", padding: "8px 12px", border: "0.5px solid var(--color-border-secondary)", borderRadius: "var(--border-radius-md)", fontSize: 14, fontFamily: "var(--font-sans)", background: "var(--color-background-primary)", color: "var(--color-text-primary)", boxSizing: "border-box" },
  area:   { width: "100%", padding: "10px 12px", border: "0.5px solid var(--color-border-secondary)", borderRadius: "var(--border-radius-md)", fontSize: 14, fontFamily: "var(--font-sans)", background: "var(--color-background-primary)", color: "var(--color-text-primary)", resize: "vertical", minHeight: 140, boxSizing: "border-box", lineHeight: 1.7 },
  btn:    { cursor: "pointer", padding: "8px 16px", border: "0.5px solid var(--color-border-secondary)", borderRadius: "var(--border-radius-md)", background: "transparent", fontSize: 14, color: "var(--color-text-primary)", fontFamily: "var(--font-sans)" },
  btnP:   { cursor: "pointer", padding: "9px 20px", border: "none", borderRadius: "var(--border-radius-md)", background: "#085041", fontSize: 14, color: "white", fontFamily: "var(--font-sans)", fontWeight: 500 },
  row:    { display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" },
  sep:    { borderTop: "0.5px solid var(--color-border-tertiary)", margin: "1.25rem 0" },
  imgBox: { width: "100%", borderRadius: "var(--border-radius-md)", objectFit: "cover", height: 180, display: "block", background: "var(--color-background-secondary)" },
  imgFull: { width: "100%", borderRadius: "var(--border-radius-md)", objectFit: "contain", display: "block", background: "var(--color-background-secondary)" },
  half:   { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 },
  sxHdr:  { fontSize: 11, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: "#085041", margin: "0 0 8px", paddingBottom: 4, borderBottom: "1px solid #08504122" },
};

const STATUS = {
  viewing:   { label: "Open",            bg: "var(--color-background-info)",      tc: "var(--color-text-info)" },
  predicted: { label: "Prediction made", bg: "var(--color-background-secondary)", tc: "var(--color-text-secondary)" },
  complete:  { label: "Complete",        bg: "var(--color-background-secondary)", tc: "var(--color-text-secondary)" },
};

function Badge({ status }) {
  const s = STATUS[status] || STATUS.viewing;
  return <span style={{ fontSize: 11, padding: "2px 8px", borderRadius: 4, background: s.bg, color: s.tc, fontWeight: 500 }}>{s.label}</span>;
}
function Notify({ msg }) {
  if (!msg) return null;
  return <div style={{ background: "#085041", color: "white", padding: "10px 16px", borderRadius: "var(--border-radius-md)", fontSize: 14, marginBottom: "1rem" }}>{msg}</div>;
}
function Stepper({ steps, current }) {
  return (
    <div style={{ display: "flex", gap: 0, marginBottom: "1.5rem" }}>
      {steps.map((s, i) => (
        <div key={i} style={{ display: "flex", alignItems: "center", flex: i < steps.length - 1 ? 1 : "none" }}>
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", minWidth: 52 }}>
            <div style={{ width: 26, height: 26, borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 600, background: i <= current ? "#085041" : "var(--color-background-secondary)", color: i <= current ? "white" : "var(--color-text-secondary)", border: i > current ? "0.5px solid var(--color-border-secondary)" : "none" }}>
              {i < current ? "✓" : i + 1}
            </div>
            <span style={{ fontSize: 10, color: i === current ? "var(--color-text-primary)" : "var(--color-text-secondary)", marginTop: 3, textAlign: "center", lineHeight: 1.2 }}>{s}</span>
          </div>
          {i < steps.length - 1 && <div style={{ flex: 1, height: "0.5px", background: i < current ? "#085041" : "var(--color-border-tertiary)", margin: "0 4px", marginBottom: 14 }} />}
        </div>
      ))}
    </div>
  );
}
function TrialImage({ trialId, side, style }) {
  const [src, setSrc] = useState(null);
  useEffect(() => {
    if (trialId && side) loadImg(trialId, side).then(s => { if (s) setSrc(s); });
  }, [trialId, side]);
  if (!src) return <div style={{ ...style, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, color: "var(--color-text-secondary)" }}>Loading…</div>;
  return <img src={src} style={style} alt={`Image ${side}`} />;
}
async function fileToBase64(file) {
  try { return await resizeImage(file); } catch {}
  const b64 = await new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onerror = rej;
    fr.onload = e => res(e.target.result);
    fr.readAsDataURL(file);
  });
  if (b64.length > 900000) throw new Error("Image is too large. Try a smaller or different file (JPEG/PNG recommended).");
  return b64;
}

function ImageUpload({ label, hint, onChange, status, fileName }) {
  return (
    <div style={c.field}>
      <label style={c.label}>{label}</label>
      {hint && <p style={{ fontSize: 12, color: "var(--color-text-secondary)", margin: "0 0 6px" }}>{hint}</p>}
      <div style={{ border: "1.5px dashed var(--color-border-secondary)", borderRadius: "var(--border-radius-md)", padding: "1rem 1.25rem", background: "var(--color-background-secondary)" }}>
        <input type="file" accept="image/*" style={{ fontSize: 13, cursor: "pointer", display: "block", marginBottom: 6 }}
          onChange={e => e.target.files[0] && onChange(e.target.files[0])} />
        {status === "loading" && <p style={{ fontSize: 12, color: "var(--color-text-secondary)", margin: 0 }}>Processing…</p>}
        {status === "ready"   && <p style={{ fontSize: 12, color: "var(--color-text-success)", margin: 0 }}>✓ {fileName}</p>}
        {status === "error"   && <p style={{ fontSize: 12, color: "var(--color-text-danger)", margin: 0 }}>✗ Failed to load — try another file</p>}
        {!status              && <p style={{ fontSize: 12, color: "var(--color-text-secondary)", margin: 0 }}>No preview shown — images stay hidden until judging</p>}
      </div>
    </div>
  );
}

function BatchUpload({ onPick }) {
  const [files, setFiles]               = useState([]);
  const [picking, setPicking]           = useState(false);
  const [loading, setLoading]           = useState(false);
  const [msg, setMsg]                   = useState(null);
  const [dissimilarityScore, setDScore] = useState(null);
  const [fallbackUsed, setFallback]     = useState(false);
  const folderInputRef                  = useRef(null);

  async function doPickSmart(fileList) {
    if (!fileList || fileList.length < 2) return;
    setPicking(true);
    setMsg(null);
    setDScore(null);
    try {
      const recentIds = await loadRecentTargets();
      const { files: [fa, fb], score, usedFallback } = await pickSmartPair(fileList, recentIds);
      const [a, b] = await Promise.all([fa, fb].map(fileToBase64));
      onPick(a, b, fa.name, fb.name);
      setDScore(score);
      setFallback(usedFallback);
      const pct   = Math.round(score * 100);
      const grade = score >= 0.75 ? "excellent" : score >= 0.5 ? "good" : score >= 0.25 ? "moderate" : "low";
      let m = `✓ ${fa.name} & ${fb.name} — dissimilarity ${pct}% (${grade})`;
      if (usedFallback) m += " · ⚠ All images recently used — repetition guard bypassed";
      setMsg(m);
    } catch { setMsg("Error processing images — try a different selection"); setDScore(null); }
    setPicking(false);
  }

  async function openFolder() {
    setMsg(null);
    // ── Try modern File System Access API (Chrome/Edge) ──────────────────────
    if ("showDirectoryPicker" in window) {
      setLoading(true);
      try {
        const dir  = await window.showDirectoryPicker({ mode: "read" });
        const imgs = [];
        for await (const entry of dir.values()) {
          if (entry.kind === "file" && /\.(jpe?g|png|gif|webp)$/i.test(entry.name)) {
            imgs.push(await entry.getFile());
          }
        }
        setLoading(false);
        if (imgs.length === 0) { setMsg("No images found in that folder"); return; }
        setFiles(imgs);
        setMsg(`✓ ${imgs.length} image${imgs.length !== 1 ? "s" : ""} loaded from folder`);
        await doPickSmart(imgs);
        return;
      } catch (e) {
        setLoading(false);
        if (e.name === "AbortError") return;           // user cancelled — do nothing
        // SecurityError in iframe → fall through to webkitdirectory
      }
    }
    // ── Fallback: webkitdirectory file input (works in iframes) ──────────────
    const input = folderInputRef.current;
    if (input) {
      input.setAttribute("webkitdirectory", "");
      input.click();
    }
  }

  function handleFolderInput(e) {
    const imgs = Array.from(e.target.files).filter(f => f.type.startsWith("image/"));
    if (imgs.length === 0) { setMsg("No images found in selected folder"); return; }
    setFiles(imgs);
    setMsg(`✓ ${imgs.length} image${imgs.length !== 1 ? "s" : ""} loaded from folder`);
    doPickSmart(imgs);
    // Reset so the same folder can be re-selected if needed
    e.target.value = "";
  }

  function handleManualFiles(e) {
    const list = Array.from(e.target.files);
    setFiles(list);
    setMsg(list.length > 0 ? `✓ ${list.length} image${list.length !== 1 ? "s" : ""} loaded` : null);
  }

  return (
    <div style={c.field}>
      {/* Hidden folder input — attribute set programmatically before click */}
      <input ref={folderInputRef} type="file" accept="image/*" multiple
        style={{ display: "none" }} onChange={handleFolderInput} />

      <label style={c.label}>Image library</label>
      <p style={{ fontSize: 12, color: "var(--color-text-secondary)", margin: "0 0 10px", lineHeight: 1.5 }}>
        Select a folder from your PC — the app loads all images inside and picks the 2 most visually
        dissimilar images (maximising contrast for best RV conditions). Images used in recent trials
        are automatically excluded to prevent repetition.
      </p>

      {/* Primary action: open folder */}
      <div style={{ ...c.row, marginBottom: "0.75rem", flexWrap: "wrap" }}>
        <button style={{ ...c.btnP }} disabled={loading || picking} onClick={openFolder}>
          {loading ? "Loading folder…" : files.length > 0 ? "📁 Change folder" : "📁 Open folder"}
        </button>
        {files.length >= 2 && (
          <button style={{ ...c.btn }} disabled={picking} onClick={() => doPickSmart(files)}>
            {picking ? "Analysing…" : "🎲 Re-roll (smart)"}
          </button>
        )}
      </div>

      {/* Fallback: individual file select */}
      <label style={{ fontSize: 11, color: "var(--color-text-secondary)", cursor: "pointer", textDecoration: "underline", marginBottom: "0.5rem", display: "inline-block" }}>
        Or pick files individually
        <input type="file" accept="image/*" multiple style={{ display: "none" }} onChange={handleManualFiles} />
      </label>

      {files.length > 0 && (
        <p style={{ fontSize: 12, color: "var(--color-text-secondary)", margin: "2px 0 0" }}>
          {files.length} image{files.length !== 1 ? "s" : ""} in library
        </p>
      )}
      {msg && (
        <p style={{ fontSize: 12, color: msg.startsWith("✓") ? "var(--color-text-success)" : "var(--color-text-danger)", margin: "4px 0 0" }}>
          {msg}
        </p>
      )}
      {dissimilarityScore !== null && (
        <div style={{ marginTop: 8 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 3 }}>
            <span style={{ fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.04em", color: "var(--color-text-secondary)" }}>
              Visual Dissimilarity
            </span>
            <span style={{ fontSize: 12, fontWeight: 600, color: dissimilarityScore >= 0.75 ? "#085041" : dissimilarityScore >= 0.5 ? "#2980b9" : dissimilarityScore >= 0.25 ? "#e67e22" : "var(--color-text-danger)" }}>
              {Math.round(dissimilarityScore * 100)}%
            </span>
          </div>
          <div style={{ height: 6, background: "var(--color-background-secondary)", borderRadius: 3, overflow: "hidden", border: "0.5px solid var(--color-border-tertiary)" }}>
            <div style={{ height: "100%", width: `${Math.round(dissimilarityScore * 100)}%`, borderRadius: 3, transition: "width 0.4s ease", background: dissimilarityScore >= 0.75 ? "#085041" : dissimilarityScore >= 0.5 ? "#2980b9" : dissimilarityScore >= 0.25 ? "#e67e22" : "#c0392b" }} />
          </div>
          {fallbackUsed && (
            <p style={{ fontSize: 11, color: "var(--color-text-warning)", margin: "4px 0 0" }}>
              ⚠ Library too small to fully exclude recent targets — consider adding more images
            </p>
          )}
        </div>
      )}
    </div>
  );
}

// ── Sketch Canvas ─────────────────────────────────────────────────────────────
function SketchCanvas({ onExport, height = 220, label, hint }) {
  const canvasRef = useRef(null);
  const isDrawingRef = useRef(false);
  const lastPosRef = useRef(null);
  const hasDrawingRef = useRef(false);
  const onExportRef = useRef(onExport);
  useEffect(() => { onExportRef.current = onExport; }, [onExport]);

  // Drawing state via refs so touch handlers don't need recreation
  const toolRef = useRef("pen");
  const colorRef = useRef("#1a1a1a");
  const lineWidthRef = useRef(2);
  const [tool, setToolState] = useState("pen");
  const [color, setColorState] = useState("#1a1a1a");
  const [lineWidth, setLineWidthState] = useState(2);

  function setTool(v)      { setToolState(v);      toolRef.current = v; }
  function setColor(v)     { setColorState(v);     colorRef.current = v; }
  function setLineWidth(v) { setLineWidthState(v); lineWidthRef.current = v; }

  // Initialize canvas white background on mount
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }, []);

  function getPos(e) {
    const canvas = canvasRef.current;
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const src = e.touches ? e.touches[0] : e;
    return {
      x: (src.clientX - rect.left) * scaleX,
      y: (src.clientY - rect.top) * scaleY,
    };
  }

  const handleStart = useCallback((e) => {
    e.preventDefault();
    isDrawingRef.current = true;
    hasDrawingRef.current = true;
    const pos = getPos(e);
    lastPosRef.current = pos;
    const ctx = canvasRef.current.getContext("2d");
    const lw = toolRef.current === "eraser" ? lineWidthRef.current * 6 : lineWidthRef.current;
    ctx.beginPath();
    ctx.arc(pos.x, pos.y, lw / 2, 0, Math.PI * 2);
    ctx.fillStyle = toolRef.current === "eraser" ? "#ffffff" : colorRef.current;
    ctx.fill();
  }, []);

  const handleMove = useCallback((e) => {
    e.preventDefault();
    if (!isDrawingRef.current || !lastPosRef.current) return;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d");
    const pos = getPos(e);
    const lw = toolRef.current === "eraser" ? lineWidthRef.current * 6 : lineWidthRef.current;
    ctx.beginPath();
    ctx.moveTo(lastPosRef.current.x, lastPosRef.current.y);
    ctx.lineTo(pos.x, pos.y);
    ctx.strokeStyle = toolRef.current === "eraser" ? "#ffffff" : colorRef.current;
    ctx.lineWidth = lw;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.stroke();
    lastPosRef.current = pos;
  }, []);

  const handleEnd = useCallback((e) => {
    if (e) e.preventDefault();
    if (!isDrawingRef.current) return;
    isDrawingRef.current = false;
    lastPosRef.current = null;
    if (hasDrawingRef.current) {
      const data = canvasRef.current.toDataURL("image/jpeg", 0.7);
      onExportRef.current?.(data);
    }
  }, []);

  // Register touch events with passive:false to prevent scroll interference
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.addEventListener("touchstart", handleStart, { passive: false });
    canvas.addEventListener("touchmove",  handleMove,  { passive: false });
    canvas.addEventListener("touchend",   handleEnd,   { passive: false });
    return () => {
      canvas.removeEventListener("touchstart", handleStart);
      canvas.removeEventListener("touchmove",  handleMove);
      canvas.removeEventListener("touchend",   handleEnd);
    };
  }, [handleStart, handleMove, handleEnd]);

  // Track mouse at window level so strokes continue when the cursor
  // leaves the canvas boundary and resume seamlessly on re-entry
  useEffect(() => {
    window.addEventListener("mousemove", handleMove);
    window.addEventListener("mouseup",   handleEnd);
    return () => {
      window.removeEventListener("mousemove", handleMove);
      window.removeEventListener("mouseup",   handleEnd);
    };
  }, [handleMove, handleEnd]);

  function clearCanvas() {
    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    hasDrawingRef.current = false;
    onExportRef.current?.(null);
  }

  const COLORS = ["#1a1a1a", "#666666", "#c0392b", "#2980b9", "#27ae60", "#e67e22", "#8e44ad", "#16a085"];
  const toolbarStyle = {
    display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap",
    padding: "6px 10px",
    background: "var(--color-background-secondary)",
    border: "0.5px solid var(--color-border-secondary)",
    borderBottom: "none",
    borderRadius: "var(--border-radius-md) var(--border-radius-md) 0 0",
  };

  return (
    <div style={c.field}>
      {label && <label style={c.label}>{label}</label>}
      {hint  && <p style={{ fontSize: 12, color: "var(--color-text-secondary)", margin: "0 0 6px" }}>{hint}</p>}

      {/* Toolbar */}
      <div style={toolbarStyle}>
        {[["pen","✏️ Pen"],["eraser","⬜ Eraser"]].map(([t, lbl]) => (
          <button key={t} style={{ ...c.btn, padding: "4px 10px", fontSize: 12, ...(tool === t ? { background: "#085041", color: "white", borderColor: "#085041" } : {}) }}
            onClick={() => setTool(t)}>{lbl}</button>
        ))}

        <div style={{ display: "flex", gap: 3, alignItems: "center" }}>
          {COLORS.map(col => (
            <button key={col} onClick={() => { setColor(col); setTool("pen"); }}
              style={{ width: 17, height: 17, borderRadius: "50%", background: col, border: color === col && tool === "pen" ? "2px solid var(--color-text-primary)" : "1.5px solid var(--color-border-secondary)", cursor: "pointer", padding: 0, flexShrink: 0 }} />
          ))}
        </div>

        <select value={lineWidth} onChange={e => setLineWidth(Number(e.target.value))}
          style={{ ...c.input, width: "auto", padding: "3px 8px", fontSize: 12, height: 28 }}>
          <option value={1}>Fine</option>
          <option value={2}>Normal</option>
          <option value={4}>Thick</option>
          <option value={8}>Heavy</option>
        </select>

        <button style={{ ...c.btn, padding: "4px 10px", fontSize: 12, marginLeft: "auto" }} onClick={clearCanvas}>🗑 Clear</button>
      </div>

      {/* Canvas */}
      <canvas
        ref={canvasRef}
        width={1200}
        height={height * 2}
        style={{
          width: "100%", height, display: "block",
          border: "1.5px solid #1a1a1a",
          borderRadius: "var(--border-radius-md)",
          cursor: tool === "eraser" ? "cell" : "crosshair",
          touchAction: "none",
          background: "#ffffff",
        }}
        onMouseDown={handleStart}
      />
    </div>
  );
}

// ── Session Timer (live elapsed clock shown while viewer works) ───────────────
function SessionTimer() {
  const startRef = useRef(Date.now());
  const [elapsed, setElapsed] = useState(0); // seconds

  useEffect(() => {
    const id = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startRef.current) / 1000));
    }, 1000);
    return () => clearInterval(id);
  }, []);

  const mins = Math.floor(elapsed / 60);
  const secs = elapsed % 60;

  // Colour cues: grey early on, green in the 15–45 min sweet spot, amber if very long
  const timerColor = elapsed < 900
    ? "var(--color-text-secondary)"   // < 15 min — warming up
    : elapsed < 2700                  // 15–45 min — ideal range
    ? "#085041"
    : "var(--color-text-warning)";    // > 45 min — consider wrapping up

  const hint = elapsed < 300  ? "Take your time — don't rush"
    : elapsed < 900  ? "Settling in…"
    : elapsed < 1800 ? "Good depth — keep going"
    : elapsed < 2700 ? "Strong session length"
    : "Consider wrapping up soon";

  return (
    <div style={{
      display: "flex",
      alignItems: "center",
      gap: 12,
      background: "var(--color-background-secondary)",
      border: "0.5px solid var(--color-border-tertiary)",
      borderRadius: "var(--border-radius-md)",
      padding: "10px 16px",
      marginBottom: "1rem",
    }}>
      <span style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--color-text-secondary)" }}>
        Session
      </span>
      <span style={{ fontSize: 22, fontWeight: 700, fontVariantNumeric: "tabular-nums", color: timerColor, letterSpacing: "0.02em", minWidth: 54 }}>
        {mins}:{String(secs).padStart(2, "0")}
      </span>
      <span style={{ fontSize: 12, color: "var(--color-text-secondary)", fontStyle: "italic" }}>
        {hint}
      </span>
    </div>
  );
}

// ── Session Form (Structured CRV Input) ───────────────────────────────────────
// onSubmit(sessionData, ideogramData, siteSketchData)
function SessionForm({ onSubmit, saving }) {
  const sessionStart      = useRef(new Date().toISOString()); // stamped at mount
  const [ideogramDecode, setIdeogramDecode] = useState("");
  const [ideogramData,   setIdeogramData]   = useState(null);
  const [colour,    setColour]    = useState("");
  const [sound,     setSound]     = useState("");
  const [texture,   setTexture]   = useState("");
  const [smellTaste,setSmellTaste]= useState("");
  const [energy,    setEnergy]    = useState("");
  const [dims,      setDims]      = useState("");
  const [aol,       setAol]       = useState("");
  const [siteEmotions,  setSiteEmotions]  = useState("");
  const [siteSketchData,setSiteSketchData]= useState(null);
  const [description,   setDescription]  = useState("");
  const [confidence,    setConfidence]    = useState(5);

  const hasSensory = [colour, sound, texture, smellTaste, energy, dims].some(v => v.trim());
  const hasContent = description.trim() || ideogramDecode.trim() || hasSensory ||
                     siteEmotions.trim() || aol.trim() || ideogramData || siteSketchData;

  function handleSubmit() {
    const sessionData = {
      description,
      ideogramDecode,
      sensory: { colour, sound, texture, smellTaste, energy, dims },
      analyticalOverlay: aol,
      siteEmotions,
      confidence,
      sessionStart: sessionStart.current,          // when viewer began the session
      sessionEnd:   new Date().toISOString(),       // when they submitted
    };
    onSubmit(sessionData, ideogramData, siteSketchData);
  }

  const confidenceLabel = confidence <= 3 ? "Skip trade"
    : confidence <= 5 ? "Caution"
    : confidence <= 7 ? "Moderate"
    : confidence <= 8 ? "Strong signal"
    : "Act with conviction";

  const sensoryFields = [
    ["Colour", colour, setColour, "blue, grey, warm…"],
    ["Sound", sound, setSound, "quiet, rushing, hum…"],
    ["Texture", texture, setTexture, "smooth, rough, soft…"],
    ["Smell / Taste", smellTaste, setSmellTaste, "fresh, metallic, sweet…"],
    ["Energy", energy, setEnergy, "still, active, flowing…"],
    ["Dimensions", dims, setDims, "vast, confined, tall…"],
  ];

  return (
    <div>
      <SessionTimer />

      {/* ── S1: Ideogram ── */}
      <div style={c.card}>
        <p style={c.sxHdr}>S1 — Ideogram</p>
        <SketchCanvas
          label="Draw your ideogram"
          hint="First spontaneous mark — draw without thinking"
          height={450}
          onExport={setIdeogramData}
        />
        <div style={c.field}>
          <label style={c.label}>Decode — what does it feel like?</label>
          <input style={c.input} value={ideogramDecode} onChange={e => setIdeogramDecode(e.target.value)}
            placeholder="e.g. structure, water, movement, natural, man-made, hollow…" />
        </div>
      </div>

      {/* ── S2: Site Sensory + AOL ── */}
      <div style={c.card}>
        <p style={c.sxHdr}>S2 — Site Sensory</p>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 8 }}>
          {sensoryFields.map(([lbl, val, setter, ph]) => (
            <div key={lbl}>
              <label style={c.label}>{lbl}</label>
              <input style={c.input} value={val} onChange={e => setter(e.target.value)} placeholder={ph} />
            </div>
          ))}
        </div>
        <div style={c.field}>
          <label style={c.label}>Analytical Overlay (AOL)</label>
          <input style={c.input} value={aol} onChange={e => setAol(e.target.value)}
            placeholder="Any strong mental label that surfaces — acknowledge it, then move on" />
        </div>
      </div>

      {/* ── S3: Site Emotions ── */}
      <div style={c.card}>
        <p style={c.sxHdr}>S3 — Site Emotions</p>
        <textarea style={{ ...c.area, minHeight: 90 }} value={siteEmotions} onChange={e => setSiteEmotions(e.target.value)}
          placeholder="What feelings or emotions are present at the site?" />
      </div>

      {/* ── S4: Site Sketch ── */}
      <div style={c.card}>
        <p style={c.sxHdr}>S4 — Site Sketch</p>
        <SketchCanvas
          hint="Sketch key elements. Label A, B, C etc."
          height={500}
          onExport={setSiteSketchData}
        />
      </div>

      {/* ── S5: Summary ── */}
      <div style={c.card}>
        <p style={c.sxHdr}>S5 — Summary</p>
        <textarea style={c.area} value={description} onChange={e => setDescription(e.target.value)}
          placeholder="Integrate all impressions — describe the target freely. What is this place, scene, or thing? What stands out most?" />
      </div>

      {/* ── Confidence ── */}
      <div style={c.card}>
        <p style={c.sxHdr}>Confidence</p>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 8 }}>
          {[1,2,3,4,5,6,7,8,9,10].map(n => (
            <button key={n} onClick={() => setConfidence(n)}
              style={{
                width: 36, height: 36, borderRadius: "var(--border-radius-md)",
                border: "0.5px solid var(--color-border-secondary)",
                background: confidence === n ? "#085041" : "transparent",
                color: confidence === n ? "white" : "var(--color-text-primary)",
                fontWeight: 600, fontSize: 14, cursor: "pointer",
              }}>
              {n}
            </button>
          ))}
        </div>
        <p style={{ fontSize: 12, color: "var(--color-text-secondary)", margin: 0 }}>
          <strong>{confidence}/10</strong> — {confidenceLabel}
        </p>
      </div>

      <button style={{ ...c.btnP, width: "100%", opacity: (!hasContent || saving) ? 0.5 : 1 }}
        disabled={!hasContent || saving}
        onClick={handleSubmit}>
        {saving ? "Submitting…" : "Submit Session →"}
      </button>
    </div>
  );
}

// ── Session Display (Structured + Sketches) ───────────────────────────────────
function SessionDisplay({ session, trialId, sessionIdx, showConfidence = true }) {
  const [ideogram,   setIdeogram]   = useState(null);
  const [siteSketch, setSiteSketch] = useState(null);

  useEffect(() => {
    if (trialId == null || sessionIdx == null) return;
    loadSketch(trialId, sessionIdx, "ideogram").then(d => { if (d) setIdeogram(d); });
    loadSketch(trialId, sessionIdx, "site").then(d => { if (d) setSiteSketch(d); });
  }, [trialId, sessionIdx]);

  if (!session) return null;

  const isStructured = !!(session.sensory || session.ideogramDecode || session.siteEmotions);
  const sketchImgStyle = {
    width: "100%", maxHeight: 200, objectFit: "contain",
    background: "#fff", borderRadius: 6,
    border: "0.5px solid var(--color-border-tertiary)", display: "block",
  };

  if (!isStructured) {
    // Legacy plain-text session
    return (
      <div>
        <p style={{ fontSize: 13, whiteSpace: "pre-wrap", margin: "0 0 8px", lineHeight: 1.7, color: "var(--color-text-secondary)" }}>
          {session.description}
        </p>
        {showConfidence && session.confidence && (
          <ConfidencePill value={session.confidence} />
        )}
      </div>
    );
  }

  const hasSensory = session.sensory && Object.values(session.sensory).some(Boolean);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>

      {/* S1 Ideogram */}
      {(ideogram || session.ideogramDecode) && (
        <div>
          <p style={{ ...c.label, marginBottom: 4 }}>S1 — Ideogram</p>
          {ideogram && <img src={ideogram} alt="Ideogram sketch" style={{ ...sketchImgStyle, maxHeight: 120, marginBottom: 4 }} />}
          {session.ideogramDecode && (
            <p style={{ fontSize: 13, margin: 0, fontStyle: "italic", color: "var(--color-text-secondary)" }}>
              Decode: "{session.ideogramDecode}"
            </p>
          )}
        </div>
      )}

      {/* S2 Sensory */}
      {hasSensory && (
        <div>
          <p style={{ ...c.label, marginBottom: 4 }}>S2 — Site Sensory</p>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "2px 12px" }}>
            {[
              ["Colour", session.sensory.colour],
              ["Sound",  session.sensory.sound],
              ["Texture",session.sensory.texture],
              ["Sm/Tst", session.sensory.smellTaste],
              ["Energy", session.sensory.energy],
              ["Dims",   session.sensory.dims],
            ].map(([k, v]) => v ? (
              <p key={k} style={{ fontSize: 12, margin: "2px 0" }}>
                <strong style={{ color: "var(--color-text-secondary)" }}>{k}:</strong> {v}
              </p>
            ) : null)}
          </div>
          {session.analyticalOverlay && (
            <p style={{ fontSize: 12, margin: "4px 0 0", color: "var(--color-text-secondary)" }}>
              AOL: <em>{session.analyticalOverlay}</em>
            </p>
          )}
        </div>
      )}

      {/* S3 Site Emotions */}
      {session.siteEmotions && (
        <div>
          <p style={{ ...c.label, marginBottom: 4 }}>S3 — Site Emotions</p>
          <p style={{ fontSize: 13, margin: 0, lineHeight: 1.6, whiteSpace: "pre-wrap" }}>{session.siteEmotions}</p>
        </div>
      )}

      {/* S4 Site Sketch */}
      {siteSketch && (
        <div>
          <p style={{ ...c.label, marginBottom: 4 }}>S4 — Site Sketch</p>
          <img src={siteSketch} alt="Site sketch" style={sketchImgStyle} />
        </div>
      )}

      {/* S5 Summary */}
      {session.description && (
        <div>
          <p style={{ ...c.label, marginBottom: 4 }}>S5 — Summary</p>
          <p style={{ fontSize: 13, margin: 0, lineHeight: 1.7, whiteSpace: "pre-wrap" }}>{session.description}</p>
        </div>
      )}

      {/* Confidence */}
      {showConfidence && session.confidence && (
        <ConfidencePill value={session.confidence} />
      )}
    </div>
  );
}

function ConfidencePill({ value }) {
  const color = value >= 8 ? "#085041" : value >= 5 ? "var(--color-text-secondary)" : "var(--color-text-warning)";
  const label = value >= 8 ? "High confidence" : value >= 5 ? "Moderate confidence" : "Low confidence";
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <div style={{ display: "flex", gap: 2 }}>
        {[1,2,3,4,5,6,7,8,9,10].map(n => (
          <div key={n} style={{ width: 14, height: 6, borderRadius: 2, background: n <= value ? color : "var(--color-background-secondary)" }} />
        ))}
      </div>
      <span style={{ fontSize: 12, color, fontWeight: 500 }}>{value}/10 · {label}</span>
    </div>
  );
}

// ── New Trial Form ────────────────────────────────────────────────────────────
function NewTrialForm({ onBack, onSave, saving, soloMode }) {
  const today = new Date().toISOString().split("T")[0];

  const [imgA, setImgA] = useState(null);
  const [imgB, setImgB] = useState(null);
  const [question, setQuestion] = useState("");
  const [market, setMarket]     = useState("");
  const [outcomeUp, setOutcomeUp]     = useState("");
  const [outcomeDown, setOutcomeDown] = useState("");
  const [targetDate, setTargetDate]   = useState(today);
  const [targetTime, setTargetTime]   = useState("");
  const [trialNotes, setTrialNotes]   = useState("");
  const [statusA, setStatusA] = useState(null);
  const [statusB, setStatusB] = useState(null);
  const [nameA, setNameA] = useState("");
  const [nameB, setNameB] = useState("");
  const [uploadMode, setUploadMode] = useState("batch");
  const [validationMsg, setValidationMsg]   = useState(null);
  const [cue, setCue]                       = useState("");
  const [viewers, setViewers]               = useState([]);
  const [assignedViewers, setAssignedViewers] = useState([]);

  useEffect(() => { loadViewers().then(setViewers); }, []);

  function toggleViewer(v) {
    setAssignedViewers(prev => prev.includes(v) ? prev.filter(x => x !== v) : [...prev, v]);
  }

  async function handleImgFile(file, side) {
    const setSt  = side === "A" ? setStatusA : setStatusB;
    const setImg = side === "A" ? setImgA    : setImgB;
    const setNm  = side === "A" ? setNameA   : setNameB;
    setSt("loading"); setNm(file.name);
    try { setImg(await fileToBase64(file)); setSt("ready"); }
    catch(e) { setSt("error"); setValidationMsg(e.message || "Failed to load image — try a JPEG or PNG file"); }
  }

  function handleSubmit() {
    setValidationMsg(null);
    if (!imgA || !imgB) { setValidationMsg("Please upload both images before saving."); return; }
    if (!targetDate) { setValidationMsg("Please set a target date."); return; }
    onSave({
      question, market, outcomeUp, outcomeDown, cue,
      targetDate, targetTime, notes: trialNotes,
      targetRef: genTargetRef(), upImage: Math.random() < 0.5 ? "A" : "B",
      assignedViewers,
      imgA, imgB,
      nameA, nameB,  // filenames for non-repetition tracking
    });
  }

  const presets = [
    { label: "Silver futures", market: "Silver",  outcomeUp: "Closes UP ↑",  outcomeDown: "Closes DOWN ↓" },
    { label: "Sports game",    market: "Sports",  outcomeUp: "Team A wins",   outcomeDown: "Team B wins" },
    { label: "Crypto",         market: "Crypto",  outcomeUp: "Price UP ↑",    outcomeDown: "Price DOWN ↓" },
    { label: "Stock",          market: "Stocks",  outcomeUp: "Closes UP ↑",   outcomeDown: "Closes DOWN ↓" },
  ];

  return (
    <div style={c.wrap}>
      <button style={{ ...c.btn, marginBottom: "1rem" }} onClick={onBack}>← Back</button>
      <h2 style={c.h2}>New Trial{soloMode ? " (Solo)" : ""}</h2>
      {soloMode && <Stepper steps={STEPS} current={0} />}

      <div style={c.field}>
        <label style={c.label}>Quick preset</label>
        <div style={{ ...c.row, flexWrap: "wrap" }}>
          {presets.map(p => (
            <button key={p.label} style={{ ...c.btn, fontSize: 12, padding: "6px 12px" }}
              onClick={() => { setMarket(p.market); setOutcomeUp(p.outcomeUp); setOutcomeDown(p.outcomeDown); }}>
              {p.label}
            </button>
          ))}
        </div>
      </div>
      <div style={c.sep} />

      <div style={c.field}>
        <label style={c.label}>Event / Question <span style={{ fontWeight: 400, textTransform: "none", letterSpacing: 0 }}>(optional)</span></label>
        <input style={c.input} value={question} onChange={e => setQuestion(e.target.value)}
          placeholder="e.g. Will the Lakers beat the Celtics on Jan 15?" />
      </div>
      <div style={c.field}>
        <label style={c.label}>Market / Event type</label>
        <input style={c.input} value={market} onChange={e => setMarket(e.target.value)}
          placeholder="e.g. Silver, NBA, Bitcoin, NFL…" />
      </div>

      <div style={{ ...c.half, marginBottom: "1rem" }}>
        <div style={c.field}>
          <label style={c.label}>Outcome A label <span style={{ fontWeight: 400, textTransform: "none" }}>(Image A wins)</span></label>
          <input style={c.input} value={outcomeUp} onChange={e => setOutcomeUp(e.target.value)} placeholder="e.g. Lakers WIN" />
        </div>
        <div style={c.field}>
          <label style={c.label}>Outcome B label <span style={{ fontWeight: 400, textTransform: "none" }}>(Image B wins)</span></label>
          <input style={c.input} value={outcomeDown} onChange={e => setOutcomeDown(e.target.value)} placeholder="e.g. Lakers LOSE" />
        </div>
      </div>
      <div style={c.sep} />

      <div style={c.half}>
        <div style={c.field}><label style={c.label}>Target date</label><input style={c.input} type="date" value={targetDate} onChange={e => setTargetDate(e.target.value)} /></div>
        <div style={c.field}><label style={c.label}>Time <span style={{ fontWeight: 400, textTransform: "none" }}>(optional)</span></label><input style={c.input} type="time" value={targetTime} onChange={e => setTargetTime(e.target.value)} /></div>
      </div>

      <div style={c.field}>
        <label style={c.label}>Notes <span style={{ fontWeight: 400, textTransform: "none" }}>(optional)</span></label>
        <textarea style={{ ...c.area, minHeight: 80 }} value={trialNotes} onChange={e => setTrialNotes(e.target.value)}
          placeholder="Any notes about this trial…" />
      </div>

      <div style={c.field}>
        <label style={c.label}>Viewer cue <span style={{ fontWeight: 400, textTransform: "none" }}>(optional)</span></label>
        <p style={{ fontSize: 12, color: "var(--color-text-secondary)", margin: "0 0 6px", lineHeight: 1.5 }}>
          Title shown to the viewer when they begin this trial. Leave blank to use the default "Remote Viewing Trial".
        </p>
        <input style={c.input} value={cue} onChange={e => setCue(e.target.value)}
          placeholder="e.g. Complete this trial by 7pm today" />
      </div>
      <div style={c.sep} />

      <div style={{ ...c.field, marginBottom: "0.75rem" }}>
        <label style={c.label}>Image selection method</label>
        <div style={c.row}>
          {[["manual","Upload 2 manually"],["batch","Pick from folder / batch"]].map(([v,l]) => (
            <button key={v} style={{ ...c.btn, fontSize: 13, ...(uploadMode === v ? { background: "#085041", color: "white", borderColor: "#085041" } : {}) }}
              onClick={() => { setUploadMode(v); setImgA(null); setImgB(null); setStatusA(null); setStatusB(null); }}>{l}</button>
          ))}
        </div>
      </div>

      {uploadMode === "manual" ? (
        <>
          <div style={{ ...c.card, background: "var(--color-background-secondary)", marginBottom: "1rem" }}>
            <p style={{ fontSize: 12, color: "var(--color-text-secondary)", margin: 0, lineHeight: 1.6 }}>
              Choose two visually <strong>very different</strong> images. No preview is shown — pick blindly to avoid bias. Outcome assignment is randomized and sealed.
            </p>
          </div>
          <ImageUpload label="Image A" onChange={f => handleImgFile(f, "A")} status={statusA} fileName={nameA} />
          <ImageUpload label="Image B — should look clearly different from A" onChange={f => handleImgFile(f, "B")} status={statusB} fileName={nameB} />
        </>
      ) : (
        <>
          <div style={{ ...c.card, background: "var(--color-background-secondary)", marginBottom: "1rem" }}>
            <p style={{ fontSize: 12, color: "var(--color-text-secondary)", margin: 0, lineHeight: 1.6 }}>
              Open a folder from your PC — all images inside are loaded as your library and the 2 most visually dissimilar are selected automatically. You can re-roll at any time.
            </p>
          </div>
          <BatchUpload onPick={(a, b, nA, nB) => { setImgA(a); setImgB(b); setNameA(nA); setNameB(nB); setStatusA("ready"); setStatusB("ready"); }} />
          {imgA && imgB && <p style={{ fontSize: 13, color: "var(--color-text-success)", margin: "0 0 1rem" }}>✓ 2 images randomly selected and sealed</p>}
        </>
      )}

      {viewers.length > 0 && (
        <>
          <div style={c.sep} />
          <div style={c.field}>
            <label style={c.label}>Assign to specific viewers <span style={{ fontWeight: 400, textTransform: "none", letterSpacing: 0 }}>(optional)</span></label>
            <p style={{ fontSize: 12, color: "var(--color-text-secondary)", margin: "0 0 8px" }}>
              Leave all unchecked to allow any registered viewer to participate. Check names to restrict this trial to selected viewers only.
            </p>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {viewers.map(v => (
                <label key={v} style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer", padding: "7px 12px", background: assignedViewers.includes(v) ? "#08504110" : "var(--color-background-secondary)", borderRadius: "var(--border-radius-md)", border: assignedViewers.includes(v) ? "0.5px solid #085041" : "0.5px solid var(--color-border-secondary)" }}>
                  <input type="checkbox" checked={assignedViewers.includes(v)} onChange={() => toggleViewer(v)}
                    style={{ accentColor: "#085041", width: 16, height: 16 }} />
                  <span style={{ fontSize: 13, fontWeight: assignedViewers.includes(v) ? 500 : 400 }}>{v}</span>
                </label>
              ))}
            </div>
            {assignedViewers.length > 0 && (
              <p style={{ fontSize: 12, color: "#085041", margin: "8px 0 0" }}>
                {assignedViewers.length} viewer{assignedViewers.length !== 1 ? "s" : ""} assigned: {assignedViewers.join(", ")}
              </p>
            )}
          </div>
        </>
      )}

      {validationMsg && <p style={{ fontSize: 13, color: "var(--color-text-danger)", margin: "0.5rem 0" }}>{validationMsg}</p>}
      <button style={{ ...c.btnP, width: "100%", marginTop: "0.75rem", opacity: saving ? 0.7 : 1 }}
        disabled={saving} onClick={handleSubmit}>
        {saving ? "Creating…" : soloMode ? "Create & Start Viewing →" : "Create Trial"}
      </button>
    </div>
  );
}

// ── Role Select ───────────────────────────────────────────────────────────────
function RoleSelect({ onSelect }) {
  const [picked, setPicked]             = useState(null);
  const [name, setName]                 = useState("");
  const [savedViewers, setSavedViewers] = useState([]);
  const [addingNew, setAddingNew]       = useState(false);
  const [managing, setManaging]         = useState(false);

  useEffect(() => { loadViewers().then(setSavedViewers); }, []);

  const needsName   = picked === "viewer" || picked === "solo";
  const showDropdown = needsName && savedViewers.length > 0 && !addingNew;

  async function handleEnter() {
    const trimmed = name.trim();
    if (needsName && trimmed && !savedViewers.includes(trimmed)) {
      const updated = [...savedViewers, trimmed].sort((a, b) => a.localeCompare(b));
      await saveViewers(updated);
      setSavedViewers(updated);
    }
    onSelect(picked, trimmed);
  }

  async function deleteViewer(v) {
    const updated = savedViewers.filter(x => x !== v);
    setSavedViewers(updated);
    await saveViewers(updated);
    if (name === v) setName("");
  }

  const roles = [
    { id: "solo",        label: "Solo",        desc: "You do everything alone" },
    { id: "coordinator", label: "Coordinator / Judge", desc: "Create trials, judge sessions, record outcomes" },
    { id: "viewer",      label: "Viewer",      desc: "Submit your remote viewing session" },
  ];

  return (
    <div style={{ ...c.wrap, paddingTop: "2rem" }}>
      <h1 style={{ ...c.h1, fontSize: 23, marginBottom: "0.25rem" }}>ARV Experiment</h1>
      <p style={{ ...c.muted, marginBottom: "0.5rem" }}>Associative Remote Viewing · Silver · Sports · Crypto</p>
      <div style={{ ...c.card, background: "var(--color-background-secondary)", marginBottom: "1.5rem" }}>
        <p style={{ fontWeight: 500, fontSize: 13, margin: "0 0 6px" }}>Who picks which role?</p>
        <p style={{ fontSize: 12, color: "var(--color-text-secondary)", margin: "0 0 4px" }}>
          <strong>2 people:</strong> One = Viewer · Other = Coordinator + Judge
        </p>
        <p style={{ fontSize: 12, color: "var(--color-text-secondary)", margin: 0 }}>
          <strong>3 people:</strong> Coordinator · Viewer · Judge — cleanest separation
        </p>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: "1rem" }}>
        {roles.map(r => (
          <button key={r.id}
            style={{ ...c.btn, textAlign: "left", padding: "11px 16px", display: "flex", justifyContent: "space-between", alignItems: "center", ...(picked === r.id ? { background: "#085041", color: "white", borderColor: "#085041", fontWeight: 600 } : {}) }}
            onClick={() => setPicked(r.id)}>
            <span style={{ fontWeight: 500 }}>{r.label}</span>
            <span style={{ fontSize: 12, color: picked === r.id ? "rgba(255,255,255,0.75)" : "var(--color-text-secondary)" }}>{r.desc}</span>
          </button>
        ))}
      </div>

      {needsName && (
        <div style={c.field}>
          {showDropdown ? (
            <>
              <label style={c.label}>Select your name</label>
              <select style={{ ...c.input, marginBottom: 8 }} value={name} onChange={e => setName(e.target.value)}>
                <option value="">— choose viewer —</option>
                {savedViewers.map(v => <option key={v} value={v}>{v}</option>)}
              </select>
              <button style={{ ...c.btn, fontSize: 12, padding: "5px 12px" }}
                onClick={() => { setAddingNew(true); setName(""); }}>
                + Register new viewer
              </button>
            </>
          ) : (
            <>
              <label style={c.label}>{savedViewers.length > 0 ? "New viewer name" : "Your name"}</label>
              <input style={c.input} placeholder="Enter your name" value={name}
                onChange={e => setName(e.target.value)} autoFocus />
              {savedViewers.length > 0 && (
                <button style={{ ...c.btn, fontSize: 12, padding: "5px 12px", marginTop: 6 }}
                  onClick={() => { setAddingNew(false); setName(""); }}>
                  ← Back to viewer list
                </button>
              )}
            </>
          )}
        </div>
      )}

      {/* Viewer account management — always visible if viewers exist */}
      {savedViewers.length > 0 && (
        <div style={{ ...c.card, background: "var(--color-background-secondary)", marginBottom: "1rem" }}>
          <div style={{ ...c.row, marginBottom: managing ? 10 : 0 }}>
            <span style={{ fontSize: 13, fontWeight: 500 }}>Viewer accounts ({savedViewers.length})</span>
            <button style={{ ...c.btn, fontSize: 12, padding: "3px 10px", marginLeft: "auto" }}
              onClick={() => setManaging(m => !m)}>
              {managing ? "Done" : "⚙ Manage"}
            </button>
          </div>
          {managing && (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {savedViewers.map(v => (
                <div key={v} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "6px 10px", background: "var(--color-background-primary)", borderRadius: "var(--border-radius-md)", border: "0.5px solid var(--color-border-tertiary)" }}>
                  <span style={{ fontSize: 13 }}>{v}</span>
                  <button style={{ ...c.btn, fontSize: 11, padding: "2px 8px", color: "var(--color-text-danger)", borderColor: "var(--color-border-tertiary)" }}
                    onClick={() => deleteViewer(v)}>
                    Delete
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <button style={{ ...c.btnP, width: "100%", marginTop: "0.5rem" }}
        disabled={!picked || (needsName && !name.trim())}
        onClick={handleEnter}>
        Enter →
      </button>
    </div>
  );
}

// ── Solo Mode ─────────────────────────────────────────────────────────────────
const STEPS = ["Setup", "View", "Judge", "Predict", "Done"];
function stepIdx(status) { return { viewing: 1, judging: 2, predicted: 3, complete: 4 }[status] ?? 0; }

function SoloView({ viewerName, trials, saving, notify, onCreate, onUpdate, onRepeat }) {
  const [page, setPage] = useState("list");
  const [tid,  setTid]  = useState(null);
  const [soloVotes, setSoloVotes] = useState({});
  const [soloNotes, setSoloNotes] = useState({});
  const [actual, setActual] = useState("");
  const [meditationDone, setMeditationDone] = useState(false);

  const soloTrials = trials.filter(t => t.solo);
  const trial = tid ? trials.find(t => t.id === tid) : null;

  if (page === "new") {
    return <NewTrialForm soloMode saving={saving} onBack={() => setPage("list")}
      onSave={async (fields) => {
        const t = { id: uid(), ...fields, solo: true, soloViewer: viewerName, status: "viewing", sessions: [], judgments: [], prediction: null, actual: null };
        await onCreate(t);
        setPage("list");
      }} />;
  }

  if (page === "trial" && trial) {
    const step      = stepIdx(trial.status);
    const sessions  = trial.sessions || [];
    const mySession = sessions[0];
    const upL       = outLabel(trial, "Up");
    const downL     = outLabel(trial, "Down");
    const allVoted  = sessions.length > 0 && sessions.every((_, i) => soloVotes[i]);
    const aCount    = Object.values(soloVotes).filter(v => v === "A").length;
    const bCount    = Object.values(soloVotes).filter(v => v === "B").length;

    return (
      <div style={c.wrap}>
        <button style={{ ...c.btn, marginBottom: "1rem" }} onClick={() => { setPage("list"); setTid(null); setMeditationDone(false); setSoloVotes({}); setSoloNotes({}); }}>← Back</button>
        <div style={{ ...c.row, marginBottom: "0.25rem" }}>
          <h2 style={{ ...c.h2, margin: 0 }}>{trial.question || trial.market || "Trial"}</h2>
          <Badge status={trial.status} />
        </div>
        <p style={{ ...c.muted, margin: "0 0 0.25rem" }}>{fmtDate(trial)}{trial.market ? ` · ${trial.market}` : ""}</p>
        {trial.targetRef && <p style={{ fontSize: 12, color: "#085041", fontWeight: 600, letterSpacing: "0.06em", margin: "0 0 1rem" }}>TARGET REF #{trial.targetRef}</p>}
        <Stepper steps={STEPS} current={step} />
        <Notify msg={notify} />

        {/* STEP 1 — VIEW */}
        {trial.status === "viewing" && (
          <>
            {/* ── Completed sessions so far ── */}
            {sessions.length > 0 && (
              <div style={c.card}>
                <div style={{ ...c.row, marginBottom: "1rem", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
                  <h3 style={{ ...c.h3, margin: 0 }}>
                    {sessions.length} session{sessions.length !== 1 ? "s" : ""} completed
                  </h3>
                  <button style={c.btnP} disabled={saving}
                    onClick={async () => { await onUpdate(trial.id, { status: "judging" }); }}>
                    Judge sessions →
                  </button>
                </div>
                {sessions.map((s, i) => (
                  <div key={i}>
                    <p style={{ fontSize: 11, fontWeight: 700, color: "#085041", margin: "0 0 6px", textTransform: "uppercase", letterSpacing: "0.05em" }}>Session {i + 1}</p>
                    <SessionDisplay session={s} trialId={trial.id} sessionIdx={i} showConfidence />
                    {i < sessions.length - 1 && <div style={{ ...c.sep, margin: "0.75rem 0" }} />}
                  </div>
                ))}
              </div>
            )}

            {/* ── Meditation or session form ── */}
            {!meditationDone ? (
              <div style={c.card}>
                <h3 style={c.h3}>{sessions.length > 0 ? `Session ${sessions.length + 1} — Meditation` : "Step 1 — Pre-Session Meditation"}</h3>
                <MeditationTimer onComplete={() => setMeditationDone(true)} />
              </div>
            ) : (
              <div style={c.card}>
                <h3 style={c.h3}>{sessions.length > 0 ? `Session ${sessions.length + 1}` : "Step 1 — Remote Viewing Session"}</h3>
                <p style={c.muted}>Clear your mind completely. Do not think about markets, prices, teams, or outcomes. Simply perceive and describe the target image you sense you will be shown after this session.</p>
                <SessionForm
                  saving={saving}
                  onSubmit={async (sessionData, ideogramData, siteSketchData) => {
                    const sessionIdx = sessions.length;
                    if (ideogramData)   { try { await saveSketch(trial.id, sessionIdx, "ideogram", ideogramData); } catch {} }
                    if (siteSketchData) { try { await saveSketch(trial.id, sessionIdx, "site",     siteSketchData); } catch {} }
                    await onUpdate(trial.id, {
                      sessions: [...sessions, { viewerName, ...sessionData, timestamp: new Date().toISOString() }],
                    });
                    setMeditationDone(false); // ready for another session if wanted
                  }}
                />
              </div>
            )}
          </>
        )}

        {/* STEP 2 — JUDGE */}
        {trial.status === "judging" && (
          <div>
            <div style={c.card}>
              <h3 style={c.h3}>Step 2 — Judge Your Sessions</h3>
              <p style={c.muted}>Both images are now revealed. Read each session and decide which image it better matches — set aside any market preference.</p>
              <div style={c.half}>
                {["A","B"].map(s => (
                  <div key={s}>
                    <p style={{ ...c.label, marginBottom: 6 }}>Image {s}</p>
                    <TrialImage trialId={trial.id} side={s} style={c.imgBox} />
                  </div>
                ))}
              </div>
            </div>

            {sessions.map((sess, i) => (
              <div key={i} style={c.card}>
                <div style={{ ...c.row, marginBottom: 10, flexWrap: "wrap", gap: 6 }}>
                  <p style={{ fontWeight: 500, fontSize: 13, margin: 0 }}>Session {i + 1}</p>
                  {sessionDurationLabel(sess) && (
                    <span style={{ fontSize: 12, color: "#085041", fontWeight: 600, background: "#08504112", padding: "2px 8px", borderRadius: 99 }}>
                      ⏱ {sessionDurationLabel(sess)}
                    </span>
                  )}
                </div>
                <SessionDisplay session={sess} trialId={trial.id} sessionIdx={i} />
                <div style={{ ...c.sep, margin: "1rem 0" }} />
                <label style={c.label}>Which image does session {i + 1} better match?</label>
                <div style={{ ...c.row, marginBottom: "0.75rem" }}>
                  {[["A","Image A"],["B","Image B"],["M","Mixed / unclear"]].map(([v,l]) => (
                    <button key={v} style={{ ...c.btn, ...(soloVotes[i] === v ? { background: "#085041", color: "white", borderColor: "#085041" } : {}) }}
                      onClick={() => setSoloVotes(p => ({ ...p, [i]: v }))}>{l}</button>
                  ))}
                </div>
                <div style={c.field}>
                  <label style={c.label}>Notes <span style={{ fontWeight: 400, textTransform: "none" }}>(optional)</span></label>
                  <textarea style={{ ...c.area, minHeight: 70 }} value={soloNotes[i] || ""}
                    onChange={e => setSoloNotes(p => ({ ...p, [i]: e.target.value }))}
                    placeholder="Which elements matched? Why did you choose this image?" />
                </div>
              </div>
            ))}

            <div style={{ ...c.card, background: "var(--color-background-secondary)" }}>
              <p style={{ fontSize: 13, margin: "0 0 10px" }}>
                Tally — A: <strong>{aCount}</strong> · B: <strong>{bCount}</strong>
                {aCount !== bCount && aCount + bCount > 0 && <> · Majority → <strong>Image {aCount > bCount ? "A" : "B"}</strong></>}
                {aCount === bCount && aCount > 0 && <> · <span style={{ color: "var(--color-text-warning)" }}>Tied — no clear prediction</span></>}
              </p>
              <button style={c.btnP} disabled={!allVoted || saving}
                onClick={async () => {
                  const validVotes = Object.values(soloVotes).filter(v => v !== "M");
                  const a = validVotes.filter(v => v === "A").length;
                  const b = validVotes.filter(v => v === "B").length;
                  const winner = a > b ? "A" : b > a ? "B" : null;
                  const prediction = winner === null ? null : winner === trial.upImage ? "Up" : "Down";
                  const judgments = sessions.map((_, i) => ({ vote: soloVotes[i] || "M", notes: soloNotes[i] || "" }));
                  await onUpdate(trial.id, { judgments, prediction, status: "predicted" });
                  setSoloVotes({});
                  setSoloNotes({});
                }}>
                {saving ? "Saving…" : `Submit Judgments (${Object.keys(soloVotes).length}/${sessions.length})`}
              </button>
            </div>
          </div>
        )}

        {/* STEP 3 — PREDICTION */}
        {trial.status === "predicted" && (
          <div>
            <div style={{ ...c.card, borderColor: "#085041", borderWidth: 1.5 }}>
              <h3 style={c.h3}>Step 3 — Prediction</h3>
              {trial.prediction ? (
                <>
                  <p style={{ fontSize: 28, fontWeight: 600, margin: "0.5rem 0", color: "#085041" }}>
                    {outLabel(trial, trial.prediction)}
                  </p>
                  <p style={{ ...c.muted, margin: "0 0 8px" }}>
                    {trial.judgments?.length > 1
                      ? <>Majority of {trial.judgments.length} sessions voted → sealed as <strong>{outLabel(trial, trial.prediction)}</strong>.</>
                      : <>Session matched Image <strong>{trial.judgments?.[0]?.vote}</strong>, sealed as <strong>{outLabel(trial, trial.prediction)}</strong>.</>
                    }
                  </p>
                  {trial.judgments?.length > 1 && (
                    <p style={{ fontSize: 12, color: "var(--color-text-secondary)", margin: "0 0 8px" }}>
                      A: {trial.judgments.filter(j => j.vote === "A").length} · B: {trial.judgments.filter(j => j.vote === "B").length} · Mixed: {trial.judgments.filter(j => j.vote === "M").length}
                    </p>
                  )}
                  {mySession?.confidence && <ConfidencePill value={mySession.confidence} />}
                </>
              ) : (
                <p style={{ fontSize: 15, color: "var(--color-text-secondary)", margin: 0 }}>Mixed / tied — no clear prediction. Skip this trade.</p>
              )}
            </div>
            {trial.prediction && (
              <div style={{ ...c.card, background: "var(--color-background-secondary)" }}>
                <p style={{ fontSize: 13, fontWeight: 500, margin: "0 0 4px" }}>Timing</p>
                <p style={{ ...c.muted, margin: 0 }}>
                  Act at: {fmtDate(trial)}. Do not hold beyond the prediction window.
                </p>
              </div>
            )}
            <div style={c.card}>
              <h3 style={c.h3}>Step 4 — Record actual outcome</h3>
              <p style={c.muted}>Return after the event and record what actually happened.</p>
              <div style={{ ...c.row, marginBottom: "0.75rem" }}>
                {[["Up", upL], ["Down", downL]].map(([v, l]) => (
                  <button key={v} style={{ ...c.btn, ...(actual === v ? { background: "#085041", color: "white", borderColor: "#085041" } : {}) }}
                    onClick={() => setActual(v)}>{l}</button>
                ))}
              </div>
              <button style={c.btnP} disabled={!actual || saving}
                onClick={async () => {
                  const feedbackSide = actual === "Up" ? trial.upImage : (trial.upImage === "A" ? "B" : "A");
                  await onUpdate(trial.id, { actual, feedbackSide, status: "complete" });
                  setActual("");
                }}>
                {saving ? "Saving…" : "Record & See Feedback →"}
              </button>
            </div>
          </div>
        )}

        {/* STEP 4 — COMPLETE */}
        {trial.status === "complete" && (
          <div>
            <div style={{ ...c.card, background: trial.actual === trial.prediction ? "var(--color-background-success)" : "var(--color-background-danger)" }}>
              <h3 style={{ ...c.h3, color: trial.actual === trial.prediction ? "var(--color-text-success)" : "var(--color-text-danger)" }}>
                {trial.actual === trial.prediction ? "✓ Correct prediction" : "✗ Incorrect prediction"}
              </h3>
              <p style={{ fontSize: 14, margin: 0 }}>
                Predicted <strong>{outLabel(trial, trial.prediction)}</strong> · Actual <strong>{outLabel(trial, trial.actual)}</strong>
              </p>
            </div>
            <div style={c.card}>
              <h3 style={c.h3}>Feedback</h3>
              <p style={c.muted}>The image associated with the actual outcome — this is theoretically what you were perceiving forward in time.</p>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1rem", alignItems: "start" }}>
                <div>
                  <p style={{ ...c.label, marginBottom: 6 }}>Feedback image</p>
                  <TrialImage trialId={trial.id} side={trial.feedbackSide} style={c.imgFull} />
                </div>
                <div>
                  <p style={{ ...c.label, marginBottom: 6 }}>Your session{sessions.length > 1 ? "s" : ""}</p>
                  {sessions.map((s, i) => (
                    <div key={i} style={{ marginBottom: i < sessions.length - 1 ? "0.75rem" : 0 }}>
                      {sessions.length > 1 && (
                        <p style={{ fontSize: 11, fontWeight: 700, color: "#085041", margin: "0 0 4px", textTransform: "uppercase", letterSpacing: "0.05em" }}>Session {i + 1}</p>
                      )}
                      <SessionDisplay session={s} trialId={trial.id} sessionIdx={i} showConfidence={i === 0} />
                      {i < sessions.length - 1 && <div style={{ ...c.sep, margin: "0.5rem 0" }} />}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  // Trial list
  return (
    <div style={c.wrap}>
      <h2 style={c.h1}>Solo ARV — {viewerName}</h2>
      <p style={c.muted}>Guided step-by-step: view → judge → prediction → outcome</p>
      <Notify msg={notify} />
      <button style={{ ...c.btnP, marginBottom: "1.5rem" }} onClick={() => setPage("new")}>+ New Trial</button>
      {soloTrials.length === 0 && <div style={{ ...c.card, textAlign: "center", padding: "2rem" }}><p style={c.muted}>No trials yet.</p></div>}
      {soloTrials.map(t => {
        const step = stepIdx(t.status);
        return (
          <div key={t.id} style={{ ...c.card, cursor: "pointer", ...(t.status !== "complete" ? { borderLeft: "3px solid #085041" } : {}) }}
            onClick={() => { setTid(t.id); setPage("trial"); }}>
            <div style={c.row}>
              <div>
                <p style={{ fontWeight: 500, fontSize: 14, margin: 0 }}>{t.question || t.market || "Trial"}</p>
                <p style={{ fontSize: 12, color: "var(--color-text-secondary)", margin: "2px 0 0" }}>{fmtDate(t)}{t.market && t.question ? ` · ${t.market}` : ""}</p>
                {t.targetRef && <p style={{ fontSize: 11, color: "#085041", margin: "2px 0 0", fontWeight: 600, letterSpacing: "0.06em" }}>REF #{t.targetRef}</p>}
              </div>
              <Badge status={t.status} />
              {t.status === "complete" && <span style={{ marginLeft: "auto", fontSize: 12, color: t.actual === t.prediction ? "var(--color-text-success)" : "var(--color-text-danger)" }}>{t.actual === t.prediction ? "✓ Correct" : "✗ Incorrect"}</span>}
            </div>
            <div style={{ display: "flex", gap: 3, marginTop: 8 }}>
              {STEPS.map((_, i) => <div key={i} style={{ height: 3, flex: 1, borderRadius: 2, background: i <= step ? "#085041" : "var(--color-background-secondary)" }} />)}
            </div>
            {t.status !== "complete" && <p style={{ fontSize: 12, color: "#085041", margin: "5px 0 0" }}>Next → {STEPS[step]}</p>}
          </div>
        );
      })}
    </div>
  );
}

// ── Coordinator ───────────────────────────────────────────────────────────────
function CoordView({ trials, saving, notify, onCreate, onUpdate, onRepeat, onJudge }) {
  const [page, setPage] = useState("list");
  const [tid, setTid]   = useState(null);
  const [actual, setActual] = useState("");
  const [votes, setVotes]   = useState({});
  const groupTrials = trials.filter(t => !t.solo);
  const trial = tid ? trials.find(t => t.id === tid) : null;
  const canSeeUpDown = trial && (trial.status === "predicted" || trial.status === "complete");
  const sessions  = trial?.sessions || [];
  const aCount    = Object.values(votes).filter(v => v === "A").length;
  const bCount    = Object.values(votes).filter(v => v === "B").length;
  const allVoted  = sessions.length > 0 && sessions.every((_, i) => votes[i]);

  if (page === "new") {
    return <NewTrialForm saving={saving} onBack={() => setPage("list")}
      onSave={async (fields) => {
        const t = { id: uid(), ...fields, solo: false, status: "viewing", sessions: [], judgments: [], prediction: null, actual: null };
        await onCreate(t);
        setPage("list");
      }} />;
  }

  if (page === "trial" && trial) {
    const upL   = outLabel(trial, "Up");
    const downL = outLabel(trial, "Down");
    return (
      <div style={c.wrap}>
        <button style={{ ...c.btn, marginBottom: "1rem" }} onClick={() => { setPage("list"); setTid(null); setVotes({}); }}>← Back</button>
        <div style={{ ...c.row, marginBottom: "0.25rem" }}>
          <h2 style={{ ...c.h2, margin: 0 }}>{trial.question || trial.market || "Trial"}</h2>
          <Badge status={trial.status} />
        </div>
        <p style={{ ...c.muted, margin: "0 0 0.25rem" }}>{fmtDate(trial)}{trial.market ? ` · ${trial.market}` : ""}</p>
        {trial.targetRef && <p style={{ fontSize: 12, color: "#085041", fontWeight: 600, letterSpacing: "0.06em", margin: "0 0 0.5rem" }}>TARGET REF #{trial.targetRef}</p>}
        {trial.notes && <p style={{ ...c.muted, fontStyle: "italic" }}>{trial.notes}</p>}
        {trial.assignedViewers?.length > 0 && (
          <p style={{ fontSize: 12, color: "var(--color-text-secondary)", margin: "0 0 0.5rem" }}>
            Assigned to: <strong>{trial.assignedViewers.join(", ")}</strong>
          </p>
        )}
        {canSeeUpDown
          ? <p style={{ ...c.muted, marginBottom: "1rem" }}>Image {trial.upImage} = <strong>{upL}</strong> · Image {trial.upImage === "A" ? "B" : "A"} = <strong>{downL}</strong></p>
          : <p style={{ fontSize: 13, color: "var(--color-text-secondary)", marginBottom: "1rem" }}>🔒 Outcome assignment sealed until judging is complete</p>}
        <Notify msg={notify} />

        <div style={c.half}>
          {["A","B"].map(s => (
            <div key={s}>
              <p style={{ ...c.label, marginBottom: 6 }}>Image {s}{canSeeUpDown ? ` — ${trial.upImage === s ? upL : downL}` : ""}</p>
              <TrialImage trialId={trial.id} side={s} style={c.imgBox} />
            </div>
          ))}
        </div>

        <div style={c.sep} />
        <h3 style={c.h3}>Sessions ({sessions.length})</h3>
        {!sessions.length ? <p style={c.muted}>No sessions yet.</p>
          : sessions.map((s, i) => (
            <div key={i} style={{ ...c.card, marginBottom: "0.5rem" }}>
              <div style={{ ...c.row, marginBottom: 8 }}>
                <p style={{ fontWeight: 500, fontSize: 13, margin: 0 }}>{s.viewerName}</p>
                {s.confidence && <ConfidencePill value={s.confidence} />}
              </div>
              <SessionDisplay session={s} trialId={trial.id} sessionIdx={i} showConfidence={false} />
            </div>
          ))
        }

        {sessions.length > 0 && (
          <>
            <div style={c.sep} />
            {trial.status === "viewing" ? (
              <>
                <h3 style={c.h3}>Judge sessions</h3>
                <p style={c.muted}>Compare each session to both images above and vote for the better match. The outcome assignment is still sealed.</p>
                {sessions.map((sess, i) => (
                  <div key={i} style={c.card}>
                    <div style={{ ...c.row, marginBottom: 10 }}>
                      <p style={{ fontWeight: 500, fontSize: 14, margin: 0 }}>Session {i+1} — {sess.viewerName}</p>
                      {sess.confidence && <ConfidencePill value={sess.confidence} />}
                    </div>
                    <label style={c.label}>Which image does this session better match?</label>
                    <div style={c.row}>
                      {[["A","Image A"],["B","Image B"],["M","Mixed"]].map(([v,l]) => (
                        <button key={v} style={{ ...c.btn, ...(votes[i] === v ? { background: "#085041", color: "white", borderColor: "#085041" } : {}) }}
                          onClick={() => setVotes(p => ({ ...p, [i]: v }))}>{l}</button>
                      ))}
                    </div>
                  </div>
                ))}
                <div style={{ ...c.card, background: "var(--color-background-secondary)" }}>
                  <p style={{ fontSize: 13, margin: "0 0 10px" }}>
                    Tally — A: <strong>{aCount}</strong> · B: <strong>{bCount}</strong>
                    {aCount !== bCount && aCount + bCount > 0 && <> · Majority → <strong>Image {aCount > bCount ? "A" : "B"}</strong></>}
                    {aCount === bCount && aCount > 0 && <> · <span style={{ color: "var(--color-text-warning)" }}>Tied — no trade</span></>}
                  </p>
                  <button style={c.btnP} disabled={!allVoted || saving}
                    onClick={() => onJudge(trial.id, sessions.map((_, i) => ({ vote: votes[i] || "M" })))}>
                    {saving ? "Submitting…" : `Submit Judgments (${Object.keys(votes).length}/${sessions.length})`}
                  </button>
                </div>
              </>
            ) : (
              <>
                <h3 style={c.h3}>Judgments</h3>
                {trial.judgments?.map((j, i) => (
                  <div key={i} style={{ marginBottom: j.notes ? 10 : 4 }}>
                    <p style={{ fontSize: 13, margin: 0 }}>
                      {trial.sessions?.[i]?.viewerName || `Session ${i+1}`}: <strong>{j.vote === "M" ? "Mixed" : `Image ${j.vote}`}</strong>
                    </p>
                    {j.notes && (
                      <p style={{ fontSize: 12, color: "var(--color-text-secondary)", margin: "3px 0 0", fontStyle: "italic", paddingLeft: 8, borderLeft: "2px solid var(--color-border-tertiary)" }}>
                        {j.notes}
                      </p>
                    )}
                  </div>
                ))}
                {trial.prediction && <p style={{ fontSize: 14, marginTop: 8 }}>Prediction: <strong>{outLabel(trial, trial.prediction)}</strong></p>}
              </>
            )}
            <div style={{ ...c.card, marginTop: "1rem", borderColor: "#085041" }}>
              <h3 style={c.h3}>🔁 Repeat this trial</h3>
              <p style={c.muted}>Open the same target to another viewer, or have someone redo it. Same images, new reference number, fresh randomisation.</p>
              <button style={c.btnP} disabled={saving} onClick={() => onRepeat(trial.id)}>
                Repeat this trial
              </button>
            </div>
          </>
        )}

        {trial.status === "predicted" && (
          <>
            <div style={c.sep} />
            <h3 style={c.h3}>Record actual outcome</h3>
            <div style={{ ...c.row, marginBottom: "0.75rem" }}>
              {[["Up", upL], ["Down", downL]].map(([v, l]) => (
                <button key={v} style={{ ...c.btn, ...(actual === v ? { background: "#085041", color: "white", borderColor: "#085041" } : {}) }}
                  onClick={() => setActual(v)}>{l}</button>
              ))}
            </div>
            <button style={c.btnP} disabled={!actual || saving}
              onClick={() => {
                const feedbackSide = actual === "Up" ? trial.upImage : (trial.upImage === "A" ? "B" : "A");
                onUpdate(trial.id, { actual, feedbackSide, status: "complete" });
                setActual("");
              }}>
              {saving ? "Saving…" : "Record & Release Feedback"}
            </button>
          </>
        )}

        {trial.status === "complete" && (
          <>
            <div style={{ ...c.card, marginTop: "1rem", background: trial.actual === trial.prediction ? "var(--color-background-success)" : "var(--color-background-danger)" }}>
              <p style={{ fontSize: 14, margin: 0 }}>
                Prediction: <strong>{outLabel(trial, trial.prediction) || "None"}</strong> · Actual: <strong>{outLabel(trial, trial.actual)}</strong> ·{" "}
                {trial.actual === trial.prediction
                  ? <span style={{ color: "var(--color-text-success)" }}>Correct ✓</span>
                  : <span style={{ color: "var(--color-text-danger)" }}>Incorrect ✗</span>}
              </p>
            </div>
            {trial.feedbackSide && (
              <div style={{ ...c.card, marginTop: "0.75rem" }}>
                <h3 style={c.h3}>Feedback Image (released to viewer)</h3>
                <p style={{ ...c.muted, margin: "0 0 0.75rem" }}>
                  Image {trial.feedbackSide} — associated with the actual outcome <strong>{outLabel(trial, trial.actual)}</strong>
                </p>
                <TrialImage trialId={trial.id} side={trial.feedbackSide} style={c.imgBox} />
                <p style={{ fontSize: 12, color: "var(--color-text-secondary)", marginTop: 8, marginBottom: 0 }}>
                  Feedback is visible here in the Coordinator panel only — not shown to the viewer during active sessions.
                </p>
              </div>
            )}
          </>
        )}
      </div>
    );
  }

  const activeTrials    = groupTrials.filter(t => t.status !== "complete");
  const completedTrials = groupTrials.filter(t => t.status === "complete");

  return (
    <div style={c.wrap}>
      <h2 style={c.h1}>Coordinator Panel</h2>
      <p style={c.muted}>Create trials, record outcomes, and review previous trial feedback. Results and feedback images are only visible here — not shown to viewers or judges during active sessions.</p>
      <Notify msg={notify} />
      <button style={{ ...c.btnP, marginBottom: "1.5rem" }} onClick={() => setPage("new")}>+ New Trial</button>

      {groupTrials.length === 0 && <div style={{ ...c.card, textAlign: "center", padding: "2rem" }}><p style={c.muted}>No trials yet.</p></div>}

      {activeTrials.length > 0 && (
        <>
          <p style={{ ...c.label, marginBottom: "0.5rem" }}>Active Trials</p>
          {activeTrials.map(t => (
            <div key={t.id} style={{ ...c.card, cursor: "pointer", borderLeft: "3px solid #085041" }} onClick={() => { setTid(t.id); setPage("trial"); }}>
              <div style={c.row}>
                <div>
                  <p style={{ fontWeight: 500, fontSize: 14, margin: 0 }}>{t.question || t.market || "Trial"}</p>
                  <p style={{ fontSize: 12, color: "var(--color-text-secondary)", margin: "2px 0 0" }}>{fmtDate(t)}{t.market && t.question ? ` · ${t.market}` : ""}</p>
                  {t.targetRef && <p style={{ fontSize: 11, color: "#085041", margin: "2px 0 0", fontWeight: 600, letterSpacing: "0.06em" }}>REF #{t.targetRef}</p>}
                </div>
                <Badge status={t.status} />
                <span style={{ marginLeft: "auto", fontSize: 12, color: "var(--color-text-secondary)" }}>{t.sessions?.length || 0} session{t.sessions?.length !== 1 ? "s" : ""}</span>
              </div>
              {t.prediction && <p style={{ fontSize: 13, margin: "6px 0 0" }}>Prediction: <strong>{outLabel(t, t.prediction)}</strong></p>}
            </div>
          ))}
        </>
      )}

      {completedTrials.length > 0 && (
        <>
          <div style={c.sep} />
          <p style={{ ...c.label, marginBottom: "0.5rem" }}>Previous Trials & Results</p>

          {/* ── Coordinator stats summary ── */}
          {(() => {
            const judged   = completedTrials.filter(t => t.prediction);
            const correct  = judged.filter(t => t.actual === t.prediction).length;
            const accuracy = judged.length > 0 ? Math.round((correct / judged.length) * 100) : null;
            const accColor = accuracy === null ? "var(--color-text-secondary)"
              : accuracy >= 60 ? "var(--color-text-success)"
              : accuracy >= 50 ? "var(--color-text-warning)"
              : "var(--color-text-danger)";
            // Calibration by confidence band (all sessions across all group trials)
            const bands = [
              { label: "Low (1–3)", min: 1, max: 3 },
              { label: "Med (4–6)", min: 4, max: 6 },
              { label: "High (7–10)", min: 7, max: 10 },
            ].map(b => {
              const trialSet = completedTrials.filter(t => {
                if (!t.prediction) return false;
                const conf = t.sessions?.[0]?.confidence;
                return conf >= b.min && conf <= b.max;
              });
              const c2 = trialSet.filter(t => t.actual === t.prediction).length;
              return { ...b, total: trialSet.length, correct: c2 };
            }).filter(b => b.total > 0);
            return (
              <div style={{ ...c.card, background: "var(--color-background-secondary)", marginBottom: "0.75rem" }}>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8, marginBottom: bands.length > 0 ? "0.75rem" : 0 }}>
                  {[
                    { lbl: "Judged", val: judged.length, col: "#085041" },
                    { lbl: "Correct", val: correct, col: "var(--color-text-success)" },
                    { lbl: "Accuracy", val: accuracy !== null ? `${accuracy}%` : "—", col: accColor },
                  ].map(({ lbl, val, col }) => (
                    <div key={lbl} style={{ textAlign: "center", padding: "8px 4px", background: "var(--color-background-primary)", borderRadius: "var(--border-radius-md)" }}>
                      <p style={{ fontSize: 20, fontWeight: 700, margin: "0 0 2px", color: col }}>{val}</p>
                      <p style={{ fontSize: 11, color: "var(--color-text-secondary)", margin: 0, textTransform: "uppercase", letterSpacing: "0.04em" }}>{lbl}</p>
                    </div>
                  ))}
                </div>
                {bands.length > 0 && (
                  <div>
                    <p style={{ fontSize: 11, fontWeight: 700, color: "var(--color-text-secondary)", margin: "0 0 6px", textTransform: "uppercase", letterSpacing: "0.05em" }}>Accuracy by confidence band</p>
                    {bands.map(b => {
                      const pct = Math.round((b.correct / b.total) * 100);
                      return (
                        <div key={b.label} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 5 }}>
                          <span style={{ fontSize: 12, width: 72, flexShrink: 0, color: "var(--color-text-secondary)" }}>{b.label}</span>
                          <div style={{ flex: 1, height: 6, background: "var(--color-border-tertiary)", borderRadius: 3, overflow: "hidden" }}>
                            <div style={{ height: "100%", width: `${pct}%`, background: pct >= 60 ? "#085041" : pct >= 50 ? "#e67e22" : "#c0392b", borderRadius: 3 }} />
                          </div>
                          <span style={{ fontSize: 12, fontWeight: 600, width: 48, textAlign: "right", color: pct >= 60 ? "var(--color-text-success)" : pct >= 50 ? "var(--color-text-warning)" : "var(--color-text-danger)" }}>{b.correct}/{b.total}</span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })()}
          {completedTrials.map(t => (
            <div key={t.id} style={{ ...c.card, cursor: "pointer" }} onClick={() => { setTid(t.id); setPage("trial"); }}>
              <div style={c.row}>
                <div>
                  <p style={{ fontWeight: 500, fontSize: 14, margin: 0 }}>{t.question || t.market || "Trial"}</p>
                  <p style={{ fontSize: 12, color: "var(--color-text-secondary)", margin: "2px 0 0" }}>{fmtDate(t)}{t.market && t.question ? ` · ${t.market}` : ""}</p>
                  {t.targetRef && <p style={{ fontSize: 11, color: "#085041", margin: "2px 0 0", fontWeight: 600, letterSpacing: "0.06em" }}>REF #{t.targetRef}</p>}
                </div>
                <Badge status={t.status} />
                <span style={{ marginLeft: "auto", fontSize: 12, color: t.actual === t.prediction ? "var(--color-text-success)" : "var(--color-text-danger)", fontWeight: 500 }}>
                  {t.actual === t.prediction ? "✓ Correct" : "✗ Incorrect"}
                </span>
              </div>
              {t.prediction && (
                <p style={{ fontSize: 13, margin: "6px 0 0" }}>
                  Prediction: <strong>{outLabel(t, t.prediction)}</strong> · Actual: <strong>{outLabel(t, t.actual)}</strong>
                  {t.feedbackSide && <span style={{ fontSize: 12, color: "var(--color-text-secondary)" }}> · Feedback: Image {t.feedbackSide}</span>}
                </p>
              )}
            </div>
          ))}
        </>
      )}
    </div>
  );
}

// ── Meditation Timer ─────────────────────────────────────────────────────────
function MeditationTimer({ onComplete }) {
  const [seconds, setSeconds] = useState(180);
  const hasRung = useRef(false);

  function playBell() {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      // Three gentle sine-wave tones spaced 0.9 s apart
      [0, 0.9, 1.8].forEach(delay => {
        const osc  = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.type = "sine";
        osc.frequency.value = 432; // calming A4 variant
        const t = ctx.currentTime + delay;
        gain.gain.setValueAtTime(0, t);
        gain.gain.linearRampToValueAtTime(0.35, t + 0.015);
        gain.gain.exponentialRampToValueAtTime(0.001, t + 2.6);
        osc.start(t);
        osc.stop(t + 2.6);
      });
    } catch {}
  }

  useEffect(() => {
    if (seconds <= 0) {
      if (!hasRung.current) { hasRung.current = true; playBell(); }
      return; // stay on screen — user clicks "Begin session →"
    }
    const id = setTimeout(() => setSeconds(s => s - 1), 1000);
    return () => clearTimeout(id);
  }, [seconds]);

  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  const pct  = Math.round(((180 - seconds) / 180) * 100);

  return (
    <div style={{ ...c.card, textAlign: "center", padding: "2rem 1.5rem" }}>
      <p style={c.sxHdr}>Pre-Session Meditation</p>
      <p style={{ fontSize: 13, color: "var(--color-text-secondary)", margin: "0 0 1.5rem", lineHeight: 1.7 }}>
        Take a moment to still your mind before viewing.<br />
        Breathe slowly and release all thoughts of markets, outcomes, and expectations.
      </p>
      <div style={{ fontSize: 52, fontWeight: 600, color: "#085041", margin: "0 0 1rem", fontVariantNumeric: "tabular-nums", letterSpacing: "0.02em" }}>
        {mins}:{String(secs).padStart(2, "0")}
      </div>
      <div style={{ height: 5, background: "var(--color-background-secondary)", borderRadius: 3, margin: "0 auto 1.5rem", maxWidth: 240 }}>
        <div style={{ height: "100%", width: `${pct}%`, background: "#085041", borderRadius: 3, transition: "width 1s linear" }} />
      </div>
      <p style={{ fontSize: 12, color: "var(--color-text-secondary)", margin: "0 0 1.25rem", fontStyle: "italic" }}>
        {seconds > 0 ? "Observe thoughts without engaging them — then let them go." : "🔔 Timer complete — begin when ready."}
      </p>
      <button style={{ ...c.btn, fontSize: 13, padding: "8px 20px" }} onClick={onComplete}>
        {seconds > 0 ? "Skip meditation →" : "Begin session →"}
      </button>
    </div>
  );
}

// ── Viewer ────────────────────────────────────────────────────────────────────
function ViewerView({ viewerName, trials, saving, notify, onSubmit }) {
  const groupTrials  = trials.filter(t => !t.solo);
  const activeTrials = groupTrials.filter(t => t.status === "viewing" && (!t.assignedViewers?.length || t.assignedViewers.includes(viewerName)));
  const [showFeedback, setShowFeedback]       = useState(false);
  const [showStats, setShowStats]             = useState(false);
  const [selectedTrialId, setSelectedTrialId] = useState(null);
  const [meditationDone, setMeditationDone]   = useState(false);
  const selectedTrial = selectedTrialId ? activeTrials.find(t => t.id === selectedTrialId) : null;
  const alreadyDone   = selectedTrial?.sessions?.some(s => s.viewerName === viewerName);

  // Stats derived from all trials this viewer has participated in
  const myTrials      = groupTrials.filter(t => t.sessions?.some(s => s.viewerName === viewerName));
  const judgedTrials  = myTrials.filter(t => t.status === "complete" && t.feedbackSide);
  const correctCount  = judgedTrials.filter(t => t.actual === t.prediction).length;
  const accuracy      = judgedTrials.length > 0 ? Math.round((correctCount / judgedTrials.length) * 100) : null;
  const mySessions    = groupTrials.flatMap(t => (t.sessions || []).filter(s => s.viewerName === viewerName));
  const confSessions  = mySessions.filter(s => s.confidence);
  const avgConf       = confSessions.length > 0
    ? Math.round(confSessions.reduce((sum, s) => sum + s.confidence, 0) / confSessions.length * 10) / 10
    : null;
  const hiConfJudged  = judgedTrials.filter(t => {
    const s = t.sessions?.find(se => se.viewerName === viewerName);
    return s?.confidence >= 7;
  });
  const hiConfCorrect = hiConfJudged.filter(t => t.actual === t.prediction).length;

  // Current correct streak — sorted by viewer's own session timestamp, count back from most recent
  const sortedJudged = [...judgedTrials].sort((a, b) => {
    const ta = a.sessions?.find(s => s.viewerName === viewerName)?.timestamp || "";
    const tb = b.sessions?.find(s => s.viewerName === viewerName)?.timestamp || "";
    return ta.localeCompare(tb);
  });
  let currentStreak = 0;
  for (let i = sortedJudged.length - 1; i >= 0; i--) {
    const t = sortedJudged[i];
    if (t.prediction === null) continue;           // tied — skip, don't break streak
    if (t.actual === t.prediction) { currentStreak++; }
    else { break; }
  }

  // Most recent completed trial with feedback released where this viewer participated
  const feedbackTrial = [...groupTrials]
    .filter(t => t.status === "complete" && t.feedbackSide && t.sessions?.some(s => s.viewerName === viewerName))
    .sort((a, b) => {
      const ta = a.sessions?.find(s => s.viewerName === viewerName)?.timestamp || "";
      const tb = b.sessions?.find(s => s.viewerName === viewerName)?.timestamp || "";
      return tb.localeCompare(ta);
    })[0] || null;

  function goBack() { setSelectedTrialId(null); setMeditationDone(false); }

  return (
    <div style={c.wrap}>
      <h2 style={c.h1}>Viewer: {viewerName}</h2>
      <p style={c.muted}>Perceive the target image you will be shown in the future</p>
      <Notify msg={notify} />

      {/* ── Previous trial feedback ── */}
      {feedbackTrial && (
        <div style={{ marginBottom: "1.25rem" }}>
          <button
            style={{ ...c.btn, width: "100%", textAlign: "left", padding: "10px 16px", display: "flex", justifyContent: "space-between", alignItems: "center", borderColor: showFeedback ? "#085041" : "var(--color-border-secondary)", background: showFeedback ? "#08504108" : "transparent" }}
            onClick={() => setShowFeedback(v => !v)}>
            <span style={{ fontWeight: 500, fontSize: 14 }}>📋 View feedback on previous trial</span>
            <span style={{ fontSize: 12, color: feedbackTrial.actual === feedbackTrial.prediction ? "var(--color-text-success)" : "var(--color-text-danger)", fontWeight: 500 }}>
              {showFeedback ? (feedbackTrial.actual === feedbackTrial.prediction ? "✓ Correct" : "✗ Incorrect") : ""} {showFeedback ? "▲" : "▼"}
            </span>
          </button>
          {showFeedback && (
            <div style={{ ...c.card, borderTop: "none", borderTopLeftRadius: 0, borderTopRightRadius: 0, borderColor: "#085041" }}>
              <p style={{ fontSize: 12, color: "var(--color-text-secondary)", margin: "0 0 4px" }}>
                {feedbackTrial.question || feedbackTrial.market || "Trial"}
                {feedbackTrial.targetRef && <span style={{ color: "#085041", fontWeight: 600, marginLeft: 8, letterSpacing: "0.05em" }}>REF #{feedbackTrial.targetRef}</span>}
              </p>
              <p style={{ fontSize: 14, margin: "0 0 0.75rem" }}>
                Prediction: <strong>{outLabel(feedbackTrial, feedbackTrial.prediction)}</strong>
                {" · "}Actual: <strong>{outLabel(feedbackTrial, feedbackTrial.actual)}</strong>
                {" "}<span style={{ color: feedbackTrial.actual === feedbackTrial.prediction ? "var(--color-text-success)" : "var(--color-text-danger)" }}>
                  {feedbackTrial.actual === feedbackTrial.prediction ? "✓" : "✗"}
                </span>
              </p>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1rem", alignItems: "start" }}>
                <div>
                  <p style={{ ...c.label, marginBottom: 6 }}>Feedback image</p>
                  <TrialImage trialId={feedbackTrial.id} side={feedbackTrial.feedbackSide} style={c.imgFull} />
                  {(() => {
                    const myS = feedbackTrial.sessions?.find(s => s.viewerName === viewerName);
                    if (!myS?.sessionStart || !myS?.sessionEnd) return null;
                    const durMin = Math.round((new Date(myS.sessionEnd) - new Date(myS.sessionStart)) / 60000);
                    return <p style={{ fontSize: 11, color: "var(--color-text-secondary)", margin: "6px 0 0" }}>Session duration: {durMin} min</p>;
                  })()}
                </div>
                <div>
                  <p style={{ ...c.label, marginBottom: 6 }}>Your session</p>
                  {(() => {
                    const myS = feedbackTrial.sessions?.find(s => s.viewerName === viewerName);
                    const myIdx = feedbackTrial.sessions?.findIndex(s => s.viewerName === viewerName) ?? 0;
                    return <SessionDisplay session={myS} trialId={feedbackTrial.id} sessionIdx={myIdx} showConfidence />;
                  })()}
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Stats panel ── */}
      {mySessions.length > 0 && (
        <div style={{ marginBottom: "1.25rem" }}>
          <button
            style={{ ...c.btn, width: "100%", textAlign: "left", padding: "10px 16px", display: "flex", justifyContent: "space-between", alignItems: "center", borderColor: showStats ? "#085041" : "var(--color-border-secondary)", background: showStats ? "#08504108" : "transparent" }}
            onClick={() => setShowStats(v => !v)}>
            <span style={{ fontWeight: 500, fontSize: 14 }}>📊 My stats &amp; accuracy</span>
            <span style={{ fontSize: 12, color: "var(--color-text-secondary)", fontWeight: 500 }}>
              {mySessions.length} session{mySessions.length !== 1 ? "s" : ""} {showStats ? "▲" : "▼"}
            </span>
          </button>
          {showStats && (
            <div style={{ ...c.card, borderTop: "none", borderTopLeftRadius: 0, borderTopRightRadius: 0, borderColor: "#085041" }}>

              {/* Summary tiles */}
              <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 8, marginBottom: "1rem" }}>
                {[
                  { lbl: "Sessions",  val: mySessions.length,   col: "#085041" },
                  { lbl: "Judged",    val: judgedTrials.length,  col: "#085041" },
                  { lbl: "Accuracy",  val: accuracy !== null ? `${accuracy}%` : "—",
                    col: accuracy === null ? "var(--color-text-secondary)"
                       : accuracy >= 60   ? "var(--color-text-success)"
                       : accuracy >= 50   ? "var(--color-text-warning)"
                       : "var(--color-text-danger)" },
                  { lbl: "Streak 🔥",
                    val: judgedTrials.length > 0 ? currentStreak : "—",
                    col: currentStreak >= 3 ? "var(--color-text-success)"
                       : currentStreak >= 1 ? "#085041"
                       : "var(--color-text-secondary)" },
                ].map(({ lbl, val, col }) => (
                  <div key={lbl} style={{ textAlign: "center", padding: "10px 6px", background: "var(--color-background-secondary)", borderRadius: "var(--border-radius-md)" }}>
                    <p style={{ fontSize: 22, fontWeight: 700, margin: "0 0 2px", color: col }}>{val}</p>
                    <p style={{ fontSize: 11, color: "var(--color-text-secondary)", margin: 0, textTransform: "uppercase", letterSpacing: "0.04em" }}>{lbl}</p>
                  </div>
                ))}
              </div>

              {/* Correct/incorrect bar */}
              {judgedTrials.length > 0 && (
                <div style={{ marginBottom: "1rem" }}>
                  <div style={{ ...c.row, justifyContent: "space-between", marginBottom: 5 }}>
                    <span style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>
                      ✓ Correct: {correctCount} &nbsp;·&nbsp; ✗ Incorrect: {judgedTrials.length - correctCount}
                    </span>
                  </div>
                  <div style={{ height: 8, background: "var(--color-background-secondary)", borderRadius: 4, overflow: "hidden" }}>
                    <div style={{ height: "100%", width: `${(correctCount / judgedTrials.length) * 100}%`, background: "#085041", borderRadius: 4 }} />
                  </div>
                  <p style={{ fontSize: 12, margin: "5px 0 0", fontWeight: 500,
                    color: accuracy >= 60 ? "var(--color-text-success)" : accuracy >= 50 ? "var(--color-text-warning)" : "var(--color-text-danger)" }}>
                    {accuracy > 60 ? "Above chance — strong signal" : accuracy === 50 ? "At chance level — keep practicing" : accuracy < 50 ? "Below chance — review your approach" : `${accuracy}%`}
                  </p>
                </div>
              )}

              {/* Calibration by confidence band */}
              {judgedTrials.length >= 3 && (() => {
                const bands = [
                  { label: "Low (1–3)", min: 1, max: 3 },
                  { label: "Med (4–6)", min: 4, max: 6 },
                  { label: "High (7–10)", min: 7, max: 10 },
                ].map(b => {
                  const ts = judgedTrials.filter(t => {
                    const s = t.sessions?.find(se => se.viewerName === viewerName);
                    return s?.confidence >= b.min && s?.confidence <= b.max;
                  });
                  const c2 = ts.filter(t => t.actual === t.prediction).length;
                  return { ...b, total: ts.length, correct: c2 };
                }).filter(b => b.total > 0);
                if (bands.length === 0) return null;
                return (
                  <div style={{ ...c.card, background: "var(--color-background-secondary)", margin: "0 0 0.75rem" }}>
                    <p style={{ fontSize: 11, fontWeight: 700, color: "var(--color-text-secondary)", margin: "0 0 8px", textTransform: "uppercase", letterSpacing: "0.05em" }}>
                      Accuracy by confidence band
                    </p>
                    {bands.map(b => {
                      const pct = Math.round((b.correct / b.total) * 100);
                      return (
                        <div key={b.label} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 5 }}>
                          <span style={{ fontSize: 12, width: 72, flexShrink: 0, color: "var(--color-text-secondary)" }}>{b.label}</span>
                          <div style={{ flex: 1, height: 6, background: "var(--color-border-tertiary)", borderRadius: 3, overflow: "hidden" }}>
                            <div style={{ height: "100%", width: `${pct}%`, background: pct >= 60 ? "#085041" : pct >= 50 ? "#e67e22" : "#c0392b", borderRadius: 3 }} />
                          </div>
                          <span style={{ fontSize: 12, fontWeight: 600, width: 48, textAlign: "right", color: pct >= 60 ? "var(--color-text-success)" : pct >= 50 ? "var(--color-text-warning)" : "var(--color-text-danger)" }}>{b.correct}/{b.total}</span>
                        </div>
                      );
                    })}
                    {bands.length > 1 && (() => {
                      const lo = bands.find(b => b.label.startsWith("Low"));
                      const hi = bands.find(b => b.label.startsWith("High"));
                      if (!lo || !hi) return null;
                      const loP = lo.correct / lo.total, hiP = hi.correct / hi.total;
                      const msg = hiP > loP + 0.1 ? "High-confidence sessions performing well — calibration looks good." :
                                  hiP < loP - 0.1 ? "High-confidence sessions underperforming — confidence rating may need recalibration." :
                                  "Confidence and accuracy roughly correlated — keep gathering data.";
                      return <p style={{ fontSize: 11, color: "var(--color-text-secondary)", margin: "8px 0 0", fontStyle: "italic" }}>{msg}</p>;
                    })()}
                  </div>
                );
              })()}

              {/* High-confidence breakdown */}
              {hiConfJudged.length > 0 && (
                <div style={{ ...c.card, background: "var(--color-background-secondary)", margin: "0 0 0.75rem" }}>
                  <p style={{ fontSize: 11, fontWeight: 700, color: "var(--color-text-secondary)", margin: "0 0 6px", textTransform: "uppercase", letterSpacing: "0.05em" }}>
                    High confidence sessions (rated ≥ 7)
                  </p>
                  <p style={{ fontSize: 14, margin: "0 0 3px", fontWeight: 500 }}>
                    {hiConfCorrect} / {hiConfJudged.length} correct
                    <span style={{ fontSize: 12, color: "var(--color-text-secondary)", fontWeight: 400, marginLeft: 8 }}>
                      ({Math.round((hiConfCorrect / hiConfJudged.length) * 100)}%)
                    </span>
                  </p>
                  {avgConf !== null && (
                    <p style={{ fontSize: 12, color: "var(--color-text-secondary)", margin: 0 }}>Avg confidence rating: {avgConf} / 10</p>
                  )}
                </div>
              )}

              {judgedTrials.length === 0 && (
                <p style={{ fontSize: 13, color: "var(--color-text-secondary)", margin: 0 }}>
                  Accuracy will appear here once your trials have been judged and outcomes recorded.
                </p>
              )}
            </div>
          )}
        </div>
      )}

      {/* ── Trial selection / session flow ── */}
      {selectedTrial ? (
        alreadyDone ? (
          <div style={{ ...c.card, textAlign: "center", padding: "2rem" }}>
            <button style={{ ...c.btn, marginBottom: "1rem" }} onClick={goBack}>← Back to trials</button>
            <p style={{ fontSize: 14, color: "var(--color-text-secondary)", margin: 0 }}>Session submitted. Await judgment and feedback.</p>
          </div>
        ) : !meditationDone ? (
          <div>
            <button style={{ ...c.btn, marginBottom: "0.75rem" }} onClick={goBack}>← Back to trials</button>
            <h2 style={{ ...c.h2, marginBottom: "1rem" }}>{selectedTrial.cue || "Remote Viewing Trial"}</h2>
            <MeditationTimer onComplete={() => setMeditationDone(true)} />
          </div>
        ) : (
          <div>
            <button style={{ ...c.btn, marginBottom: "1rem" }} onClick={goBack}>← Back to trials</button>
            <h2 style={{ ...c.h2, margin: "0 0 0.25rem" }}>{selectedTrial.cue || "Remote Viewing Trial"}</h2>
            {selectedTrial.targetRef && (
              <p style={{ fontSize: 12, color: "#085041", fontWeight: 600, letterSpacing: "0.06em", margin: "0 0 0.75rem" }}>
                TARGET REF #{selectedTrial.targetRef} — note this for your own records
              </p>
            )}
            <p style={{ ...c.muted, marginBottom: "1.25rem" }}>Clear your mind. Do not think about markets, teams, prices, or outcomes. Simply describe the image you sense you will be shown. Work through each stage below.</p>
            <SessionForm
              saving={saving}
              onSubmit={(sessionData, ideogramData, siteSketchData) => {
                onSubmit(selectedTrial.id, sessionData, ideogramData, siteSketchData);
              }}
            />
          </div>
        )
      ) : activeTrials.length === 0 ? (
        <div style={{ ...c.card, textAlign: "center", padding: "2rem" }}>
          <p style={c.muted}>No active session open. The coordinator will create one shortly.</p>
        </div>
      ) : (
        <>
          <p style={{ ...c.label, marginBottom: "0.5rem" }}>Active Trials</p>
          {activeTrials.map(t => {
            const done = t.sessions?.some(s => s.viewerName === viewerName);
            return (
              <div key={t.id} style={c.card}>
                <div style={c.row}>
                  <div>
                    <p style={{ fontWeight: 500, fontSize: 14, margin: 0 }}>{t.cue || "Remote Viewing Trial"}</p>
                  </div>
                  {done ? (
                    <span style={{ marginLeft: "auto", fontSize: 12, color: "var(--color-text-secondary)" }}>Submitted</span>
                  ) : (
                    <button style={{ ...c.btnP, marginLeft: "auto" }} onClick={() => { setSelectedTrialId(t.id); setMeditationDone(false); }}>Start session →</button>
                  )}
                </div>
              </div>
            );
          })}
        </>
      )}
    </div>
  );
}

// ── Judge ─────────────────────────────────────────────────────────────────────
function JudgeView({ trials, saving, notify, onSubmit }) {
  const groupTrials = trials.filter(t => !t.solo);
  const trial   = groupTrials.find(t => t.status === "viewing" && t.sessions?.length > 0);
  const [votes, setVotes] = useState({});
  const [notes, setNotes] = useState({});
  const sessions = trial?.sessions || [];
  const aCount   = Object.values(votes).filter(v => v === "A").length;
  const bCount   = Object.values(votes).filter(v => v === "B").length;
  const allVoted = sessions.length > 0 && sessions.every((_, i) => votes[i]);

  return (
    <div style={c.wrap}>
      <h2 style={c.h1}>Judge Panel</h2>
      <p style={c.muted}>Compare each session to both images — vote without knowing which outcome each image represents</p>
      <Notify msg={notify} />

      {!trial ? (
        <div style={{ ...c.card, textAlign: "center", padding: "2rem" }}>
          <p style={c.muted}>No sessions to judge yet. Wait for the viewer to submit.</p>
        </div>
      ) : (
        <>
          <div style={c.card}>
            <div style={{ ...c.row, marginBottom: "0.75rem" }}>
              <h3 style={{ ...c.h3, margin: 0 }}>Active trial</h3>
              <Badge status={trial.status} />
            </div>
            <p style={c.muted}>For each session below, decide which image the description better matches. The outcome assignment is sealed from you.</p>
            <div style={c.half}>
              {["A","B"].map(s => (
                <div key={s}>
                  <p style={{ ...c.label, marginBottom: 6 }}>Image {s}</p>
                  <TrialImage trialId={trial.id} side={s} style={c.imgBox} />
                </div>
              ))}
            </div>
          </div>

          {sessions.map((sess, i) => (
            <div key={i} style={c.card}>
              <div style={{ ...c.row, marginBottom: 10, flexWrap: "wrap", gap: 6 }}>
                <p style={{ fontWeight: 500, fontSize: 14, margin: 0 }}>Session {i+1} — {sess.viewerName}</p>
                {sessionDurationLabel(sess) && (
                  <span style={{ fontSize: 12, color: "#085041", fontWeight: 600, background: "#08504112", padding: "2px 8px", borderRadius: 99 }}>
                    ⏱ {sessionDurationLabel(sess)}
                  </span>
                )}
                {sess.confidence && <ConfidencePill value={sess.confidence} />}
              </div>
              <SessionDisplay session={sess} trialId={trial.id} sessionIdx={i} showConfidence={false} />
              <div style={{ ...c.sep, margin: "0.75rem 0" }} />
              <label style={c.label}>Which image does this session better match?</label>
              <div style={{ ...c.row, marginBottom: "0.75rem" }}>
                {[["A","Image A"],["B","Image B"],["M","Mixed"]].map(([v,l]) => (
                  <button key={v} style={{ ...c.btn, ...(votes[i] === v ? { background: "#085041", color: "white", borderColor: "#085041" } : {}) }}
                    onClick={() => setVotes(p => ({ ...p, [i]: v }))}>{l}</button>
                ))}
              </div>
              <div style={c.field}>
                <label style={c.label}>Judging notes <span style={{ fontWeight: 400, textTransform: "none" }}>(optional)</span></label>
                <textarea style={{ ...c.area, minHeight: 70 }} value={notes[i] || ""} onChange={e => setNotes(p => ({ ...p, [i]: e.target.value }))}
                  placeholder="Which elements matched? Why did you choose this image?" />
              </div>
            </div>
          ))}

          <div style={{ ...c.card, background: "var(--color-background-secondary)" }}>
            <p style={{ fontSize: 13, margin: "0 0 10px" }}>
              Tally — A: <strong>{aCount}</strong> · B: <strong>{bCount}</strong>
              {aCount !== bCount && aCount + bCount > 0 && <> · Majority → <strong>Image {aCount > bCount ? "A" : "B"}</strong></>}
              {aCount === bCount && aCount > 0 && <> · <span style={{ color: "var(--color-text-warning)" }}>Tied — no trade</span></>}
            </p>
            <button style={c.btnP} disabled={!allVoted || saving}
              onClick={() => onSubmit(trial.id, sessions.map((_, i) => ({ vote: votes[i] || "M", notes: notes[i] || "" })))}>
              {saving ? "Submitting…" : `Submit Judgments (${Object.keys(votes).length}/${sessions.length})`}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

// ── App Shell ─────────────────────────────────────────────────────────────────
export default function App() {
  const [role, setRole]             = useState(null);
  const [viewerName, setViewerName] = useState("");
  const [data, setData]             = useState(null);
  const [loading, setLoading]       = useState(true);
  const [saving, setSaving]         = useState(false);
  const [notify, setNotify]         = useState(null);

  function flash(msg) { setNotify(msg); setTimeout(() => setNotify(null), 4000); }

  async function refresh() {
    setLoading(true);
    setData(await loadTrialData());
    setLoading(false);
  }

  async function persist(d) {
    setSaving(true);
    try { await saveTrialData(d); setData({ ...d }); }
    catch { flash("Save failed"); }
    setSaving(false);
  }

  function patchTrial(id, updates) {
    return { ...data, trials: (data.trials || []).map(t => t.id === id ? { ...t, ...updates } : t) };
  }

  async function handleRepeat(originalTrialId) {
    const original = (data.trials || []).find(t => t.id === originalTrialId);
    if (!original) { flash("Could not find original trial"); return; }
    setSaving(true);
    try {
      const newId = uid();
      // Copy images to new storage keys
      const [imgA, imgB] = await Promise.all([loadImg(originalTrialId, "A"), loadImg(originalTrialId, "B")]);
      if (!imgA || !imgB) throw new Error("Could not load original images");
      await saveImg(newId, "A", imgA);
      await saveImg(newId, "B", imgB);
      const newTrial = {
        ...original,
        id: newId,
        targetRef: genTargetRef(),
        upImage: Math.random() < 0.5 ? "A" : "B",
        status: "viewing",
        sessions: [],
        judgments: [],
        prediction: null,
        actual: null,
        feedbackSide: null,
        repeatedFrom: originalTrialId,
      };
      const newData = { ...data, trials: [newTrial, ...(data.trials || [])] };
      await saveTrialData(newData);
      setData(newData);
      flash("New trial opened — same target, new reference number");
    } catch(e) {
      flash("Error: " + (e.message || "Could not repeat trial"));
    }
    setSaving(false);
  }

  async function handleCreate(t) {
    setSaving(true);
    try {
      await saveImg(t.id, "A", t.imgA);
      await saveImg(t.id, "B", t.imgB);
      const slim = { ...t };
      delete slim.imgA;
      delete slim.imgB;
      // Register these images as recently used so future trials avoid them
      const idA = t.nameA || `trial-${t.id}-A`;
      const idB = t.nameB || `trial-${t.id}-B`;
      await addRecentTargets(idA, idB);
      delete slim.nameA;
      delete slim.nameB;
      const newData = { ...data, trials: [slim, ...(data.trials || [])] };
      await saveTrialData(newData);
      setData(newData);
      flash("Trial created");
    } catch(e) {
      flash("Error: " + (e.message || "Could not save trial"));
    }
    setSaving(false);
  }

  useEffect(() => { refresh(); }, []);

  if (loading) return <div style={{ ...c.wrap, paddingTop: "3rem", textAlign: "center", color: "var(--color-text-secondary)" }}>Loading…</div>;
  if (!role)   return <RoleSelect onSelect={(r, n) => { setRole(r); setViewerName(n || ""); }} />;

  const trials = data?.trials || [];
  const toolbar = (
    <div style={{ ...c.row, padding: "0.75rem 1.25rem 0", justifyContent: "flex-end" }}>
      <button style={{ ...c.btn, fontSize: 12 }} onClick={refresh}>↺ Refresh</button>
      <button style={{ ...c.btn, fontSize: 12 }} onClick={() => setRole(null)}>← Home</button>
    </div>
  );

  if (role === "solo") return (
    <>{toolbar}<SoloView viewerName={viewerName} trials={trials} saving={saving} notify={notify}
      onCreate={handleCreate} onRepeat={handleRepeat}
      onUpdate={async (id, updates) => { await persist(patchTrial(id, updates)); }} /></>
  );

  if (role === "coordinator") return (
    <>{toolbar}<CoordView trials={trials} saving={saving} notify={notify}
      onCreate={handleCreate} onRepeat={handleRepeat}
      onUpdate={async (id, updates) => {
        await persist(patchTrial(id, updates));
        flash(updates.status === "complete" ? "Outcome recorded — feedback released" : "Saved");
      }}
      onJudge={async (trialId, judgments) => {
        const t = trials.find(x => x.id === trialId);
        const valid = judgments.map(j => j.vote).filter(v => v !== "M");
        const a = valid.filter(v => v === "A").length;
        const b = valid.filter(v => v === "B").length;
        const winner = a > b ? "A" : b > a ? "B" : null;
        const prediction = winner === null ? null : winner === t.upImage ? "Up" : "Down";
        await persist({ ...data, trials: trials.map(x => x.id === trialId ? { ...x, judgments, prediction, status: "predicted" } : x) });
        flash(prediction ? `Prediction: ${outLabel(t, prediction)}` : "Tied — no clear prediction");
      }} /></>
  );

  if (role === "viewer") return (
    <>{toolbar}<ViewerView viewerName={viewerName} trials={trials} saving={saving} notify={notify}
      onSubmit={async (trialId, sessionData, ideogramData, siteSketchData) => {
        const t = trials.find(x => x.id === trialId);
        const sessionIdx = (t.sessions || []).length;
        // Save sketches first (non-fatal if they fail)
        if (ideogramData)   { try { await saveSketch(trialId, sessionIdx, "ideogram", ideogramData); } catch {} }
        if (siteSketchData) { try { await saveSketch(trialId, sessionIdx, "site", siteSketchData); } catch {} }
        const session = { viewerName, ...sessionData, timestamp: new Date().toISOString() };
        await persist({ ...data, trials: trials.map(x => x.id === trialId ? { ...t, sessions: [...(t.sessions || []), session] } : x) });
        flash("Session submitted");
      }} /></>
  );

  return null;
}
