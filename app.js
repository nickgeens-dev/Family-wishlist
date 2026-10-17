// ============================================================================
//  FAMILY WISHLIST
//
//  Two storage modes, chosen automatically:
//   1. Firebase configured  -> everyone shares one live list (no accounts needed)
//   2. Firebase NOT set up  -> list is kept in this browser only (localStorage)
//
//  To share between family members, fill in firebase-config.js (see README.md).
// ============================================================================

// Your Firebase settings live in firebase-config.js. If that file is missing or
// still has the YOUR_ placeholders, the site starts in preview mode instead of breaking.
let firebaseConfig = null;
try {
  ({ firebaseConfig } = await import("./firebase-config.js"));
} catch (e) {
  /* no config file yet */
}

const FIREBASE_SDK = "https://www.gstatic.com/firebasejs/10.12.2/";
const firebaseIsConfigured =
  !!firebaseConfig &&
  typeof firebaseConfig.projectId === "string" &&
  !firebaseConfig.projectId.startsWith("YOUR_");

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
const $ = (id) => document.getElementById(id);

const LS = {
  get(key) {
    try {
      return localStorage.getItem(key) || "";
    } catch (e) {
      return "";
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch (e) {
      /* ignore */
    }
  },
};

function randomId() {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(36).padStart(2, "0")).join("");
}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// The list id lives in the URL after the #. Anyone with the full link can open
// the list, so it is long and random. It is also remembered on this device.
function getListId() {
  let id = location.hash.replace(/^#/, "").trim();
  if (!/^[A-Za-z0-9_-]{12,}$/.test(id)) id = LS.get("wl_list") || randomId();
  LS.set("wl_list", id);
  history.replaceState(
    null,
    "",
    location.pathname + location.search + "#" + id,
  );
  return id;
}

// ---------------------------------------------------------------------------
// Storage adapters: both expose subscribe / add / update / remove
// ---------------------------------------------------------------------------
function localAdapter(listId) {
  const key = "wishlist:" + listId;
  let listener = () => {};
  const read = () => {
    try {
      return JSON.parse(localStorage.getItem(key)) || [];
    } catch (e) {
      return [];
    }
  };
  // Returns false when the browser storage is full (photos take space)
  const write = (items) => {
    try {
      localStorage.setItem(key, JSON.stringify(items));
    } catch (e) {
      return false;
    }
    listener(items);
    return true;
  };
  const save = (items) => {
    if (!write(items)) throw new Error("storage full");
  };

  window.addEventListener("storage", (e) => {
    if (e.key === key) listener(read());
  });

  return {
    shared: false,
    subscribe(fn) {
      listener = fn;
      fn(read());
    },
    async add(data) {
      const items = read();
      items.push({ id: uid(), ...data });
      save(items);
    },
    async update(id, patch) {
      save(read().map((it) => (it.id === id ? { ...it, ...patch } : it)));
    },
    async remove(id) {
      save(read().filter((it) => it.id !== id));
    },
  };
}

async function firebaseAdapter(listId) {
  const [{ initializeApp }, fs] = await Promise.all([
    import(FIREBASE_SDK + "firebase-app.js"),
    import(FIREBASE_SDK + "firebase-firestore.js"),
  ]);
  const db = fs.getFirestore(initializeApp(firebaseConfig));
  const col = fs.collection(db, "lists", listId, "items");

  return {
    shared: true,
    subscribe(fn, onError) {
      fs.onSnapshot(
        col,
        (snap) => fn(snap.docs.map((d) => ({ id: d.id, ...d.data() }))),
        onError,
      );
    },
    // Firestore only confirms a write once the server has it. If the phone is
    // offline that can take a long time, so stop waiting after 4 seconds (the
    // wish still shows up and is sent as soon as the connection is back).
    // Rejected writes, for example by the security rules, still report an error.
    add: (data) =>
      Promise.race([
        fs.addDoc(col, data),
        new Promise((resolve) => setTimeout(resolve, 4000)),
      ]),
    update: (id, patch) =>
      Promise.race([
        fs.updateDoc(fs.doc(col, id), patch),
        new Promise((resolve) => setTimeout(resolve, 4000)),
      ]),
    remove: (id) => fs.deleteDoc(fs.doc(col, id)),
  };
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const OCCASIONS = { sint: "Sinterklaas", xmas: "Kerstmis", both: "Allebei" };
let store = null;
let items = [];
let filter = "all";
let pendingDelete = null;
let me = LS.get("wl_me");
let pendingImage = ""; // photo chosen in the form, as a small JPEG data URL
let editing = null; // draft of the wish that is being edited: { id, who, occ, what, link, note, image }
let savingEdit = false;
let editError = ""; // message shown inside the edit form (the top banner can be out of view)
const MAX_IMAGE_CHARS = 150000; // keeps one wish well below Firestore's 1 MiB limit

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
function showNotice(text) {
  const box = $("notice");
  box.textContent = text;
  box.hidden = !text;
}

function daysUntil(month, day) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  let target = new Date(today.getFullYear(), month, day);
  if (target < today) target = new Date(today.getFullYear() + 1, month, day);
  return Math.round((target - today) / 86400000);
}

function renderCountdowns() {
  const box = $("countdowns");
  box.textContent = "";
  [
    ["Sinterklaas", 11, 6],
    ["Kerstmis", 11, 25],
  ].forEach(([name, month, day]) => {
    const n = daysUntil(month, day);
    const chip = document.createElement("span");
    chip.className = "chip";
    const num = document.createElement("b");
    num.className = "num";
    num.textContent = n === 0 ? "🎉" : n;
    const unit = document.createElement("span");
    unit.className = "unit";
    unit.textContent =
      n === 0
        ? name + " is vandaag!"
        : (n === 1 ? "dag" : "dagen") + " tot " + name;
    chip.append(num, unit);
    box.appendChild(chip);
  });
}

function inFilter(item) {
  return filter === "all" || item.occ === filter || item.occ === "both";
}

function renderTabs() {
  const nav = $("tabs");
  nav.textContent = "";
  [
    ["all", "Alles"],
    ["sint", "Sinterklaas"],
    ["xmas", "Kerstmis"],
  ].forEach(([key, label]) => {
    const count = items.filter(
      (it) => key === "all" || it.occ === key || it.occ === "both",
    ).length;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "tab";
    btn.setAttribute("aria-pressed", String(filter === key));
    const small = document.createElement("small");
    small.textContent = count;
    btn.append(label, small);
    btn.addEventListener("click", () => {
      filter = key;
      render();
    });
    nav.appendChild(btn);
  });
}

function renderProgress(visible) {
  const box = $("progress");
  box.textContent = "";
  if (!visible.length) return;
  const done = visible.filter((it) => it.bought).length;
  const bar = document.createElement("div");
  bar.className = "bar";
  const fill = document.createElement("i");
  fill.style.width = Math.round((done / visible.length) * 100) + "%";
  bar.appendChild(fill);
  const text = document.createElement("p");
  text.className = "ptxt";
  text.textContent =
    `${done} van ${visible.length} gekocht` +
    (done === visible.length ? ". Alles gekocht!" : "");
  box.append(bar, text);
}

// Turns http(s) links inside a note into clickable links (safely, no innerHTML)
function appendLinkified(text, parent) {
  const pattern = /(https?:\/\/[^\s]+)/g;
  let last = 0,
    match;
  while ((match = pattern.exec(text))) {
    if (match.index > last) parent.append(text.slice(last, match.index));
    const a = document.createElement("a");
    a.href = match[1];
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    const short = match[1].replace(/^https?:\/\/(www\.)?/, "");
    a.textContent = short.length > 40 ? short.slice(0, 40) + "…" : short;
    parent.appendChild(a);
    last = match.index + match[1].length;
  }
  if (last < text.length) parent.append(text.slice(last));
}

// Only http(s) links are allowed (blocks javascript: and similar)
function normalizeLink(input) {
  let text = (input || "").trim();
  if (!text) return "";
  if (!/^[a-z][a-z0-9+.-]*:/i.test(text)) text = "https://" + text;
  try {
    const url = new URL(text);
    if (
      (url.protocol !== "https:" && url.protocol !== "http:") ||
      !url.hostname.includes(".")
    )
      return null;
    return url.href;
  } catch (e) {
    return null;
  }
}

function safeLink(value) {
  const href = normalizeLink(value);
  return href || "";
}

// Shrinks a chosen photo to a small JPEG so it fits in the database
function resizeImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      for (const [max, quality] of [
        [480, 0.72],
        [360, 0.6],
        [260, 0.5],
      ]) {
        const scale = Math.min(
          1,
          max / Math.max(img.naturalWidth, img.naturalHeight),
        );
        const w = Math.max(1, Math.round(img.naturalWidth * scale));
        const h = Math.max(1, Math.round(img.naturalHeight * scale));
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        ctx.fillStyle = "#fff"; // transparent PNGs get a white background
        ctx.fillRect(0, 0, w, h);
        ctx.drawImage(img, 0, 0, w, h);
        const data = canvas.toDataURL("image/jpeg", quality);
        if (data.length <= MAX_IMAGE_CHARS) return resolve(data);
      }
      reject(new Error("too big"));
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("unreadable"));
    };
    img.src = url;
  });
}

