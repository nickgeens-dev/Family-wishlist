// ============================================================================
//  FAMILY WISHLIST
//
//  Two storage modes, chosen automatically:
//   1. Firebase configured  -> everyone shares one live list (no accounts needed)
//   2. Firebase NOT set up  -> list is kept in this browser only (localStorage)
//
//  To share between family members, fill in firebaseConfig below (see README.md).
// ============================================================================

const firebaseConfig = {
  apiKey: "YOUR_API_KEY",
  authDomain: "YOUR_PROJECT_ID.firebaseapp.com",
  projectId: "YOUR_PROJECT_ID",
  appId: "YOUR_APP_ID",
};

const FIREBASE_SDK = "https://www.gstatic.com/firebasejs/10.12.2/";
const firebaseIsConfigured = !firebaseConfig.projectId.startsWith("YOUR_");

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
  const write = (items) => {
    try {
      localStorage.setItem(key, JSON.stringify(items));
    } catch (e) {
      /* ignore */
    }
    listener(items);
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
      write(items);
    },
    async update(id, patch) {
      write(read().map((it) => (it.id === id ? { ...it, ...patch } : it)));
    },
    async remove(id) {
      write(read().filter((it) => it.id !== id));
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
    update: (id, patch) => fs.updateDoc(fs.doc(col, id), patch),
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
    const strong = document.createElement("b");
    strong.textContent = n === 0 ? "vandaag" : n === 1 ? "1 dag" : n + " dagen";
    chip.append(name + ": ", strong);
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

function buildItem(item) {
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

  row.append(tick, body, del);
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
      bought: false,
      boughtBy: "",
      createdAt: Date.now(),
    })
    .then(() => {
      $("what").value = "";
      $("note").value = "";
      $("what").focus();
      showNotice(storageNotice());
    })
    .catch(() =>
      showNotice(
        "Die wens kon niet worden toegevoegd. Controleer je internetverbinding en de Firestore-regels.",
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
  ["who", "what", "note"].forEach((id) =>
    $(id).addEventListener("keydown", (e) => {
      if (e.key === "Enter") addWish();
    }),
  );
  $("share").addEventListener("click", copyShareLink);

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
      render();
    },
    () =>
      showNotice(
        "De verbinding met de gedeelde lijst is verbroken. Laad de pagina opnieuw om opnieuw te verbinden.",
      ),
  );
}

start();
