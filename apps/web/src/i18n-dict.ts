/**
 * Translation data for the operator UI, kept free of JSX so it can be imported
 * by tests and by the components alike.
 *
 * The dictionary is keyed by the English sentence: adding a string to a
 * component cannot silently produce an empty label, because a missing
 * translation falls back to the English text.
 */

export const LOCALES = ["id", "en"] as const;
export type Locale = (typeof LOCALES)[number];

export const LOCALE_STORAGE_KEY = "corpix.locale";

/** English → Indonesian. Keys are the exact strings used in components. */
const ID: Record<string, string> = {
  // ---- navigation / shell -----------------------------------------------
  Office: "Kantor",
  Minds: "Pikiran",
  Settings: "Pengaturan",
  "Admin token": "Token admin",
  optional: "opsional",
  "Required only when ADMIN_TOKEN is set on the server":
    "Hanya perlu kalau ADMIN_TOKEN di-set di server",
  "This server requires an admin token.": "Server ini mewajibkan token admin.",
  "Paste the token from": "Tempel token dari",
  "into the": "ke kolom",
  "field above, then press Enter.": "di atas, lalu tekan Enter.",
  "Focus field": "Fokus ke kolom",

  // ---- office ------------------------------------------------------------
  idle: "menganggur",
  "Dispatch a goal": "Kirim tujuan",
  "spent": "terpakai",
  "cached": "dari cache",
  "Select a project…": "Pilih proyek…",
  "Build a todo app with email login": "Buat aplikasi todo dengan login email",
  Dispatch: "Kirim",
  Cancel: "Batal",
  "Register your first project": "Daftarkan proyek pertama",
  Name: "Nama",
  "/absolute/path/to/repo": "/path/absolut/ke/repo",
  Register: "Daftar",
  Approvals: "Persetujuan",
  "wants to run": "ingin menjalankan",
  Approve: "Setujui",
  Deny: "Tolak",
  "Activity log": "Log aktivitas",
  "No events yet.": "Belum ada event.",
  "Past runs": "Run sebelumnya",
  Resume: "Lanjutkan",
  "Continue this run where it stopped": "Lanjutkan run ini dari titik berhentinya",
  "No runs yet.": "Belum ada run.",
  "This run paused on its budget. New budget in USD:":
    "Run ini berhenti karena budget. Budget baru dalam USD:",
  "Budget must be a positive number.": "Budget harus angka positif.",
  "Waiting for the first task…": "Menunggu task pertama…",

  // ---- minds -------------------------------------------------------------
  "Every agent runs on its own model turn: it decides what to do, what it thinks, and how it feels. Nothing here is scripted by Corpix. Talk to one and it answers in character.":
    "Setiap agen punya giliran model sendiri: dia yang memutuskan mau apa, apa yang dipikirkan, dan bagaimana perasaannya. Tidak ada yang ditulis tangan oleh Corpix. Ajak bicara, dia menjawab sesuai karakternya.",
  "Own session": "Sesi sendiri",
  "No work session yet.": "Belum ada sesi kerja.",
  "Remembers": "Ingatan",
  "Thinks of the others": "Penilaian tentang yang lain",
  "Nothing yet.": "Belum ada.",
  "No opinions formed yet.": "Belum punya penilaian.",
  "Details": "Detail",
  "Hide details": "Sembunyikan detail",
  "Talk": "Ajak bicara",
  "Send": "Kirim",
  "not thinking yet": "belum berpikir",

  // ---- settings: header / status ----------------------------------------
  "Test connection": "Tes koneksi",
  "Save": "Simpan",
  "Saving…": "Menyimpan…",
  "Settings saved. New runs use them immediately.":
    "Pengaturan disimpan. Run berikutnya langsung memakai ini.",
  "Admin token required.": "Token admin diperlukan.",
  "This server was started with": "Server ini dijalankan dengan",
  ", so every API call needs it. Read the token and paste it into the":
    ", jadi setiap panggilan API memerlukannya. Ambil token lalu tempel ke",
  "Read the token and paste it into the": "Ambil token lalu tempel ke",
  "Or open the page once with": "Atau buka halaman sekali dengan",
  "and it will be remembered in this browser.": "dan token akan diingat di browser ini.",
  "Loading settings…": "Memuat pengaturan…",

  // ---- settings: provider ------------------------------------------------
  Provider: "Provider",
  "Mock (free, scripted)": "Mock (gratis, skrip)",
  "OpenAI-compatible": "OpenAI-compatible",
  "Base URL": "Base URL",
  "Max tokens parameter": "Parameter token maksimum",
  "Request timeout (ms)": "Timeout request (ms)",
  "Forced tool format": "Format tool yang dipaksa",
  "auto (detect, recommended)": "auto (deteksi, disarankan)",
  "object — OpenAI standard": "object — standar OpenAI",
  "name string — some gateways": "string nama — sebagian gateway",
  "required": "required",
  "none — rely on the prompt": "none — andalkan prompt",
  "Prompt caching": "Cache prompt",
  "auto — provider decides (recommended)": "auto — provider yang menentukan (disarankan)",
  "explicit cache_control hints": "hint cache_control eksplisit",
  "off": "mati",
  "API key": "Kunci API",
  "not set": "belum di-set",
  "Replace stored key": "Ganti kunci tersimpan",
  "Save key": "Simpan kunci",
  "Clear": "Hapus",
  "The key is stored in data/secrets.json with mode 600, never in SQLite, and never sent back to the browser.":
    "Kunci disimpan di data/secrets.json dengan mode 600, tidak pernah di SQLite, dan tidak pernah dikirim balik ke browser.",

  // ---- settings: models --------------------------------------------------
  Models: "Model",
  "Boss model": "Model Boss",
  "Worker model": "Model worker",
  "Cheap model": "Model murah",
  "Leave empty to inherit the tier model and the role's YAML defaults.":
    "Biarkan kosong untuk memakai model tier dan default YAML role.",

  // ---- settings: mind ----------------------------------------------------
  Mind: "Pikiran",
  "Let agents think for themselves": "Biarkan agen berpikir sendiri",
  "on — each agent runs its own model turn": "aktif — tiap agen punya giliran model sendiri",
  "off — agents sit still, no model calls, no cost": "mati — agen diam, tanpa panggilan model, tanpa biaya",
  "Seconds between decisions": "Detik antar keputusan",
  "Agents thinking at once": "Agen berpikir bersamaan",
  "Max output tokens per thought": "Token output maksimum per pikiran",
  Temperature: "Temperatur",
  "Turns per conversation": "Giliran per percakapan",
  "Memories per agent": "Ingatan per agen",
  "Mind model": "Model pikiran",
  "Agent language": "Bahasa agen",
  "auto — follow the office": "auto — ikut kantor",
  "Each agent gets its own turn with the real goal, its colleagues, its mood and its memories, and decides what to do. Thoughts, moods and opinions are never generated by Corpix — only stored and rendered. Leave the model empty to use the cheap model.":
    "Setiap agen mendapat giliran sendiri dengan tujuan nyata, rekan-rekannya, mood dan ingatannya, lalu memutuskan mau apa. Pikiran, mood dan opini tidak pernah dibuat oleh Corpix — hanya disimpan dan ditampilkan. Biarkan model kosong untuk memakai model murah.",

  // ---- settings: team ----------------------------------------------------
  Team: "Tim",
  "Company name": "Nama perusahaan",
  "Agent names are editable per role in the table below and apply to the office, prompts and the event log. Clear a field to fall back to the name in":
    "Nama agen bisa diubah per role di tabel bawah dan berlaku untuk kantor, prompt, dan log event. Kosongkan kolom untuk kembali ke nama di",
  "Per-agent overrides": "Override per agen",
  Agent: "Agen",
  Model: "Model",
  "Max steps": "Langkah maksimum",
  "Context tokens": "Token konteks",
  Effective: "Efektif",

  // ---- settings: limits --------------------------------------------------
  Limits: "Batas",
  "Max concurrent agents": "Agen bersamaan maksimum",
  "(1–32)": "(1–32)",
  "Max steps per task": "Langkah maksimum per task",
  "(per agent loop)": "(per loop agen)",
  "Context tokens per agent": "Token konteks per agen",
  "(each agent gets its own)": "(tiap agen punya sendiri)",
  "Task timeout (minutes)": "Timeout task (menit)",
  "(wall clock)": "(waktu nyata)",
  "Tool output cap (chars)": "Batas output tool (karakter)",
  "(truncation)": "(dipotong)",
  "Max output tokens": "Token output maksimum",
  "(per model call)": "(per panggilan model)",
  "QA review rounds": "Putaran review QA",
  "(0 disables review)": "(0 mematikan review)",
  "Budget per goal (USD)": "Budget per tujuan (USD)",
  "(0 = unlimited)": "(0 = tanpa batas)",
  "When the budget is hit": "Saat budget habis",
  "Pause the run": "Jeda run",
  "Stop the run": "Hentikan run",

  // ---- settings: git -----------------------------------------------------
  "Git isolation": "Isolasi git",
  "One worktree and branch per task": "Satu worktree dan branch per task",
  "Integration branch": "Branch integrasi",
  "Worktrees directory (optional, absolute)": "Direktori worktree (opsional, absolut)",
  "Each task gets its own branch cut from the integration branch. Results are merged automatically; conflicts are escalated, never guessed. Agents never push.":
    "Setiap task dapat branch sendiri dari branch integrasi. Hasilnya di-merge otomatis; konflik dieskalasi, tidak pernah ditebak. Agen tidak pernah push.",

  // ---- settings: safety --------------------------------------------------
  Safety: "Keamanan",
  "Approval mode": "Mode persetujuan",
  "ask — approve every command": "ask — setujui setiap perintah",
  "auto-safe — allowlisted tests and builds": "auto-safe — tes dan build yang diizinkan",
  "auto — approve everything except hard denials": "auto — setujui semua kecuali yang dilarang keras",
  Sandbox: "Sandbox (isolasi perintah)",
  "bubblewrap — no daemon needed (recommended)": "bubblewrap — tanpa daemon (disarankan)",
  "docker — server version 29.9.2": "docker — versi server 29.9.2",
  "(nothing else is installed)": "(tidak ada yang lain terpasang)",

  // ---- settings: pricing -------------------------------------------------
  "Pricing (USD per million tokens)": "Harga (USD per juta token)",
  "Required for the budget guard and cost meter. Use 0 for local models.":
    "Dibutuhkan untuk penjaga budget dan pengukur biaya. Pakai 0 untuk model lokal.",
  Input: "Input",
  Output: "Output",
  "Cached input": "Input cache",
  "Add worker model price": "Tambah harga model worker",
  "Last saved:": "Terakhir disimpan:",
  "Budget default": "Budget default",

  // ---- extra strings -----------------------------------------------------
  "API key stored outside the database.": "Kunci API disimpan di luar database.",
  "API key cleared.": "Kunci API dihapus.",
  "Pinned by environment variables:": "Dikunci oleh environment variable:",
  "Probe:": "Probe:",
  ok: "ok",
  failed: "gagal",
  never: "belum pernah",
  "doing": "sedang",
  "Say something to {name}…": "Bicara ke {name}…",
  "{tasks} task(s) · {input} in / {output} out tokens on this agent":
    "{tasks} task · {input} masuk / {output} keluar token di agen ini",
  "{count} talks": "{count} obrolan",
  "Language": "Bahasa",
  "BOSS OFFICE": "RUANG BOSS",
  "DEV BULLPEN": "RUANG DEV",
  "MEETING ROOM": "RUANG RAPAT",
  "SERVER ROOM": "RUANG SERVER",
  "BREAK ROOM": "RUANG ISTIRAHAT",
  "Dispatch a goal to wake the office": "Kirim tujuan untuk membangunkan kantor",
  "The office is a renderer for the event stream. Hover an agent to read its name; every animation is backed by a real event.":
    "Kantor ini hanya merender aliran event. Arahkan kursor ke agen untuk membaca namanya; setiap animasi berasal dari event nyata.",
  "{count} events": "{count} event",
  available: "tersedia",
  unavailable: "tidak tersedia",
  "none — policy and jail only": "none — hanya policy dan jail",
  "docker — container per command": "docker — container per perintah",
  "1–32": "1–32",
  "per agent loop": "per loop agen",
  "each agent gets its own": "tiap agen punya sendiri",
  "wall clock": "waktu nyata",
  "truncation": "dipotong",
  "per model call": "per panggilan model",
  "0 disables review": "0 mematikan review",
  "0 = unlimited": "0 = tanpa batas",
};

const EN: Record<string, string> = {};

export const DICTIONARIES: Record<Locale, Record<string, string>> = { id: ID, en: EN };

export function detectLocale(): Locale {
  try {
    const stored = localStorage.getItem(LOCALE_STORAGE_KEY);
    if (stored === "id" || stored === "en") return stored;
  } catch {
    // Private mode: fall through to the browser language.
  }
  const languages = typeof navigator === "undefined" ? [] : navigator.languages ?? [navigator.language];
  return languages.some((language) => language.toLowerCase().startsWith("id")) ? "id" : "en";
}

/** Translate one English sentence, with optional `{name}` interpolation. */
export function translate(
  locale: Locale,
  text: string,
  vars?: Record<string, string | number>,
): string {
  const template = DICTIONARIES[locale][text] ?? text;
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (match, key: string) => {
    const value = vars[key];
    return value === undefined ? match : String(value);
  });
}