function renderPhotoPreview() {
  const box = $("photoPreview");
  box.textContent = "";
  if (!pendingImage) return;
  const img = document.createElement("img");
  img.src = pendingImage;
  img.alt = "Gekozen foto";
  const remove = document.createElement("button");
  remove.type = "button";
  remove.textContent = "Foto verwijderen";
  remove.addEventListener("click", () => {
    pendingImage = "";
    renderPhotoPreview();
  });
  box.append(img, remove);
}

function openLightbox(src) {
  const overlay = document.createElement("div");
  overlay.className = "lightbox";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-label", "Foto");
  const img = document.createElement("img");
  img.src = src;
  img.alt = "";
  overlay.appendChild(img);
  const close = () => {
    overlay.remove();
    document.removeEventListener("keydown", onKey);
  };
  const onKey = (e) => {
    if (e.key === "Escape") close();
  };
  overlay.addEventListener("click", close);
  document.addEventListener("keydown", onKey);
  document.body.appendChild(overlay);
}

function buildItem(item) {
  if (editing && editing.id === item.id) return buildEditor();
  const row = document.createElement("div");
  row.className = "item" + (item.bought ? " done" : "");

  const tick = document.createElement("button");
  tick.type = "button";
  tick.className = "tick";
  tick.textContent = item.bought ? "✓" : "";
  tick.setAttribute(
    "aria-label",
    item.bought ? "Markeer als niet gekocht" : "Markeer als gekocht",
  );
  tick.addEventListener("click", () => toggleBought(item));

  const body = document.createElement("div");
  body.className = "body";
  const what = document.createElement("div");
  what.className = "what";
  what.textContent = item.what;
  const meta = document.createElement("div");
  meta.className = "meta";
  const tag = document.createElement("span");
  tag.className = "tag " + (OCCASIONS[item.occ] ? item.occ : "both");
  tag.textContent = OCCASIONS[item.occ] || "Allebei";
  meta.appendChild(tag);
  if (item.bought && item.boughtBy) {
    const by = document.createElement("span");
    by.textContent = "gekocht door " + item.boughtBy;
    meta.appendChild(by);
  }
  body.append(what, meta);
  if (item.note) {
    const note = document.createElement("div");
    note.className = "note";
    appendLinkified(item.note, note);
    body.appendChild(note);
  }
  const href = safeLink(item.link);
  if (href) {
    const a = document.createElement("a");
    a.className = "linkbtn";
    a.href = href;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.textContent = "🔗 " + new URL(href).hostname.replace(/^www\./, "");
    body.appendChild(a);
  }

  let thumb = null;
  if (
    typeof item.image === "string" &&
    item.image.startsWith("data:image/jpeg;base64,")
  ) {
    thumb = document.createElement("button");
    thumb.type = "button";
    thumb.className = "thumb";
    thumb.setAttribute("aria-label", "Foto vergroten");
    const img = document.createElement("img");
    img.src = item.image;
    img.alt = "";
    thumb.appendChild(img);
    thumb.addEventListener("click", () => openLightbox(item.image));
  }

  const del = document.createElement("button");
  del.type = "button";
  const armed = pendingDelete === item.id;
  del.className = "del" + (armed ? " sure" : "");
  del.textContent = armed ? "Verwijderen?" : "✕";
  del.setAttribute("aria-label", "Wens verwijderen");
  del.addEventListener("click", () => {
    if (pendingDelete === item.id) {
      pendingDelete = null;
      removeItem(item);
    } else {
      pendingDelete = item.id;
      render();
      setTimeout(() => {
        if (pendingDelete === item.id) {
          pendingDelete = null;
          render();
        }
      }, 3000);
    }
  });

  const edit = document.createElement("button");
  edit.type = "button";
  edit.className = "edit";
  edit.textContent = "✎";
  edit.setAttribute("aria-label", "Wens bewerken");
  edit.addEventListener("click", () => startEdit(item));

  const actions = document.createElement("div");
  actions.className = "actions";
  actions.append(edit, del);

  row.append(tick, body, ...(thumb ? [thumb] : []), actions);
  return row;
}

