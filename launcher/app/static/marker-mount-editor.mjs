// Static form metadata. Marker defaults and presets come from launcher settings.
const FIELD_META = [
  { field: "print_size_mm", label: "Print size (mm)", step: 1, min: 20, max: 200 },
  { field: "forward_m", label: "Forward (m)", step: 0.01 },
  { field: "lateral_m", label: "Lateral (m)", step: 0.01 },
  { field: "up_m", label: "Up (m)", step: 0.01 },
  { field: "yaw_deg", label: "Yaw (°)", step: 1 },
  { field: "pitch_deg", label: "Pitch (°)", step: 1 },
  { field: "roll_deg", label: "Roll (°)", step: 1 },
];

/** Renders marker controls around the profile owner's calibration draft. */
export function markerMountEditor({ tagList, empty, addTagBtn, restoreTagsBtn, editor, isLocked, changed, report }) {
  let defaultMount = {};
  let presetMarkerIds = [];
  let presetsByRobot = {};
  let renderRevision = 0;

  function cloneMount(raw) {
    const src = { ...defaultMount, ...raw };
    return {
      marker_id: Number(src.marker_id) || 0,
      print_size_mm: Number(src.print_size_mm),
      forward_m: Number(src.forward_m) || 0,
      lateral_m: Number(src.lateral_m) || 0,
      up_m: Number(src.up_m) || 0,
      yaw_deg: Number(src.yaw_deg) || 0,
      pitch_deg: Number(src.pitch_deg) || 0,
      roll_deg: Number(src.roll_deg) || 0,
    };
  }

  function makeNumInput(meta, value, onChange) {
    const wrap = document.createElement("div");
    wrap.className = "num-input";

    const dec = document.createElement("button");
    dec.type = "button";
    dec.className = "num-btn";
    dec.textContent = "−";
    dec.setAttribute("aria-label", `Decrease ${meta.label}`);

    const input = document.createElement("input");
    input.type = "number";
    input.step = String(meta.step);
    if (meta.min != null) input.min = String(meta.min);
    if (meta.max != null) input.max = String(meta.max);
    let committed = Number(Number(value).toFixed(6));
    input.value = String(committed);
    input.dataset.field = meta.field;
    input.setAttribute("aria-label", meta.label);
    input.disabled = isLocked();

    const inc = document.createElement("button");
    inc.type = "button";
    inc.className = "num-btn";
    inc.textContent = "+";
    inc.setAttribute("aria-label", `Increase ${meta.label}`);

    const commit = (next) => {
      let n = next === "" ? NaN : Number(next);
      if (!Number.isFinite(n)) {
        input.value = String(committed);
        return;
      }
      if (meta.min != null) n = Math.max(meta.min, n);
      if (meta.max != null) n = Math.min(meta.max, n);
      if (meta.field === "print_size_mm" && n <= 0) n = defaultMount.print_size_mm;
      input.value = String(n);
      if (n === committed) return;
      committed = n;
      onChange(n);
    };

    dec.addEventListener("click", () => {
      if (isLocked()) return;
      commit(committed - meta.step);
    });
    inc.addEventListener("click", () => {
      if (isLocked()) return;
      commit(committed + meta.step);
    });
    input.addEventListener("change", () => commit(input.value));

    dec.disabled = isLocked();
    inc.disabled = isLocked();
    wrap.append(dec, input, inc);
    return wrap;
  }

  function usedMarkerIds(exceptIndex) {
    return new Set(
      editor.mounts
        .map((item, index) => (index === exceptIndex ? null : item.marker_id))
        .filter((id) => id != null)
    );
  }


  function isPresetId(id) {
    return presetMarkerIds.includes(Number(id));
  }

  async function decodeUploadedPng(file) {
    const body = new FormData();
    body.append("file", file);
    const res = await fetch("/api/apriltag/decode", { method: "POST", body });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const detail = data.detail || res.statusText;
      throw new Error(typeof detail === "string" ? detail : JSON.stringify(detail));
    }
    return Number(data.marker_id);
  }

  function assignMarkerId(index, markerId) {
    const used = usedMarkerIds(index);
    if (used.has(markerId)) {
      report(`Fiducial marker ID ${markerId} is already in the list`);
      return false;
    }
    editor.mounts[index] = { ...editor.mounts[index], marker_id: markerId };
    return true;
  }

  function makeFileInput(onFile) {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/png";
    input.hidden = true;
    input.disabled = isLocked();
    input.addEventListener("change", async () => {
      const file = input.files && input.files[0];
      input.value = "";
      if (!file || isLocked()) return;
      const profile = editor.robotProfileId;
      const revision = renderRevision;
      const current = () => input.isConnected && !isLocked() &&
        editor.robotProfileId === profile && renderRevision === revision;
      try {
        await onFile(file, current);
      } catch (err) {
        if (!current()) return;
        report(`PNG upload failed: ${err.message || err}`);
      }
    });
    return input;
  }

  function render({ openMarkerIndex = -1, focusType = false, focusAfterRemoval } = {}) {
    const openIds = new Set(Array.from(tagList.querySelectorAll(".tag-card[open]"), card => card.dataset.markerId));
    renderRevision++;
    if (!editor.settingsReady) {
      tagList.replaceChildren();
      return;
    }
    tagList.replaceChildren();
    empty.classList.toggle("hidden", editor.mounts.length !== 0);
    editor.mounts.forEach((mount, index) => {
      const card = document.createElement("details");
      card.className = "tag-card";
      card.dataset.markerId = String(mount.marker_id);
      card.open = index === openMarkerIndex || openIds.has(card.dataset.markerId);

      const summary = document.createElement("summary");
      summary.className = "tag-summary";

      const metaWrap = document.createElement("div");
      metaWrap.className = "tag-summary-meta";
      const title = document.createElement("div");
      title.className = "tag-title";
      const subtitle = document.createElement("div");
      subtitle.className = "tag-subtitle";
      metaWrap.append(title, subtitle);

      const thumbnail = document.createElement("img");
      thumbnail.className = "tag-thumbnail";
      thumbnail.alt = "";
      thumbnail.width = thumbnail.height = 32;

      const syncMarker = () => {
        const current = editor.mounts[index];
        const id = current.marker_id;
        const size = Number(current.print_size_mm.toFixed(6));
        thumbnail.src = `/api/apriltag/${id}.png`;
        printable.href = `/api/apriltag/${id}.pdf?size_mm=${encodeURIComponent(size)}`;
        title.textContent = isPresetId(id)
          ? `Fiducial marker ${id}`
          : `Fiducial marker ${id} (custom)`;
        subtitle.textContent = `${size} mm total · ${(size * 0.8).toFixed(0)} mm black`;
      };

      summary.append(thumbnail, metaWrap);

      const body = document.createElement("div");
      body.className = "tag-body";

      const picker = document.createElement("div");
      picker.className = "settings-fields";
      const typeField = document.createElement("label"); typeField.className = "field";
      const typeLabel = document.createElement("span"); typeLabel.textContent = "Marker type";
      const typeSelect = document.createElement("select"); typeSelect.setAttribute("aria-label", "Marker type");
      typeSelect.disabled = isLocked();
      const used = usedMarkerIds(index);
      const ids = [...presetMarkerIds];
      if (!ids.includes(mount.marker_id)) ids.unshift(mount.marker_id);
      for (const id of ids) {
        const option = document.createElement("option"); option.value = String(id);
        option.textContent = `ID ${id}${isPresetId(id) ? "" : " (saved)"}`;
        option.disabled = used.has(id) && id !== mount.marker_id; typeSelect.append(option);
      }
      const uploadOption = document.createElement("option"); uploadOption.value = "upload";
      uploadOption.textContent = "Upload PNG…"; typeSelect.append(uploadOption);
      typeSelect.value = String(mount.marker_id);
      const uploadInput = makeFileInput(async (file, current) => {
        const markerId = await decodeUploadedPng(file);
        if (!current()) return;
        if (!assignMarkerId(index, markerId)) return;
        render({ openMarkerIndex: index, focusType: document.activeElement === typeSelect });
        changed();
      });
      typeSelect.addEventListener("change", () => {
        if (isLocked()) return;
        if (typeSelect.value === "upload") {
          typeSelect.value = String(editor.mounts[index].marker_id); uploadInput.click(); return;
        }
        if (!assignMarkerId(index, Number(typeSelect.value))) return;
        render({ openMarkerIndex: index, focusType: document.activeElement === typeSelect });
        changed();
      });
      typeField.append(typeLabel, typeSelect);
      const markerField = (meta, labelText = meta.label) => {
        const field = document.createElement("label");
        field.className = "field";
        const label = document.createElement("span");
        label.textContent = labelText;
        const control = makeNumInput(meta, mount[meta.field], (next) => {
          if (isLocked()) return;
          editor.mounts[index] = { ...editor.mounts[index], [meta.field]: next };
          syncMarker();
          changed();
        });
        if (meta.field !== "print_size_mm") control.classList.add("coordinate-input");
        field.append(label, control);
        return field;
      };
      picker.append(typeField, markerField(FIELD_META[0]), uploadInput);

      const grid = document.createElement("div");
      grid.className = "tag-grid";
      const groups = [
        { title: "Mount position (m)", fields: FIELD_META.slice(1, 4) },
        { title: "Mount rotation (°)", fields: FIELD_META.slice(4, 7) },
      ];
      groups.forEach(group => {
        const section = document.createElement("fieldset");
        section.className = "tag-coordinate-group";
        const legend = document.createElement("legend");
        legend.textContent = group.title;
        const row = document.createElement("div");
        row.className = "tag-coordinate-row";
        for (const meta of group.fields) {
          row.append(markerField(meta, meta.label.replace(/ \(.*\)/, "")));
        }
        section.append(legend, row);
        grid.append(section);
      });

      const footer = document.createElement("div");
      footer.className = "settings-actions";
      const printable = document.createElement("a");
      printable.className = "tag-print-link";
      printable.target = "_blank";
      printable.rel = "noopener";
      printable.textContent = "Printable PDF";

      const removeBtn = document.createElement("button");
      removeBtn.type = "button";
      removeBtn.className = "btn ghost tag-remove";
      removeBtn.textContent = "Remove";
      removeBtn.disabled = isLocked();
      removeBtn.title = "Remove this marker";
      removeBtn.addEventListener("click", () => {
        if (isLocked()) return;
        editor.mounts = editor.mounts.filter((_, i) => i !== index);
        render({ focusAfterRemoval: index });
        changed();
      });
      footer.append(printable, removeBtn);

      body.append(picker, grid, footer);
      card.append(summary, body);
      tagList.append(card);
      syncMarker();
      if (index === openMarkerIndex && focusType) typeSelect.focus();
    });
    if (focusAfterRemoval !== undefined) {
      const index = Math.min(focusAfterRemoval, tagList.children.length - 1);
      (tagList.children[index]?.querySelector("summary") ?? addTagBtn).focus();
    }
  }

  function appendMarker(markerId) {
    const mount = cloneMount(editor.mounts[0] || defaultMount);
    editor.mounts = [...editor.mounts, { ...mount, marker_id: markerId }];
    render();
    changed();
  }

  restoreTagsBtn.addEventListener("click", () => {
    if (isLocked()) return;
    const robot = editor.robotProfiles.find(profile => profile.id === editor.robotProfileId)?.robot;
    editor.mounts = (presetsByRobot[robot] || [defaultMount]).map(cloneMount);
    render();
    changed();
  });

  const addUploadInput = makeFileInput(async (file, current) => {
    const markerId = await decodeUploadedPng(file);
    if (!current()) return;
    if (usedMarkerIds().has(markerId)) {
      report(`Fiducial marker ID ${markerId} is already in the list`);
      return;
    }
    appendMarker(markerId);
  });
  addTagBtn.after(addUploadInput);

  addTagBtn.addEventListener("click", () => {
    if (isLocked()) return;
    const used = usedMarkerIds();
    const next = presetMarkerIds.find(id => !used.has(id));
    if (next == null) {
      report("All pre-built markers are in use. Upload a PNG to add another.");
      addUploadInput.click();
      return;
    }
    appendMarker(next);
  });

  return {
    configure(defaults) {
      if (defaults.mounts?.[0]) defaultMount = cloneMount(defaults.mounts[0]);
      if (Array.isArray(defaults.preset_marker_ids)) presetMarkerIds = [...defaults.preset_marker_ids];
      presetsByRobot = defaults.mounts_by_robot || {};
    },
    load(mounts) {
      editor.mounts = (Array.isArray(mounts) ? mounts : [defaultMount]).map(cloneMount);
      tagList.replaceChildren();
    },
    setLocked(locked) {
      addTagBtn.disabled = restoreTagsBtn.disabled = addUploadInput.disabled = locked;
      tagList.querySelectorAll("input, button, select").forEach(control => { control.disabled = locked; });
    },
    render,
  };
}
