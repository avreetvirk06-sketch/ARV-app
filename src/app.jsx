# ARV app – changes

All storage keys are unchanged (`arv-v5-data`, `arv-v5-img-…`, `arv-v5-sk-…`, etc.), so every trial, image, sketch and RV session you already have keeps working. Old sessions (which have no `sid`) still load their sketches by index, exactly as before.

Edit `App.jsx` in this order. "Replace" means: delete the old version and paste the new one in the same place.

---

## 1. Helpers (top of file)

**1a.** Directly **below** the existing `loadTrialData` function, add:

```js
const BACKUP_KEY = "arv-v5-data-backup";
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Safe loader: retries, and reports failure instead of pretending the list is empty
async function loadTrialDataSafe() {
  for (let i = 0; i < 3; i++) {
    try {
      const r = await window.storage.get(DATA_KEY, true);
      if (!r) return { data: { trials: [] }, failed: false, raw: null };
      const d = JSON.parse(r.value);
      if (!Array.isArray(d.trials)) d.trials = [];
      return { data: d, failed: false, raw: r.value };
    } catch { await sleep(250 * (i + 1)); }
  }
  return { data: { trials: [] }, failed: true, raw: null };
}
```

**1b.** Replace the whole `loadImg` function with:

```js
async function loadImg(id, side) {
  for (let i = 0; i < 3; i++) {
    try { const r = await window.storage.get(imgKey(id, side), true); if (r?.value) return r.value; } catch {}
    await sleep(300 * (i + 1));
  }
  return null;
}
```

**1c.** Replace the whole `outLabel` function with:

```js
function outLabel(t, which) {
  if (!which) return "None";
  if (which === "Up") return t?.outcomeUp?.trim() || "Up ↑";
  return t?.outcomeDown?.trim() || "Down ↓";
}
```

---

## 2. `TrialImage` – replace the whole function

(Fixes an old image lingering on screen when switching trials, and adds retry.)

```jsx
function TrialImage({ trialId, side, style }) {
  const [src, setSrc] = useState(null);
  const [state, setState] = useState("loading");
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setSrc(null); setState("loading");
    if (!trialId || !side) { setState("missing"); return; }
    loadImg(trialId, side).then(s => {
      if (cancelled) return;
      if (s) { setSrc(s); setState("ok"); } else setState("missing");
    });
    return () => { cancelled = true; };
  }, [trialId, side, tick]);
  if (state === "loading") return <div style={{ ...style, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, color: "var(--color-text-secondary)", minHeight: 80 }}>Loading…</div>;
  if (state === "missing") return (
    <div style={{ ...style, display: "flex", alignItems: "center", justifyContent: "center", gap: 8, fontSize: 12, color: "var(--color-text-secondary)", minHeight: 80 }}>
      Image unavailable <button style={{ ...c.btn, fontSize: 11, padding: "2px 8px" }} onClick={() => setTick(t => t + 1)}>Retry</button>
    </div>
  );
  return <img src={src} style={style} alt={`Image ${side}`} />;
}
```

---

## 3. `SessionDisplay` – swap the sketch-loading effect

Find this:

```js
  useEffect(() => {
    if (trialId == null || sessionIdx == null) return;
    loadSketch(trialId, sessionIdx, "ideogram").then(d => { if (d) setIdeogram(d); });
    loadSketch(trialId, sessionIdx, "site").then(d => { if (d) setSiteSketch(d); });
  }, [trialId, sessionIdx]);
```

Replace with:

```js
  const skId = session?.sid ?? sessionIdx;   // new sessions use a unique id; old ones keep using their index
  useEffect(() => {
    setIdeogram(null); setSiteSketch(null);
    if (trialId == null || skId == null) return;
    let cancelled = false;
    loadSketch(trialId, skId, "ideogram").then(d => { if (d && !cancelled) setIdeogram(d); });
    loadSketch(trialId, skId, "site").then(d => { if (d && !cancelled) setSiteSketch(d); });
    return () => { cancelled = true; };
  }, [trialId, skId]);
```