function render() {
  renderTabs();
  const visible = items.filter(inFilter);
  renderProgress(visible);

  const list = $("list");
  list.textContent = "";
  if (!visible.length) {
    const p = document.createElement("p");
    p.className = "empty";
    p.textContent = items.length
      ? "Hier staat nog niets voor deze gelegenheid."
      : "Nog geen wensen. Voeg hierboven de eerste toe.";
    list.appendChild(p);
    return;
  }

  // Group by person (case-insensitive), people sorted A to Z
  const groups = new Map();
  visible.forEach((it) => {
    const name = (it.who || "Iemand").trim();
    const key = name.toLowerCase();
    if (!groups.has(key)) groups.set(key, { name, items: [] });
    groups.get(key).items.push(it);
  });

  [...groups.values()]
    .sort((a, b) => a.name.localeCompare(b.name))
    .forEach((group) => {
      group.items.sort(
        (a, b) =>
          Number(a.bought) - Number(b.bought) ||
          (a.createdAt || 0) - (b.createdAt || 0),
      );
      const section = document.createElement("section");
      section.className = "person";
      const h3 = document.createElement("h3");
      const done = group.items.filter((it) => it.bought).length;
      const small = document.createElement("small");
      small.textContent = `${done}/${group.items.length} gekocht`;
      h3.append(group.name, small);
      section.appendChild(h3);
      group.items.forEach((it) => section.appendChild(buildItem(it)));
      list.appendChild(section);
    });
}

