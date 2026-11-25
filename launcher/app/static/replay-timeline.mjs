export function playbackTime(seconds) {
  const total = Math.floor(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor(total / 60) % 60;
  const clock = [minutes, total % 60].map(value => String(value).padStart(2, "0")).join(":");
  return hours ? `${hours}:${clock}` : clock;
}

export function replayTimeline({ root, slider, time, status, buttons, request = fetch }) {
  let playback = null;
  let scrubbing = false;
  let pending = null;
  let queuedSeek = null;
  let error = "";

  function render() {
    root.hidden = !playback;
    if (!playback) return;
    const { state, elapsed_s, duration_s } = playback;
    const seeking = state === "seeking" || pending?.action === "seek";
    slider.max = String(duration_s);
    if (!scrubbing) slider.value = String(queuedSeek ?? pending?.elapsed_s ?? elapsed_s);
    time.textContent = `${playbackTime(Number(slider.value))} / ${playbackTime(duration_s)}`;
    slider.setAttribute("aria-valuetext", time.textContent);
    const unavailable = duration_s === 0 || state === "error";
    slider.disabled = unavailable;
    status.textContent = error || (state === "error" ? "Playback unavailable" : seeking ? "Seeking…" : "");
    buttons.play.disabled = unavailable || Boolean(pending) || state === "playing";
    buttons.pause.disabled = unavailable || Boolean(pending) || !["playing", "seeking"].includes(state);
    buttons.stop.disabled = unavailable || Boolean(pending) || state === "stopped";
  }

  async function command(action, elapsed_s) {
    const session_id = playback?.session_id;
    if (!session_id || playback.duration_s === 0 || playback.state === "error") return;
    if (pending) {
      if (action === "seek") {
        queuedSeek = elapsed_s;
        render();
      }
      return;
    }
    const intent = { action, elapsed_s, session_id };
    pending = intent;
    error = "";
    render();
    try {
      const response = await request("/api/replay/playback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(intent),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(typeof result.detail === "string" ? result.detail : "Playback command failed");
      // The event stream owns playback state. Applying this response could rewind
      // the thumb if a newer authoritative event already reached the browser.
    } catch (failure) {
      if (pending === intent) error = failure.message;
    } finally {
      if (pending === intent) {
        pending = null;
        const nextSeek = queuedSeek;
        queuedSeek = null;
        if (nextSeek !== null) void command("seek", nextSeek);
        else render();
      }
    }
  }

  // Native range input dispatches change on release and keyboard adjustments.
  slider.addEventListener("pointerdown", () => { scrubbing = true; });
  slider.addEventListener("pointerup", () => {
    // A press without a value change still needs to release the preview lock.
    setTimeout(() => {
      if (scrubbing) {
        scrubbing = false;
        render();
      }
    }, 0);
  });
  slider.addEventListener("input", () => {
    scrubbing = true;
    render();
  });
  slider.addEventListener("change", () => {
    const target = Number(slider.value);
    scrubbing = false;
    void command("seek", target);
  });
  slider.addEventListener("pointercancel", () => {
    scrubbing = false;
    render();
  });

  for (const [action, button] of Object.entries(buttons)) {
    button.addEventListener("click", () => void command(action));
  }

  return {
    observe(next) {
      if (next?.session_id !== playback?.session_id) {
        scrubbing = false;
        pending = null;
        queuedSeek = null;
        error = "";
      }
      playback = next;
      render();
    },
  };
}