---

## 4. `NewTrialForm` – add a created date

In `handleSubmit`, change

```js
      targetRef: genTargetRef(), upImage: Math.random() < 0.5 ? "A" : "B",
```
to
```js
      createdAt: new Date().toISOString(),
      targetRef: genTargetRef(), upImage: Math.random() < 0.5 ? "A" : "B",
```

---

## 5. `SoloView` and `CoordView` – "create trial" navigation (2 places)

Both views have this inside `onSave`:

```js
        await onCreate(t);
        setPage("list");
```
Replace **both** with:
```js
        const ok = await onCreate(t);
        if (ok) setPage("list");
```

---

## 6. `SoloView` – session submit (fixes sketch/session overwrites)

Find:

```js
                    const sessionIdx = sessions.length;
                    if (ideogramData)   { try { await saveSketch(trial.id, sessionIdx, "ideogram", ideogramData); } catch {} }
                    if (siteSketchData) { try { await saveSketch(trial.id, sessionIdx, "site",     siteSketchData); } catch {} }
                    await onUpdate(trial.id, {
                      sessions: [...sessions, { viewerName, ...sessionData, timestamp: new Date().toISOString() }],
                    });
```

Replace with:

```js
                    const sid = uid();
                    if (ideogramData)   { try { await saveSketch(trial.id, sid, "ideogram", ideogramData); } catch {} }
                    if (siteSketchData) { try { await saveSketch(trial.id, sid, "site",     siteSketchData); } catch {} }
                    const newSession = { sid, viewerName, ...sessionData, timestamp: new Date().toISOString() };
                    await onUpdate(trial.id, t => ({ sessions: [...(t.sessions || []), newSession] }));
```

---

## 7. `CoordView` – trial page (new outcome flow)

Inside `CoordView`, replace the whole `if (page === "trial" && trial) { … }` block (from that line down to the closing `}` just above `const activeTrials = groupTrials…`) with:

```jsx
  if (page === "trial" && trial) {
    const upL   = outLabel(trial, "Up");
    const downL = outLabel(trial, "Down");
    const isViewing   = trial.status === "viewing";
    const isPredicted = trial.status === "predicted";
    const isComplete  = trial.status === "complete";
    // image that matches the outcome button currently selected
    const previewSide = actual ? (actual === "Up" ? trial.upImage : (trial.upImage === "A" ? "B" : "A")) : null;
    const outBtn = v => ({ ...c.btn, ...(actual === v ? { background: "#085041", color: "white", borderColor: "#085041" } : {}) });

    return (
      <div style={c.wrap}>
        <button style={{ ...c.btn, marginBottom: "1rem" }} onClick={() => { setPage("list"); setTid(null); setVotes({}); setActual(""); }}>← Back</button>
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
        {isComplete
          ? <p style={{ ...c.muted, marginBottom: "1rem" }}>Image {trial.upImage} = <strong>{upL}</strong> · Image {trial.upImage === "A" ? "B" : "A"} = <strong>{downL}</strong></p>
          : <p style={{ fontSize: 13, color: "var(--color-text-secondary)", marginBottom: "1rem" }}>
              🔒 {isPredicted ? "Outcome assignment sealed — select the actual outcome below to reveal the matching feedback image" : "Outcome assignment sealed until judging is complete"}
            </p>}
        <Notify msg={notify} />

        {/* Both images only while judging (sealed) or after the trial is complete */}
        {(isViewing || isComplete) && (
          <div style={c.half}>
            {["A","B"].map(s => (
              <div key={s}>
                <p style={{ ...c.label, marginBottom: 6 }}>Image {s}{isComplete ? ` — ${trial.upImage === s ? upL : downL}` : ""}</p>
                <TrialImage trialId={trial.id} side={s} style={c.imgBox} />
              </div>
            ))}
          </div>
        )}

        {/* Session list is hidden at the "predicted" stage – it appears next to the feedback image instead */}
        {!isPredicted && (
          <>
            <div style={c.sep} />
            <h3 style={c.h3}>Sessions ({sessions.length})</h3>
            {!sessions.length ? <p style={c.muted}>No sessions yet.</p>
              : sessions.map((s, i) => (
                <div key={s.sid || i} style={{ ...c.card, marginBottom: "0.5rem" }}>
                  <div style={{ ...c.row, marginBottom: 8 }}>
                    <p style={{ fontWeight: 500, fontSize: 13, margin: 0 }}>{s.viewerName}</p>
                    {s.confidence && <ConfidencePill value={s.confidence} />}
                  </div>
                  <SessionDisplay session={s} trialId={trial.id} sessionIdx={i} showConfidence={false} />
                </div>
              ))
            }
          </>
        )}

        {sessions.length > 0 && (
          <>
            <div style={c.sep} />
            {isViewing ? (
              <>
                <h3 style={c.h3}>Judge sessions</h3>
                <p style={c.muted}>Compare each session to both images above and vote for the better match. The outcome assignment is still sealed.</p>
                {sessions.map((sess, i) => (
                  <div key={sess.sid || i} style={c.card}>
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
                <p style={{ fontSize: 14, marginTop: 8 }}>
                  Prediction: <strong>{trial.prediction ? outLabel(trial, trial.prediction) : "None — tied / mixed (no trade)"}</strong>
                </p>
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

        {/* ── Record outcome: two buttons, then reveal only the matching image + sessions ── */}
        {isPredicted && (
          <>
            <div style={c.sep} />
            <h3 style={c.h3}>Record actual outcome</h3>
            <p style={c.muted}>Select what actually happened. The matching feedback image and the session(s) will appear for review before you release feedback.</p>
            <div style={{ ...c.row, marginBottom: "0.75rem" }}>
              {[["Up", upL], ["Down", downL]].map(([v, l]) => (
                <button key={v} style={outBtn(v)} onClick={() => setActual(v)}>{l}</button>
              ))}
            </div>

            {previewSide && (
              <div style={{ ...c.card, borderColor: "#085041", marginBottom: "0.75rem" }}>
                <h3 style={c.h3}>Feedback preview — {outLabel(trial, actual)}</h3>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1rem", alignItems: "start" }}>
                  <div>
                    <p style={{ ...c.label, marginBottom: 6 }}>Feedback image</p>
                    <TrialImage key={previewSide} trialId={trial.id} side={previewSide} style={c.imgFull} />
                  </div>
                  <div>
                    <p style={{ ...c.label, marginBottom: 6 }}>Session{sessions.length > 1 ? "s" : ""}</p>
                    {sessions.map((s, i) => (
                      <div key={s.sid || i} style={{ marginBottom: i < sessions.length - 1 ? "0.75rem" : 0 }}>
                        <p style={{ fontSize: 11, fontWeight: 700, color: "#085041", margin: "0 0 4px", textTransform: "uppercase", letterSpacing: "0.05em" }}>
                          {s.viewerName || `Session ${i + 1}`}
                        </p>
                        <SessionDisplay session={s} trialId={trial.id} sessionIdx={i} showConfidence />
                        {i < sessions.length - 1 && <div style={{ ...c.sep, margin: "0.5rem 0" }} />}
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}

            <button style={c.btnP} disabled={!actual || saving}
              onClick={async () => {
                const feedbackSide = actual === "Up" ? trial.upImage : (trial.upImage === "A" ? "B" : "A");
                await onUpdate(trial.id, { actual, feedbackSide, status: "complete" });
                setActual("");
              }}>
              {saving ? "Saving…" : "Record & Release Feedback"}
            </button>
          </>
        )}

        {isComplete && (
          <>
            <div style={{ ...c.card, marginTop: "1rem", background: !trial.prediction ? "var(--color-background-secondary)" : trial.actual === trial.prediction ? "var(--color-background-success)" : "var(--color-background-danger)" }}>
              <p style={{ fontSize: 14, margin: 0 }}>
                Prediction: <strong>{outLabel(trial, trial.prediction)}</strong> · Actual: <strong>{outLabel(trial, trial.actual)}</strong> ·{" "}
                {!trial.prediction
                  ? <span style={{ color: "var(--color-text-secondary)" }}>No trade (tied)</span>
                  : trial.actual === trial.prediction
                    ? <span style={{ color: "var(--color-text-success)" }}>Correct ✓</span>
                    : <span style={{ color: "var(--color-text-danger)" }}>Incorrect ✗</span>}
              </p>
            </div>
            {trial.feedbackSide && (
              <div style={{ ...c.card, marginTop: "0.75rem" }}>
                <h3 style={c.h3}>Feedback Image (released to viewers)</h3>
                <p style={{ ...c.muted, margin: "0 0 0.75rem" }}>
                  Image {trial.feedbackSide} — associated with the actual outcome <strong>{outLabel(trial, trial.actual)}</strong>
                </p>
                <TrialImage trialId={trial.id} side={trial.feedbackSide} style={c.imgBox} />
                <p style={{ fontSize: 12, color: "var(--color-text-secondary)", marginTop: 8, marginBottom: 0 }}>
                  Viewers can open this from their "Feedback on previous trials" menu.
                </p>
              </div>
            )}
          </>
        )}
      </div>
    );
  }
```