// ---------------------------------------------------------------------------
// Editing a wish
// ---------------------------------------------------------------------------
function showEditError(text, focusId) {
  editError = text;
  render();
  const el = $(focusId);
  if (el) el.focus();
}

function startEdit(item) {
  if (editing && editing.id !== item.id) {
    showEditError(
      "Sla eerst de wens op die je aan het bewerken bent, of annuleer.",
      "edit-what",
    );
    return;
  }
  pendingDelete = null;
  editError = "";
  editing = {
    id: item.id,
    who: item.who || "",
    occ: OCCASIONS[item.occ] ? item.occ : "both",
    what: item.what || "",
    link: item.link || "",
    note: item.note || "",
    image:
      typeof item.image === "string" &&
      item.image.startsWith("data:image/jpeg;base64,")
        ? item.image
        : "",
  };
  render();
  const first = $("edit-what");
  if (first) first.focus();
}

function cancelEdit() {
  editing = null;
  editError = "";
  showNotice(storageNotice());
  render();
}

function labeled(id, text, input) {
  const wrap = document.createElement("div");
  wrap.className = "field";
  const label = document.createElement("label");
  label.className = "lbl";
  label.htmlFor = id;
  label.textContent = text;
  input.id = id;
  wrap.append(label, input);
  return wrap;
}

function editInput(key, max) {
  const input = document.createElement("input");
  input.type = "text";
  input.maxLength = max;
  input.autocomplete = "off";
  input.value = editing[key];
  input.addEventListener("input", () => {
    editing[key] = input.value;
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") saveEdit();
    else if (e.key === "Escape") cancelEdit();
  });
  return input;
}