---

## 8. `ViewerView` – feedback menu for all trials

**8a.** Add one state next to the other `useState` lines at the top of `ViewerView`:

```js
  const [feedbackId, setFeedbackId] = useState(null);
```

**8b.** Change the `judgedTrials` line so tied/no-trade trials don't count as wrong:

```js
  const judgedTrials  = myTrials.filter(t => t.status === "complete" && t.feedbackSide && t.prediction);
```

**8c.** Replace the whole `const feedbackTrial = [...groupTrials] … [0] || null;` statement with:

```js
  const mySessionTime = t => t.sessions?.find(s => s.viewerName === viewerName)?.timestamp || "";
  const feedbackTrials = [...groupTrials]
    .filter(t => t.status === "complete" && t.feedbackSide && t.sessions?.some(s => s.viewerName === viewerName))
    .sort((a, b) => mySessionTime(b).localeCompare(mySessionTime(a)));   // newest first
  const feedbackTrial = feedbackTrials.find(t => t.id === feedbackId) || feedbackTrials[0] || null;
```

**8d.** Replace everything from `{/* ── Previous trial feedback ── */}` down to (not including) `{/* ── Stats panel ── */}` with:

```jsx
      {/* ── Feedback on previous trials (dropdown of every trial with released feedback) ── */}
      {feedbackTrials.length > 0 && (
        <div style={{ marginBottom: "1.25rem" }}>
          <button
            style={{ ...c.btn, width: "100%", textAlign: "left", padding: "10px 16px", display: "flex", justifyContent: "space-between", alignItems: "center", borderColor: showFeedback ? "#085041" : "var(--color-border-secondary)", background: showFeedback ? "#08504108" : "transparent" }}
            onClick={() => setShowFeedback(v => !v)}>
            <span style={{ fontWeight: 500, fontSize: 14 }}>📋 Feedback on previous trials</span>
            <span style={{ fontSize: 12, color: "var(--color-text-secondary)", fontWeight: 500 }}>
              {feedbackTrials.length} trial{feedbackTrials.length !== 1 ? "s" : ""} {showFeedback ? "▲" : "▼"}
            </span>
          </button>
          {showFeedback && feedbackTrial && (
            <div style={{ ...c.card, borderTop: "none", borderTopLeftRadius: 0, borderTopRightRadius: 0, borderColor: "#085041" }}>
              <label style={c.label}>Choose a trial</label>
              <select style={{ ...c.input, marginBottom: "0.75rem" }} value={feedbackTrial.id} onChange={e => setFeedbackId(e.target.value)}>
                {feedbackTrials.map(t => (
                  <option key={t.id} value={t.id}>
                    {(t.targetRef ? `REF #${t.targetRef}` : "Trial")}{fmtDate(t) ? ` · ${fmtDate(t)}` : ""}
                  </option>
                ))}
              </select>
              <p style={{ ...c.label, marginBottom: 6 }}>Feedback image</p>
              <TrialImage key={feedbackTrial.id} trialId={feedbackTrial.id} side={feedbackTrial.feedbackSide} style={c.imgFull} />
            </div>
          )}
        </div>
      )}

```

---

## 9. `App` – replace the whole `export default function App() { … }`

This is the core fix for the "two viewers submit and only one shows" problem and for feedback sometimes not appearing.

```jsx
export default function App() {
  const [role, setRole]             = useState(null);
  const [viewerName, setViewerName] = useState("");
  const [data, setData]             = useState(null);
  const [loading, setLoading]       = useState(true);
  const [loadError, setLoadError]   = useState(false);
  const [saving, setSaving]         = useState(false);
  const [notify, setNotify]         = useState(null);
  const lastGoodRef = useRef(null);
  const queueRef    = useRef(Promise.resolve());
  const busyRef     = useRef(0);
  const stampRef    = useRef(0);

  function flash(msg) { setNotify(msg); setTimeout(() => setNotify(null), 4000); }

  // Full load (first screen). Never shows an empty list if storage simply failed.
  async function refresh() {
    setLoading(true);
    const { data: d, failed } = await loadTrialDataSafe();
    if (failed) setLoadError(true);
    else { setLoadError(false); lastGoodRef.current = d; setData(d); }
    setLoading(false);
  }

  // Background refresh – does NOT unmount the screen, so a viewer's half-finished session is never lost
  async function silentRefresh() {
    if (busyRef.current > 0) return;
    const stamp = stampRef.current;
    const { data: d, failed } = await loadTrialDataSafe();
    if (failed || busyRef.current > 0 || stamp !== stampRef.current) return;
    lastGoodRef.current = d;
    setData(prev => (prev && JSON.stringify(prev) === JSON.stringify(d)) ? prev : d);
  }

  // Read the LATEST data, apply the change, save, then re-read to confirm it stuck (retries if
  // someone else's save overwrote it). Local saves are queued so they never overlap.
  async function runUpdate(mutator, verify) {
    for (let attempt = 0; attempt < 4; attempt++) {
      const { data: fresh, failed, raw } = await loadTrialDataSafe();
      if (failed && lastGoodRef.current?.trials?.length)
        throw new Error("Could not reach storage — nothing was changed. Please try again.");
      const next = mutator(fresh);
      if (next === null || next === undefined) return { aborted: true };
      if (raw && fresh.trials.length) { try { await window.storage.set(BACKUP_KEY, raw, true); } catch {} } // safety copy of previous state
      await saveTrialData(next);
      const check = await loadTrialDataSafe();
      if (!check.failed && (!verify || verify(check.data))) {
        stampRef.current++;
        lastGoodRef.current = check.data;
        setData(check.data);
        return { ok: true, data: check.data };
      }
      await sleep(200 + Math.random() * 400);
    }
    throw new Error("Save could not be confirmed — please check and try again.");
  }

  function updateData(mutator, verify) {
    const job = queueRef.current.then(async () => {
      busyRef.current++;
      try { return await runUpdate(mutator, verify); } finally { busyRef.current--; }
    });
    queueRef.current = job.catch(() => {});
    return job;
  }

  // updatesOrFn: object of fields, or (trial) => fields | null (null = abort)
  function updateTrial(id, updatesOrFn, verify) {
    return updateData(d => {
      const t = d.trials.find(x => x.id === id);
      if (!t) return null;
      const upd = typeof updatesOrFn === "function" ? updatesOrFn(t) : updatesOrFn;
      if (!upd) return null;
      return { ...d, trials: d.trials.map(x => x.id === id ? { ...x, ...upd } : x) };
    }, verify ? (nd => { const t = nd.trials.find(x => x.id === id); return !!t && verify(t); }) : undefined);
  }

  async function run(fn) {
    setSaving(true);
    try { return await fn(); }
    catch (e) { flash("Error: " + (e.message || "Save failed")); return null; }
    finally { setSaving(false); }
  }

  function applyUpdate(id, updates) {
    const verify = (updates && typeof updates === "object" && updates.status) ? (t => t.status === updates.status) : undefined;
    return run(() => updateTrial(id, updates, verify));
  }

  async function handleCreate(t) {
    const res = await run(async () => {
      await saveImg(t.id, "A", t.imgA);
      await saveImg(t.id, "B", t.imgB);
      await addRecentTargets(t.nameA || `trial-${t.id}-A`, t.nameB || `trial-${t.id}-B`);
      const slim = { ...t };
      delete slim.imgA; delete slim.imgB; delete slim.nameA; delete slim.nameB;
      return updateData(
        d => d.trials.some(x => x.id === slim.id) ? d : { ...d, trials: [slim, ...d.trials] },
        nd => nd.trials.some(x => x.id === slim.id)
      );
    });
    if (res?.ok) { flash("Trial created"); return true; }
    return false;
  }

  async function handleRepeat(originalTrialId) {
    const original = (data?.trials || []).find(t => t.id === originalTrialId);
    if (!original) { flash("Could not find original trial"); return; }
    const res = await run(async () => {
      const newId = uid();
      const [imgA, imgB] = await Promise.all([loadImg(originalTrialId, "A"), loadImg(originalTrialId, "B")]);
      if (!imgA || !imgB) throw new Error("Could not load original images");
      await saveImg(newId, "A", imgA);
      await saveImg(newId, "B", imgB);
      const newTrial = {
        ...original, id: newId, createdAt: new Date().toISOString(),
        targetRef: genTargetRef(), upImage: Math.random() < 0.5 ? "A" : "B",
        status: "viewing", sessions: [], judgments: [], prediction: null, actual: null, feedbackSide: null,
        repeatedFrom: originalTrialId,
      };
      return updateData(
        d => d.trials.some(x => x.id === newId) ? d : { ...d, trials: [newTrial, ...d.trials] },
        nd => nd.trials.some(x => x.id === newId)
      );
    });
    if (res?.ok) flash("New trial opened — same target, new reference number");
  }

  useEffect(() => { refresh(); }, []);
  // Everyone's screen picks up new sessions / released feedback automatically
  useEffect(() => {
    const id = setInterval(() => { if (!document.hidden) silentRefresh(); }, 15000);
    return () => clearInterval(id);
  }, []);

  if (loading) return <div style={{ ...c.wrap, paddingTop: "3rem", textAlign: "center", color: "var(--color-text-secondary)" }}>Loading…</div>;
  if (loadError || !data) return (
    <div style={{ ...c.wrap, paddingTop: "3rem", textAlign: "center" }}>
      <p style={c.muted}>Couldn't load the experiment data. Nothing has been changed or deleted.</p>
      <button style={c.btnP} onClick={refresh}>Retry</button>
    </div>
  );
  if (!role) return <RoleSelect onSelect={(r, n) => { setRole(r); setViewerName(n || ""); }} />;

  const trials = data?.trials || [];
  const toolbar = (
    <div style={{ ...c.row, padding: "0.75rem 1.25rem 0", justifyContent: "flex-end" }}>
      <button style={{ ...c.btn, fontSize: 12 }} onClick={() => silentRefresh()}>↺ Refresh</button>
      <button style={{ ...c.btn, fontSize: 12 }} onClick={() => setRole(null)}>← Home</button>
    </div>
  );

  if (role === "solo") return (
    <>{toolbar}<SoloView viewerName={viewerName} trials={trials} saving={saving} notify={notify}
      onCreate={handleCreate} onRepeat={handleRepeat}
      onUpdate={async (id, updates) => { await applyUpdate(id, updates); }} /></>
  );

  if (role === "coordinator") return (
    <>{toolbar}<CoordView trials={trials} saving={saving} notify={notify}
      onCreate={handleCreate} onRepeat={handleRepeat}
      onUpdate={async (id, updates) => {
        const r = await applyUpdate(id, updates);
        if (r?.ok) flash(updates.status === "complete" ? "Outcome recorded — feedback released" : "Saved");
      }}
      onJudge={async (trialId, judgments) => {
        const res = await run(() => updateTrial(trialId, t => {
          if (t.status !== "viewing" || (t.sessions || []).length !== judgments.length) return null;
          const valid = judgments.map(j => j.vote).filter(v => v !== "M");
          const a = valid.filter(v => v === "A").length;
          const b = valid.filter(v => v === "B").length;
          const winner = a > b ? "A" : b > a ? "B" : null;
          const prediction = winner === null ? null : winner === t.upImage ? "Up" : "Down";
          return { judgments, prediction, status: "predicted" };
        }, t => t.status === "predicted"));
        if (res?.ok) {
          const t = res.data.trials.find(x => x.id === trialId);
          flash(t?.prediction ? `Prediction: ${outLabel(t, t.prediction)}` : "Tied — no clear prediction");
        } else if (res?.aborted) {
          flash("A new session came in (or this trial was already judged) — review the sessions and submit again.");
        }
      }} /></>
  );

  if (role === "viewer") return (
    <>{toolbar}<ViewerView viewerName={viewerName} trials={trials} saving={saving} notify={notify}
      onSubmit={async (trialId, sessionData, ideogramData, siteSketchData) => {
        const sid = uid();   // unique id → sketches can never collide between viewers
        if (ideogramData)   { try { await saveSketch(trialId, sid, "ideogram", ideogramData); } catch {} }
        if (siteSketchData) { try { await saveSketch(trialId, sid, "site", siteSketchData); } catch {} }
        const session = { sid, viewerName, ...sessionData, timestamp: new Date().toISOString() };
        const res = await run(() => updateTrial(trialId, t => {
          const list = t.sessions || [];
          if (list.some(s => s.sid === sid)) return {};                                   // already saved
          if (t.status !== "viewing" || list.some(s => s.viewerName === viewerName)) return null;
          return { sessions: [...list, session] };                                        // added to the LATEST list
        }, t => (t.sessions || []).some(s => s.sid === sid)));
        if (res?.ok) flash("Session submitted");
        else if (res?.aborted) flash("Could not submit — this trial is closed or you already submitted a session.");
      }} /></>
  );

  return null;
}
```

---

## What was fixed

- **Two viewers, one session showing / feedback sometimes missing:** every save used to overwrite the whole trial list from whatever each person's screen last loaded, so the second save wiped the first. Saves now re-read the latest data, add only their change, save, and confirm it stuck (retrying if not). Screens also auto-refresh every 15 seconds.
- **Sketch mix-ups:** new sessions store sketches under a unique id instead of "session number", so two viewers can't overwrite each other's ideogram/site sketch. Old sessions still load theirs the old way.
- **Refresh wiped half-finished sessions:** the Refresh button used to unmount the page. It now refreshes in the background.
- **Possible data loss:** if storage hiccups on load, the app now shows "Retry" instead of an empty list (which could be saved over your data). A backup copy of the previous state is written to `arv-v5-data-backup` before every save.
- **Image display:** an old image could linger when switching trials, and failed loads stayed on "Loading…" forever. Images now retry and show a Retry button.
- **Tied/no-trade trials** were being labelled "Down" and counted as incorrect in viewer stats.
- **Judging while a new session arrives:** judging is blocked with a message instead of lining votes up with the wrong sessions.
- **Create trial** only returns to the list if the save really worked.