function buildEditor() {
  const box = document.createElement("div");
  box.className = "item editing";
  const form = document.createElement("div");
  form.className = "editform";

  const title = document.createElement("h4");
  title.textContent = "Wens bewerken";
  form.appendChild(title);

  if (editError) {
    const problem = document.createElement("p");
    problem.className = "notice";
    problem.setAttribute("role", "alert");
    problem.textContent = editError;
    form.appendChild(problem);
  }

  const grid = document.createElement("div");
  grid.className = "grid2";
  const who = labeled("edit-who", "Voor wie is het?", editInput("who", 30));
  who.classList.remove("field");
  const select = document.createElement("select");
  [
    ["both", "Allebei"],
    ["sint", "Sinterklaas"],
    ["xmas", "Kerstmis"],
  ].forEach(([value, text]) => {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = text;
    select.appendChild(option);
  });
  select.value = editing.occ;
  select.addEventListener("change", () => {
    editing.occ = select.value;
  });
  const occ = labeled("edit-occ", "Gelegenheid", select);
  occ.classList.remove("field");
  grid.append(who, occ);
  form.appendChild(grid);

  form.appendChild(
    labeled(
      "edit-what",
      "Wat zou diegene graag krijgen?",
      editInput("what", 120),
    ),
  );
  form.appendChild(
    labeled(
      "edit-link",
      "Link naar het product (optioneel)",
      editInput("link", 500),
    ),
  );
  form.appendChild(
    labeled("edit-note", "Opmerking (optioneel)", editInput("note", 300)),
  );

  // photo: keep, replace or remove
  const photoField = document.createElement("div");
  photoField.className = "field";
  const photoLabel = document.createElement("span");
  photoLabel.className = "lbl";
  photoLabel.textContent = "Foto (optioneel)";
  const row = document.createElement("div");
  row.className = "photo-row";
  const file = document.createElement("input");
  file.type = "file";
  file.id = "edit-photo";
  file.className = "sr";
  file.accept = "image/*";
  file.addEventListener("change", async () => {
    const chosen = file.files && file.files[0];
    if (!chosen) return;
    const draft = editing;
    try {
      draft.image = await resizeImage(chosen);
      editError = "";
    } catch (err) {
      editError = "Die foto kon niet worden gelezen. Probeer een andere foto.";
    }
    if (editing === draft) render();
  });
  const pick = document.createElement("label");
  pick.className = "filebtn";
  pick.htmlFor = "edit-photo";
  pick.textContent = editing.image ? "📷 Andere foto kiezen" : "📷 Foto kiezen";
  const preview = document.createElement("div");
  preview.className = "photo-preview";
  if (editing.image) {
    const img = document.createElement("img");
    img.src = editing.image;
    img.alt = "Huidige foto";
    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "Foto verwijderen";
    remove.addEventListener("click", () => {
      editing.image = "";
      render();
    });
    preview.append(img, remove);
  }
  row.append(file, pick, preview);
  photoField.append(photoLabel, row);
  form.appendChild(photoField);

  const buttons = document.createElement("div");
  buttons.className = "editactions";
  const save = document.createElement("button");
  save.type = "button";
  save.className = "primary";
  save.textContent = "Opslaan";
  save.addEventListener("click", saveEdit);
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "secondary";
  cancel.textContent = "Annuleren";
  cancel.addEventListener("click", cancelEdit);
  buttons.append(save, cancel);
  form.appendChild(buttons);

  box.appendChild(form);
  return box;
}

function saveEdit() {
  const draft = editing;
  if (!draft || savingEdit) return;
  const what = draft.what.trim();
  if (!what) {
    showEditError("Vul in wat diegene graag wil krijgen.", "edit-what");
    return;
  }
  const link = normalizeLink(draft.link);
  if (link === null) {
    showEditError(
      "Die link lijkt niet te kloppen. Plak de volledige link van de winkelpagina, bv. https://www.bol.com/…",
      "edit-link",
    );
    return;
  }
  editError = "";
  savingEdit = true;
  store
    .update(draft.id, {
      what,
      who: draft.who.trim() || "Iemand",
      occ: draft.occ,
      note: draft.note.trim(),
      link,
      image: draft.image,
    })
    .then(() => {
      if (editing && editing.id === draft.id) editing = null;
      showNotice(storageNotice());
      render();
    })
    .catch(() => {
      if (editing && editing.id === draft.id) {
        showEditError(
          store && store.shared
            ? "De wijziging kon niet worden opgeslagen. Controleer je internetverbinding en de Firestore-regels."
            : "De wijziging kon niet worden opgeslagen. De opslagruimte van deze browser is vol: kies een kleinere foto.",
          "edit-what",
        );
      }
    })
    .finally(() => {
      savingEdit = false;
    });
}

// Re-draws the list after a change from someone else without losing the cursor in the edit form
function renderKeepingFocus() {
  const active = document.activeElement;
  const id =
    active && active.id && active.id.startsWith("edit-") ? active.id : null;
  const range =
    id && typeof active.selectionStart === "number"
      ? [active.selectionStart, active.selectionEnd]
      : null;
  render();
  if (!id) return;
  const el = $(id);
  if (!el) return;
  el.focus();
  if (range && el.setSelectionRange) el.setSelectionRange(range[0], range[1]);
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------
function toggleBought(item) {
  const next = !item.bought;
  store
    .update(item.id, { bought: next, boughtBy: next ? me : "" })
    .catch(() =>
      showNotice(
        "Die wijziging kon niet worden opgeslagen. Controleer je internetverbinding en probeer opnieuw.",
      ),
    );
}

function removeItem(item) {
  store
    .remove(item.id)
    .catch(() => showNotice("Die wens kon niet worden verwijderd."));
}

function addWish() {
  const what = $("what").value.trim();
  if (!what) {
    $("what").focus();
    return;
  }
  const link = normalizeLink($("link").value);
  if (link === null) {
    showNotice(
      "Die link lijkt niet te kloppen. Plak de volledige link van de winkelpagina, bv. https://www.bol.com/…",
    );
    $("link").focus();
    return;
  }
  const who = $("who").value.trim() || me || "Iemand";
  const occ = $("occ").value;
  LS.set("wl_who", who);
  LS.set("wl_occ", occ);

  $("add").disabled = true;
  store
    .add({
      what,
      who,
      occ,
      note: $("note").value.trim(),
      link,
      image: pendingImage,
      bought: false,
      boughtBy: "",
      createdAt: Date.now(),
    })
    .then(() => {
      $("what").value = "";
      $("note").value = "";
      $("link").value = "";
      pendingImage = "";
      renderPhotoPreview();
      $("what").focus();
      showNotice(storageNotice());
    })
    .catch(() =>
      showNotice(
        store && store.shared
          ? "Die wens kon niet worden toegevoegd. Controleer je internetverbinding en de Firestore-regels."
          : "Die wens kon niet worden opgeslagen. De opslagruimte van deze browser is vol: kies een kleinere foto of verwijder wensen.",
      ),
    )
    .finally(() => {
      $("add").disabled = false;
    });
}

function storageNotice() {
  return store && store.shared
    ? ""
    : "Voorbeeldmodus: deze lijst wordt alleen in deze browser bewaard. Stel Firebase in om hem met de familie te delen (zie README.md).";
}

async function copyShareLink() {
  const button = $("share");
  const original = button.textContent;
  try {
    await navigator.clipboard.writeText(location.href);
    button.textContent = "Link gekopieerd";
  } catch (e) {
    window.prompt("Kopieer deze link:", location.href);
  }
  setTimeout(() => {
    button.textContent = original;
  }, 2000);
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
async function start() {
  $("me").value = me;
  $("who").value = LS.get("wl_who") || me;
  if (LS.get("wl_occ")) $("occ").value = LS.get("wl_occ");

  $("me").addEventListener("input", (e) => {
    me = e.target.value.trim();
    LS.set("wl_me", me);
    if (!LS.get("wl_who")) $("who").value = me;
  });
  $("add").addEventListener("click", addWish);
  ["who", "what", "link", "note"].forEach((id) =>
    $(id).addEventListener("keydown", (e) => {
      if (e.key === "Enter") addWish();
    }),
  );
  $("share").addEventListener("click", copyShareLink);
  $("photo").addEventListener("change", async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = "";
    if (!file) return;
    try {
      pendingImage = await resizeImage(file);
      showNotice(storageNotice());
    } catch (err) {
      pendingImage = "";
      showNotice("Die foto kon niet worden gelezen. Probeer een andere foto.");
    }
    renderPhotoPreview();
  });

  renderCountdowns();
  renderTabs();

  const listId = getListId();
  try {
    store = firebaseIsConfigured
      ? await firebaseAdapter(listId)
      : localAdapter(listId);
  } catch (e) {
    console.error(e);
    store = localAdapter(listId);
    showNotice(
      "Firebase is niet bereikbaar, dus deze lijst wordt voorlopig alleen in deze browser bewaard.",
    );
  }

  if (!firebaseIsConfigured) showNotice(storageNotice());

  store.subscribe(
    (list) => {
      items = list;
      if (editing && !items.some((it) => it.id === editing.id)) {
        editing = null;
        editError = "";
        showNotice(
          "De wens die je aan het bewerken was, is intussen verwijderd.",
        );
      }
      renderKeepingFocus();
    },
    () =>
      showNotice(
        "De verbinding met de gedeelde lijst is verbroken. Laad de pagina opnieuw om opnieuw te verbinden.",
      ),
  );
}

start();
