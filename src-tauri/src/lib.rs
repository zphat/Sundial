//! Sundial desktop shell. The UI lives in ../ui; this file is the thin native layer:
//! file storage with daily backups, tray icon, close-to-tray, system-wide hotkeys,
//! native notifications, start at sign-in, secrets in the OS credential store,
//! and the bring-your-own-key AI parser.
//!
//! Linux differs where the desktop makes it: no corner toast window (Wayland has no absolute positioning, so the
//! same words go out as desktop notifications), no X11 key grabs under Wayland, a close button that quits where no
//! tray host exists, a file fallback when no Secret Service runs, and an updater that only replaces an AppImage.
//! `platform_info` tells the UI which of these apply. Everything OS-specific is behind cfg; Windows is unchanged.

use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    fs,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicU8, Ordering},
        Mutex,
    },
};
use tauri_plugin_updater::UpdaterExt;
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, WindowEvent,
};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt as _};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_deep_link::DeepLinkExt;

const SERVICE: &str = "Sundial";
const DB_FILE: &str = "sundial.json";
const BACKUPS_TO_KEEP: usize = 30;

// ---------- storage ----------

fn data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        // ~/.local/share/app.sundial.desktop holds notes and the sign-in token; create_dir_all leaves it 0755 under the
        // usual umask, readable by every account on a shared machine. Windows relies on %APPDATA%'s ACLs for this.
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&dir, fs::Permissions::from_mode(0o700));
    }
    Ok(dir)
}

/// Civil date (UTC) from the system clock, without pulling in a date crate. Only used to name backups.
fn today_utc() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let z = secs.div_euclid(86400) + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + if m <= 2 { 1 } else { 0 };
    format!("{y:04}-{m:02}-{d:02}")
}

#[tauri::command]
fn load_db(app: AppHandle) -> Result<Option<String>, String> {
    let p = data_dir(&app)?.join(DB_FILE);
    if !p.exists() {
        return Ok(None);
    }
    fs::read_to_string(&p).map(Some).map_err(|e| e.to_string())
}

/// Atomic write (temp file + rename), then one backup per day, oldest pruned.
#[tauri::command]
fn save_db(app: AppHandle, json: String) -> Result<(), String> {
    let dir = data_dir(&app)?;
    let target = dir.join(DB_FILE);
    let tmp = dir.join(format!("{DB_FILE}.tmp"));
    fs::write(&tmp, json.as_bytes()).map_err(|e| e.to_string())?;
    fs::rename(&tmp, &target).map_err(|e| e.to_string())?;

    let backups = dir.join("backups");
    if fs::create_dir_all(&backups).is_ok() {
        let b = backups.join(format!("sundial-{}.json", today_utc()));
        if !b.exists() {
            let _ = fs::copy(&target, &b);
        }
        if let Ok(rd) = fs::read_dir(&backups) {
            let mut files: Vec<PathBuf> = rd
                .flatten()
                .map(|e| e.path())
                .filter(|p| p.extension().map(|x| x == "json").unwrap_or(false))
                .collect();
            files.sort();
            while files.len() > BACKUPS_TO_KEEP {
                let old = files.remove(0);
                let _ = fs::remove_file(old);
            }
        }
    }
    Ok(())
}

#[tauri::command]
fn data_path(app: AppHandle) -> Result<String, String> {
    Ok(data_dir(&app)?.join(DB_FILE).to_string_lossy().to_string())
}

#[tauri::command]
fn reveal_data(app: AppHandle) -> Result<(), String> {
    let dir = data_dir(&app)?;
    app.opener()
        .open_path(dir.to_string_lossy().to_string(), None::<&str>)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn open_url(app: AppHandle, url: String) -> Result<(), String> {
    app.opener().open_url(url, None::<&str>).map_err(|e| e.to_string())
}

// ---------- notifications / autostart ----------

#[tauri::command]
fn notify(app: AppHandle, title: String, body: String) -> Result<(), String> {
    app.notification()
        .builder()
        .title(title)
        .body(body)
        .show()
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn autostart_get(app: AppHandle) -> Result<bool, String> {
    app.autolaunch().is_enabled().map_err(|e| e.to_string())
}

#[tauri::command]
fn autostart_set(app: AppHandle, on: bool) -> Result<(), String> {
    let m = app.autolaunch();
    let r = if on { m.enable() } else { m.disable() };
    r.map_err(|e| e.to_string())
}

// ---------- secrets (the OS credential store via keyring) ----------
// Windows: Credential Manager. Linux: the Secret Service over D-Bus (KWallet, GNOME Keyring). When no service answers
// (a bare window manager, an SSH session, a disabled daemon) the Linux build keeps secrets in a 0600 file next to the
// data file instead, and the UI learns which store is in use through secret_store. The three commands run off the main
// thread (`command(async)`): a KWallet unlock prompt or a D-Bus activation timeout must not freeze the window.

/// 0 = not tried yet, 1 = the OS store answered, 2 = fell back to the file (Linux only).
static SECRET_STORE: AtomicU8 = AtomicU8::new(0);

fn entry(name: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE, name).map_err(|e| e.to_string())
}

/// True when the error means "there is no keyring here", not "the keyring said no".
fn keyring_absent(e: &keyring::Error) -> bool {
    cfg!(target_os = "linux") && matches!(e, keyring::Error::PlatformFailure(_))
}

#[cfg(target_os = "linux")]
fn file_secrets(app: &AppHandle) -> Result<serde_json::Map<String, Value>, String> {
    let p = data_dir(app)?.join("secrets.json");
    if !p.exists() {
        return Ok(Default::default());
    }
    let s = fs::read_to_string(&p).map_err(|e| e.to_string())?;
    Ok(serde_json::from_str::<Value>(&s)
        .ok()
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_default())
}

#[cfg(target_os = "linux")]
fn file_set(app: &AppHandle, name: &str, value: Option<&str>) -> Result<(), String> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    let mut m = file_secrets(app)?;
    match value {
        Some(v) => {
            m.insert(name.to_string(), Value::String(v.to_string()));
        }
        None => {
            // nothing to remove: leave the folder alone, so a keyring session never creates the file
            if m.remove(name).is_none() {
                return Ok(());
            }
        }
    }
    let dir = data_dir(app)?;
    if m.is_empty() {
        // the last secret left the file: drop it rather than keep an empty one around
        let _ = fs::remove_file(dir.join("secrets.json"));
        return Ok(());
    }
    let tmp = dir.join("secrets.json.tmp");
    let mut f = fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(&tmp)
        .map_err(|e| e.to_string())?;
    f.write_all(Value::Object(m).to_string().as_bytes()).map_err(|e| e.to_string())?;
    drop(f);
    fs::rename(&tmp, dir.join("secrets.json")).map_err(|e| e.to_string())
}

#[cfg(target_os = "linux")]
fn file_get(app: &AppHandle, name: &str) -> Result<Option<String>, String> {
    Ok(file_secrets(app)?.get(name).and_then(|v| v.as_str()).map(String::from))
}

#[cfg(not(target_os = "linux"))]
fn file_set(_app: &AppHandle, _name: &str, _value: Option<&str>) -> Result<(), String> {
    Ok(())
}

#[cfg(not(target_os = "linux"))]
fn file_get(_app: &AppHandle, _name: &str) -> Result<Option<String>, String> {
    Ok(None)
}

#[tauri::command(async)]
fn secret_set(app: AppHandle, name: String, value: String) -> Result<(), String> {
    match entry(&name)?.set_password(&value) {
        Ok(()) => {
            SECRET_STORE.store(1, Ordering::Relaxed);
            // a copy left in the file from a keyring-less session goes the moment the keyring accepts a write
            let _ = file_set(&app, &name, None);
            Ok(())
        }
        Err(e) if keyring_absent(&e) => {
            SECRET_STORE.store(2, Ordering::Relaxed);
            file_set(&app, &name, Some(&value))
        }
        Err(keyring::Error::NoStorageAccess(_)) if cfg!(target_os = "linux") => {
            Err("The keyring is locked or declined. Unlock KWallet or GNOME Keyring and try again.".to_string())
        }
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command(async)]
fn secret_get(app: AppHandle, name: String) -> Result<Option<String>, String> {
    match entry(&name)?.get_password() {
        Ok(v) => {
            SECRET_STORE.store(1, Ordering::Relaxed);
            Ok(Some(v))
        }
        Err(keyring::Error::NoEntry) => {
            SECRET_STORE.store(1, Ordering::Relaxed);
            file_get(&app, &name)
        }
        Err(e) if keyring_absent(&e) => {
            SECRET_STORE.store(2, Ordering::Relaxed);
            file_get(&app, &name)
        }
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command(async)]
fn secret_delete(app: AppHandle, name: String) -> Result<(), String> {
    let _ = file_set(&app, &name, None);
    match entry(&name)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) if keyring_absent(&e) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

/// "credential-manager" (Windows), "keychain" (macOS), "secret-service" or "file" (Linux), or "unknown" on Linux
/// before the first keyring call has shown which one answers.
fn secret_store_name() -> &'static str {
    if cfg!(windows) {
        return "credential-manager";
    }
    if cfg!(target_os = "macos") {
        return "keychain";
    }
    match SECRET_STORE.load(Ordering::Relaxed) {
        1 => "secret-service",
        2 => "file",
        _ => "unknown",
    }
}

#[tauri::command]
fn secret_store() -> String {
    secret_store_name().to_string()
}

// ---------- system-wide hotkeys ----------

#[derive(Deserialize)]
pub struct HotkeySpec {
    quick: Option<String>,
    voice: Option<String>,
}

/// The UI records combos as "Ctrl+Shift+Space"; the shortcut parser wants "Control+Shift+Space" with key codes.
fn normalize_combo(c: &str) -> String {
    c.split('+')
        .map(|p| {
            let t = p.trim();
            match t {
                "Ctrl" | "Control" => "Control".to_string(),
                "Meta" | "Cmd" | "Win" => "Super".to_string(),
                "Alt" => "Alt".to_string(),
                "Shift" => "Shift".to_string(),
                "Space" | " " => "Space".to_string(),
                "/" => "Slash".to_string(),
                "," => "Comma".to_string(),
                "." => "Period".to_string(),
                ";" => "Semicolon".to_string(),
                "'" => "Quote".to_string(),
                "[" => "BracketLeft".to_string(),
                "]" => "BracketRight".to_string(),
                "\\" => "Backslash".to_string(),
                "-" => "Minus".to_string(),
                "=" => "Equal".to_string(),
                "`" => "Backquote".to_string(),
                s if s.len() == 1 && s.chars().all(|ch| ch.is_ascii_digit()) => format!("Digit{s}"),
                s if s.len() == 1 && s.chars().all(|ch| ch.is_ascii_alphabetic()) => {
                    format!("Key{}", s.to_ascii_uppercase())
                }
                other => other.to_string(),
            }
        })
        .collect::<Vec<_>>()
        .join("+")
}

/// Replaces all registered shortcuts. Returns the combos that could not be registered (taken by another app).
#[tauri::command]
fn set_hotkeys(app: AppHandle, spec: HotkeySpec) -> Result<Vec<String>, String> {
    if is_wayland() {
        // The plugin grabs keys through X11. Under Wayland that reaches X11 apps only, or nothing, so run() does not load
        // it there and app.global_shortcut() would panic on the missing state. Report every combo as not registered; the
        // UI keeps its in-window shortcuts and shows the desktop-shortcut recipe (xdg-open sundial://quick-add).
        return Ok([spec.quick, spec.voice]
            .into_iter()
            .flatten()
            .map(|c| format!("{c}: system-wide shortcuts need an X11 session on Linux"))
            .collect());
    }
    let gs = app.global_shortcut();
    gs.unregister_all().map_err(|e| e.to_string())?;
    let mut failed = Vec::new();
    for (combo, event) in [(spec.quick, "sundial://quick-add"), (spec.voice, "sundial://voice")] {
        let Some(c) = combo else { continue };
        let ev = event.to_string();
        let parsed: Result<Shortcut, _> = normalize_combo(&c).parse();
        match parsed {
            Ok(sc) => {
                let r = gs.on_shortcut(sc, move |app, _sc, e| {
                    if e.state == ShortcutState::Pressed {
                        show_main(app);
                        let _ = app.emit(&ev, ());
                    }
                });
                if let Err(e) = r {
                    failed.push(format!("{c}: {e}"));
                }
            }
            Err(e) => failed.push(format!("{c}: {e}")),
        }
    }
    Ok(failed)
}

// ---------- AI parsing with the user's own key ----------

#[derive(Deserialize)]
pub struct AiReq {
    provider: String,
    model: String,
    base_url: Option<String>,
    text: String,
    context: Value,
}

fn task_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "title":  {"type": "string", "description": "the line with scheduling words removed, in the user's own words"},
            "date":   {"type": ["string", "null"], "description": "YYYY-MM-DD, null if the line names no day"},
            "time":   {"type": ["integer", "null"], "description": "minutes after midnight, null if no time"},
            "dur":    {"type": ["integer", "null"], "description": "duration in minutes"},
            "color":  {"type": ["string", "null"], "description": "one of the color keys, null if none fits clearly"},
            "repeat": {"type": ["string", "null"], "enum": ["daily", "weekdays", "weekly", "monthly", null]},
            "remind": {"type": ["integer", "null"], "description": "minutes before start, only if the line asks for a reminder lead"},
            "notify": {"type": ["boolean", "null"], "description": "false only if the line says silent/quiet/no alert"},
            "notes":  {"type": ["string", "null"], "description": "details worth keeping out of the title: address, names, links, what to bring"}
        },
        "required": ["title", "date", "time", "dur", "color", "repeat", "remind", "notify", "notes"],
        "additionalProperties": false
    })
}

fn system_prompt(ctx: &Value) -> String {
    let s = |k: &str| ctx[k].as_str().unwrap_or("").to_string();
    format!(
        "You turn one line typed into a personal planner into fields. Today is {today} ({weekday}), local time {now}. \
The day currently selected in the app is {selected}; use it when the line names no day. \
Color keys and what the user calls them: {labels}. \
Rules: keep the title in the user's words with scheduling words removed. Times are minutes after midnight; \
a bare small number like 'at 3' for a daytime errand means afternoon. Durations in minutes. \
Set only what the line actually implies, otherwise null. Details that are not the task itself (address, names, \
links, what to bring, why) go into notes. Never invent dates, times or people.",
        today = s("today"),
        weekday = s("weekday"),
        now = s("now"),
        selected = s("selected"),
        labels = ctx["labels"].to_string()
    )
}

#[tauri::command]
async fn ai_parse(app: AppHandle, req: AiReq) -> Result<Value, String> {
    let key = secret_get(app.clone(), format!("ai:{}", req.provider))?
        .ok_or_else(|| "No API key saved for this provider".to_string())?;
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(40))
        .build()
        .map_err(|e| e.to_string())?;
    let system = system_prompt(&req.context);
    let schema = task_schema();

    if req.provider == "anthropic" {
        // Server-side refusal fallback is only accepted by the models that support it.
        let fallback_ok = ["claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5", "claude-fable"]
            .iter()
            .any(|p| req.model.starts_with(p));
        let mut body = json!({
            "model": req.model,
            "max_tokens": 1024,
            "system": system,
            "messages": [{"role": "user", "content": req.text}],
            "output_config": {"effort": "low", "format": {"type": "json_schema", "schema": schema}}
        });
        if fallback_ok {
            body["fallbacks"] = json!("default");
        }
        let mut r = client
            .post("https://api.anthropic.com/v1/messages")
            .header("x-api-key", &key)
            .header("anthropic-version", "2023-06-01")
            .header("content-type", "application/json");
        if fallback_ok {
            r = r.header("anthropic-beta", "server-side-fallback-2026-07-01");
        }
        let resp = r.json(&body).send().await.map_err(|e| e.to_string())?;
        let status = resp.status();
        let v: Value = resp.json().await.map_err(|e| e.to_string())?;
        if !status.is_success() {
            return Err(v["error"]["message"].as_str().unwrap_or("API error").to_string());
        }
        if v["stop_reason"] == "refusal" {
            return Err("The model declined this line".to_string());
        }
        let text = v["content"]
            .as_array()
            .and_then(|a| a.iter().find(|b| b["type"] == "text"))
            .and_then(|b| b["text"].as_str())
            .ok_or("No text in response")?;
        serde_json::from_str::<Value>(text).map_err(|e| format!("Bad JSON from model: {e}"))
    } else {
        let base = req.base_url.clone().filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| "https://api.openai.com/v1".to_string());
        let body = json!({
            "model": req.model,
            "messages": [{"role": "system", "content": system}, {"role": "user", "content": req.text}],
            "response_format": {"type": "json_schema", "json_schema": {"name": "task", "schema": schema, "strict": true}}
        });
        let resp = client
            .post(format!("{}/chat/completions", base.trim_end_matches('/')))
            .bearer_auth(&key)
            .json(&body)
            .send()
            .await
            .map_err(|e| e.to_string())?;
        let status = resp.status();
        let v: Value = resp.json().await.map_err(|e| e.to_string())?;
        if !status.is_success() {
            return Err(v["error"]["message"].as_str().unwrap_or("API error").to_string());
        }
        let text = v["choices"][0]["message"]["content"].as_str().ok_or("No content in response")?;
        serde_json::from_str::<Value>(text).map_err(|e| format!("Bad JSON from model: {e}"))
    }
}

// ---------- updates ----------

/// The update found by the last check, kept so "Restart now" can install it without checking again.
pub struct PendingUpdate(Mutex<Option<tauri_plugin_updater::Update>>);

#[tauri::command]
fn app_version(app: AppHandle) -> String {
    app.package_info().version.to_string()
}

/// The name this PC goes by, for the "add a PC?" prompt on the other PC.
#[tauri::command]
fn machine_name() -> String {
    let raw = if cfg!(windows) {
        std::env::var("COMPUTERNAME").or_else(|_| std::env::var("HOSTNAME")).unwrap_or_default()
    } else {
        // HOSTNAME is a shell variable that desktop sessions do not export: the name the desktop shows
        // (hostnamectl --pretty), else the kernel's, else the file, else the shell's
        fs::read_to_string("/etc/machine-info")
            .ok()
            .and_then(|s| {
                s.lines().find_map(|l| {
                    l.strip_prefix("PRETTY_HOSTNAME=").map(|v| v.trim().trim_matches('"').to_string())
                })
            })
            .filter(|s| !s.is_empty())
            .or_else(|| fs::read_to_string("/proc/sys/kernel/hostname").ok())
            .or_else(|| fs::read_to_string("/etc/hostname").ok())
            .or_else(|| std::env::var("HOSTNAME").ok())
            .unwrap_or_default()
    };
    raw.trim().chars().take(40).collect()
}

/// How this copy was installed: "installer" (NSIS on Windows, a .dmg on macOS), "appimage", "package" (.deb/.rpm under
/// /usr or /opt, or a Flatpak), or "dev" (cargo run, a debug build, an extracted AppImage). The same words reach ui.js.
fn install_kind() -> &'static str {
    if !cfg!(target_os = "linux") {
        return "installer";
    }
    if std::env::var_os("APPIMAGE").is_some() {
        return "appimage";
    }
    if std::env::var_os("FLATPAK_ID").is_some() {
        return "package";
    }
    if cfg!(debug_assertions) {
        return "dev";
    }
    match std::env::current_exe() {
        Ok(p) if p.to_string_lossy().contains("/target/") => "dev",
        Ok(p) if p.starts_with("/usr") || p.starts_with("/opt") => "package",
        _ => "dev",
    }
}

/// The updater can replace this copy: the NSIS install on Windows, the AppImage on Linux. Not a .deb/.rpm, a Flatpak or a dev run.
fn self_updating() -> bool {
    !cfg!(target_os = "linux") || install_kind() == "appimage"
}

const RELEASES_PAGE: &str = "https://github.com/zphat/Sundial/releases/latest";
const LATEST_JSON: &str = "https://github.com/zphat/Sundial/releases/latest/download/latest.json";

/// A copy that cannot replace itself still learns about new versions: read latest.json, compare with the running version,
/// and let the UI offer the releases page. Nothing is downloaded or installed here.
async fn update_check_download_only(app: AppHandle) -> Result<Option<Value>, String> {
    let mine = app.package_info().version.clone();
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|e| e.to_string())?;
    let v = client
        .get(LATEST_JSON)
        .header("user-agent", format!("Sundial/{mine}"))
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?
        .json::<Value>()
        .await
        .map_err(|e| e.to_string())?;
    let latest = semver::Version::parse(v["version"].as_str().unwrap_or("").trim_start_matches('v'))
        .map_err(|e| format!("latest.json: {e}"))?;
    if latest <= mine {
        return Ok(None);
    }
    Ok(Some(json!({
        "version": latest.to_string(),
        "notes": v["notes"],
        "date": v["pub_date"],
        "downloadOnly": true,
        "url": RELEASES_PAGE,
    })))
}

#[tauri::command]
async fn update_check(app: AppHandle, pending: tauri::State<'_, PendingUpdate>) -> Result<Option<Value>, String> {
    if !self_updating() {
        return update_check_download_only(app.clone()).await;
    }
    let updater = app.updater().map_err(|e| e.to_string())?;
    match updater.check().await {
        Ok(Some(u)) => {
            let info = json!({
                "version": u.version,
                "notes": u.body,
                "date": u.date.map(|d| d.to_string()),
            });
            *pending.0.lock().map_err(|e| e.to_string())? = Some(u);
            Ok(Some(info))
        }
        Ok(None) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/// Appends one line to update.log next to the data file, so a failed update can be diagnosed afterwards.
fn ulog(app: &AppHandle, line: &str) {
    if let Ok(dir) = data_dir(app) {
        let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
        if let Ok(mut f) = fs::OpenOptions::new().create(true).append(true).open(dir.join("update.log")) {
            use std::io::Write;
            let _ = writeln!(f, "{stamp} {line}");
        }
    }
}

#[tauri::command]
async fn update_install(app: AppHandle, pending: tauri::State<'_, PendingUpdate>) -> Result<(), String> {
    if !self_updating() {
        return Err("This copy of Sundial was installed as a package, so it does not replace itself. Download the new version from the releases page.".to_string());
    }
    // Cloned, not taken: a failed attempt must not turn every later click into "no update checked".
    let update = pending.0.lock().map_err(|e| e.to_string())?.clone();
    let Some(update) = update else {
        return Err("No update has been checked yet".to_string());
    };
    ulog(&app, &format!("install {} from {} (running {})", update.version, update.download_url, app.package_info().version));
    let progress_app = app.clone();
    let mut downloaded: u64 = 0;
    let mut last_pct: i64 = -1;
    let finish_app = app.clone();
    let result = update
        .download_and_install(
            move |chunk, total| {
                downloaded += chunk as u64;
                let pct = total.map(|t| if t > 0 { (downloaded * 100 / t) as i64 } else { -1 }).unwrap_or(-1);
                if pct != last_pct {
                    last_pct = pct;
                    let _ = progress_app.emit("sundial://update-progress", json!({ "downloaded": downloaded, "total": total, "pct": pct }));
                }
            },
            move || {
                ulog(&finish_app, "download complete, starting the installer");
                let _ = finish_app.emit("sundial://update-progress", json!({ "pct": 100, "installing": true }));
                // From here on nothing may keep the process alive: the installer has to replace the exe.
                QUITTING.store(true, Ordering::SeqCst);
                let h = finish_app.clone();
                let _ = finish_app.run_on_main_thread(move || drop(h.remove_tray_by_id("main")));
            },
        )
        .await;
    match result {
        Ok(()) => {
            if cfg!(target_os = "linux") {
                // The updater replaced the AppImage file in place and nothing relaunches it, so do it here: restart() execs
                // the APPIMAGE path (tauri::process::current_binary honours it), which is now the new file.
                ulog(&app, "AppImage replaced; restarting");
                app.restart();
            }
            // On Windows the updater normally ends the process itself once the installer is running. If it did not,
            // leave now: the installer relaunches Sundial when it is done, and a restarted old copy would only get killed.
            ulog(&app, "installer launched; exiting so it can replace the files");
            quit_app(&app);
            Ok(())
        }
        Err(e) => {
            let msg = e.to_string();
            ulog(&app, &format!("failed: {msg}"));
            QUITTING.store(false, Ordering::SeqCst);
            if app.tray_by_id("main").is_none() {
                let _ = build_tray_handle(&app);
            }
            Err(msg)
        }
    }
}

// ---------- corner toasts (Steam-style notification window) ----------

#[derive(Default)]
pub struct ToastState {
    current: Option<Value>,
    queue: std::collections::VecDeque<Value>,
}
pub struct Toasts(Mutex<ToastState>);

const TOAST_W: f64 = 384.0;
const TOAST_H: f64 = 126.0;

/// A frameless, transparent, always-on-top window in a screen corner. Created per notification so it
/// never takes focus from whatever the user is doing; closed by the page when dismissed or timed out.
fn open_toast_window(app: &AppHandle, payload: &Value) -> Result<(), String> {
    let corner = payload["corner"].as_str().unwrap_or("bottom-left");
    let mon = app
        .primary_monitor()
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "no monitor".to_string())?;
    let scale = mon.scale_factor();
    let ms = mon.size().to_logical::<f64>(scale);
    let mp = mon.position().to_logical::<f64>(scale);
    let margin = 14.0;
    let taskbar = 52.0; // room for a bottom taskbar; the toast sits just above it
    let x = if corner.ends_with("left") { mp.x + margin } else { mp.x + ms.width - TOAST_W - margin };
    let y = if corner.starts_with("top") { mp.y + margin } else { mp.y + ms.height - TOAST_H - taskbar - margin };
    if let Some(old) = app.get_webview_window("toast") {
        let _ = old.destroy();
    }
    tauri::WebviewWindowBuilder::new(app, "toast", tauri::WebviewUrl::App("toast.html".into()))
        .title("Sundial notification")
        .inner_size(TOAST_W, TOAST_H)
        .position(x, y)
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .focused(false)
        .shadow(false)
        .build()
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Linux stand-in for the corner window: the same title, label and meta as one desktop notification. No buttons; the
/// UI keeps its in-app banners while the window is in front and the tray menu opens Sundial.
fn notify_from_toast(app: &AppHandle, p: &Value) -> Result<(), String> {
    let title = p["title"].as_str().unwrap_or("Sundial").to_string();
    let label = p["label"].as_str().unwrap_or("");
    let meta = p["meta"].as_str().unwrap_or("");
    let body = match (label.is_empty(), meta.is_empty()) {
        (true, true) => String::new(),
        (false, true) => label.to_string(),
        (true, false) => meta.to_string(),
        (false, false) => format!("{label} · {meta}"),
    };
    app.notification()
        .builder()
        .title(title)
        .body(body)
        .show()
        .map_err(|e| e.to_string())
}

// Async on purpose: creating a webview window from inside a synchronous command deadlocks on Windows
// (the main thread waits for WebView2 while WebView2 waits for the main thread). 0.1.10 froze exactly there.
#[tauri::command]
async fn toast_show(app: AppHandle, state: tauri::State<'_, Toasts>, payload: Value) -> Result<(), String> {
    if cfg!(target_os = "linux") {
        // No corner window on Linux: Wayland gives a client no say over position, skip_taskbar or always_on_top, so the
        // window would land wherever the compositor puts it, with a taskbar entry. The words go out as a notification
        // instead; toast_payload then has no current payload and toast_action finds no window, which both handle already.
        return notify_from_toast(&app, &payload);
    }
    {
        let mut st = state.0.lock().map_err(|e| e.to_string())?;
        if app.get_webview_window("toast").is_some() {
            st.queue.push_back(payload);
            return Ok(());
        }
        st.current = Some(payload.clone());
    }
    open_toast_window(&app, &payload)
}

#[tauri::command]
fn toast_payload(state: tauri::State<'_, Toasts>) -> Result<Option<Value>, String> {
    Ok(state.0.lock().map_err(|e| e.to_string())?.current.clone())
}

/// The toast page reports what the user did; the main window gets the event, the window closes,
/// and the next queued toast (if any) opens after a beat.
#[tauri::command]
async fn toast_action(app: AppHandle, state: tauri::State<'_, Toasts>, action: String) -> Result<(), String> {
    let (current, next) = {
        let mut st = state.0.lock().map_err(|e| e.to_string())?;
        let current = st.current.take();
        let next = st.queue.pop_front();
        st.current = next.clone();
        (current, next)
    };
    if action == "open" || action == "install" {
        show_main(&app);
    }
    if let Some(p) = current {
        let _ = app.emit_to("main", "sundial://toast-action", json!({ "action": action, "payload": p }));
    }
    // Off the toast's own call: tearing a webview down from inside its IPC handler is another Windows deadlock.
    // destroy() skips the close-request round trip; building from a plain thread hands creation to the event loop.
    let app2 = app.clone();
    std::thread::spawn(move || {
        if let Some(w) = app2.get_webview_window("toast") {
            let _ = w.destroy();
        }
        if let Some(n) = next {
            std::thread::sleep(std::time::Duration::from_millis(300));
            let _ = open_toast_window(&app2, &n);
        }
    });
    Ok(())
}

// ---------- platform (what the shell can do on this machine) ----------

/// Linux: is this a Wayland session? XDG_SESSION_TYPE decides when it is set (an explicit x11 wins over a stray
/// WAYLAND_DISPLAY); WAYLAND_DISPLAY otherwise. Always false elsewhere.
fn is_wayland() -> bool {
    if !cfg!(target_os = "linux") {
        return false;
    }
    let session = std::env::var("XDG_SESSION_TYPE").unwrap_or_default().to_ascii_lowercase();
    if session == "x11" {
        return false;
    }
    session == "wayland" || std::env::var_os("WAYLAND_DISPLAY").is_some()
}

/// Linux only: "wayland", "x11", or None when no display is reachable. None on Windows and macOS.
fn session_type() -> Option<&'static str> {
    if !cfg!(target_os = "linux") {
        return None;
    }
    if is_wayland() {
        Some("wayland")
    } else if std::env::var_os("DISPLAY").is_some() {
        Some("x11")
    } else {
        None
    }
}

/// Linux only: the desktop from XDG_CURRENT_DESKTOP, lowercased. "kde" or "gnome" when any ':'-separated token is one
/// ("KDE" -> "kde", "ubuntu:GNOME" -> "gnome", "pop:GNOME" -> "gnome"), else the first token ("X-Cinnamon" -> "x-cinnamon").
fn desktop_env() -> Option<String> {
    if !cfg!(target_os = "linux") {
        return None;
    }
    let raw = std::env::var("XDG_CURRENT_DESKTOP").ok()?;
    let tokens: Vec<String> = raw
        .split(':')
        .map(|t| t.trim().to_ascii_lowercase())
        .filter(|t| !t.is_empty())
        .collect();
    tokens
        .iter()
        .find(|t| matches!(t.as_str(), "kde" | "gnome"))
        .or_else(|| tokens.first())
        .cloned()
}

/// Set once the tray icon has been built; read by tray_available.
static TRAY_OK: AtomicBool = AtomicBool::new(false);
/// Linux: a StatusNotifier host has been seen once, so the question is never asked again.
static TRAY_HOST_SEEN: AtomicBool = AtomicBool::new(false);

/// True when a hidden window can be brought back from a tray icon. Windows and macOS: always. Linux: the icon was built
/// and something shows tray icons, which the StatusNotifierWatcher reports over D-Bus; asked through busctl, which every
/// systemd distro ships, at the moment it matters (plasmashell may register a second after login). A yes is cached. Not
/// being able to tell (no busctl, no bus reachable) counts as yes, today's behaviour; only "no host registered" is a no.
fn tray_available() -> bool {
    if !cfg!(target_os = "linux") {
        return true;
    }
    if !TRAY_OK.load(Ordering::Relaxed) {
        return false;
    }
    if TRAY_HOST_SEEN.load(Ordering::Relaxed) {
        return true;
    }
    let out = std::process::Command::new("busctl")
        .args([
            "--user",
            "get-property",
            "org.kde.StatusNotifierWatcher",
            "/StatusNotifierWatcher",
            "org.kde.StatusNotifierWatcher",
            "IsStatusNotifierHostRegistered",
        ])
        .output();
    let yes = match out {
        // prints "b true" or "b false"
        Ok(o) if o.status.success() => String::from_utf8_lossy(&o.stdout).contains("true"),
        // nobody owns the name: a no. Could not reach a bus at all: cannot tell.
        Ok(o) => String::from_utf8_lossy(&o.stderr).contains("Failed to connect"),
        // no busctl on this system: cannot tell
        Err(_) => true,
    };
    if yes {
        TRAY_HOST_SEEN.store(true, Ordering::Relaxed);
    }
    yes
}

/// What the shell can do on this machine, for ui.js (desktop.js `platform()`). A contract with the UI, which defaults to
/// {os:'windows', session:null, install:'installer', tray:true, desktop:null} when the command is missing:
/// os "windows" | "linux" | "macos"; session "x11" | "wayland" | null (Linux only); install "installer" | "appimage" |
/// "package" | "dev"; tray true when a hidden window can come back; desktop the lowercased XDG_CURRENT_DESKTOP token or null.
#[tauri::command(async)]
fn platform_info() -> Value {
    json!({
        "os": std::env::consts::OS,
        "session": session_type(),
        "install": install_kind(),
        "tray": tray_available(),
        "desktop": desktop_env(),
    })
}

/// The same facts with every flag the UI might key on precomputed (the audit's shape; desktop.js may call it as `platform`).
#[tauri::command(async)]
fn platform() -> Value {
    json!({
        "os": std::env::consts::OS,
        "session": session_type().unwrap_or(""),
        "install": install_kind(),
        "cornerToasts": !cfg!(target_os = "linux"),
        "globalHotkeys": !is_wayland(),
        "tray": tray_available(),
        "selfUpdate": self_updating(),
        "secrets": secret_store_name(),
    })
}

// ---------- window / tray ----------

// ---------- deep links ----------
// sundial://signin?code=482913 comes from the Open Sundial button on the sign-in email's code page.
// The URL is kept until the UI asks for it: on a cold start it arrives before the webview is listening.
pub struct DeepLinks(Mutex<Option<String>>);

fn on_deep_link(app: &AppHandle, url: String) {
    if let Some(st) = app.try_state::<DeepLinks>() {
        if let Ok(mut g) = st.0.lock() {
            *g = Some(url.clone());
        }
    }
    let _ = app.emit("sundial://deep-link", url);
    show_main(app);
}

#[tauri::command]
fn deep_link_pending(state: tauri::State<'_, DeepLinks>) -> Result<Option<String>, String> {
    Ok(state.0.lock().map_err(|e| e.to_string())?.take())
}

/// Set while the app is on its way out, so the close-to-tray handler stops holding windows open.
static QUITTING: AtomicBool = AtomicBool::new(false);

/// Quit for real: tray icon gone (Windows otherwise keeps a ghost icon until the next mouse-over), every window
/// destroyed without a close request, the event loop asked to stop, and a watchdog in case it does not.
fn quit_app(app: &AppHandle) {
    QUITTING.store(true, Ordering::SeqCst);
    // Tray removal destroys a hidden window, which Windows only allows from the thread that owns it.
    let h = app.clone();
    let _ = app.run_on_main_thread(move || {
        drop(h.remove_tray_by_id("main"));
        for (_, w) in h.webview_windows() {
            let _ = w.destroy();
        }
        h.exit(0);
    });
    let h2 = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(1500));
        h2.cleanup_before_exit();
        std::process::exit(0);
    });
}

fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

fn build_tray(app: &tauri::App) -> tauri::Result<()> {
    build_tray_handle(app.handle())
}

fn build_tray_handle(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Open Sundial", true, None::<&str>)?;
    let quick = MenuItem::with_id(app, "quick", "Quick add", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Sundial", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &quick, &quit])?;
    let mut b = TrayIconBuilder::with_id("main")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .tooltip("Sundial")
        .on_menu_event(|app, e| match e.id().as_ref() {
            "open" => show_main(app),
            "quick" => {
                show_main(app);
                let _ = app.emit("sundial://quick-add", ());
            }
            "quit" => quit_app(app),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                show_main(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        b = b.icon(icon.clone());
    }
    // Linux note: libayatana-appindicator sends no click events and ignores show_menu_on_left_click and tooltip, so a
    // left click opens the menu there; Open Sundial is its first item, which is why no code is needed for that.
    b.build(app)?;
    TRAY_OK.store(true, Ordering::Relaxed);
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(target_os = "linux")]
    {
        // WebKitGTK's DMA-BUF renderer shows a blank or black window on the proprietary Nvidia driver, common on the gaming
        // distros (Bazzite, CachyOS). It must be set before GTK starts, so only the shell can do it. Gated on the Nvidia
        // kernel module so Intel and AMD keep the faster path, and on the variable being unset so a user can override it.
        if std::path::Path::new("/proc/driver/nvidia/version").exists()
            && std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none()
        {
            std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
        }
    }
    let mut builder: tauri::Builder<tauri::Wry> = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show_main(app)))
        .plugin(tauri_plugin_deep_link::init())
        // Remember size and position of the main window only. Visibility is deliberately not restored: a window
        // hidden to the tray at quit must come back visible, and the toast window positions itself.
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(tauri_plugin_window_state::StateFlags::all() & !tauri_plugin_window_state::StateFlags::VISIBLE)
                .with_denylist(&["toast"])
                .build(),
        );
    // X11 only: global-hotkey opens the X display when the plugin loads and cannot grab keys under Wayland (the
    // GlobalShortcuts portal is a later phase). set_hotkeys returns before touching the plugin there, so the missing
    // state is never reached; nothing else calls app.global_shortcut().
    if !is_wayland() {
        builder = builder.plugin(tauri_plugin_global_shortcut::Builder::new().build());
    }
    builder
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, Some(vec!["--minimized"])))
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(PendingUpdate(Mutex::new(None)))
        .manage(Toasts(Mutex::new(ToastState::default())))
        .manage(DeepLinks(Mutex::new(None)))
        .setup(|app| {
            #[cfg(target_os = "linux")]
            {
                // No tray is survivable (closing then quits, see on_window_event); failing to start is not. On Linux a
                // missing icon is a D-Bus or theme problem, not a broken install.
                if let Err(e) = build_tray(app) {
                    eprintln!("sundial: no tray icon: {e}");
                }
            }
            #[cfg(not(target_os = "linux"))]
            {
                build_tray(app)?;
            }
            // The installer registers sundial://; register_all covers dev runs and moved installs. On Linux it also
            // writes ~/.local/share/applications/sundial-handler.desktop and runs xdg-mime, so the scheme works for
            // .deb/.rpm installs and for an AppImage after its first run (as long as the file is not moved afterwards).
            #[cfg(any(windows, target_os = "linux"))]
            {
                let _ = app.deep_link().register_all();
            }
            let handle = app.handle().clone();
            app.deep_link().on_open_url(move |event| {
                if let Some(url) = event.urls().into_iter().next() {
                    on_deep_link(&handle, url.to_string());
                }
            });
            // A link that started the app arrived before any listener existed; pick it up here.
            let cold = app.deep_link().get_current().ok().flatten().and_then(|v| v.into_iter().next());
            if let Some(url) = cold {
                on_deep_link(app.handle(), url.to_string());
            } else if std::env::args().any(|a| a == "--minimized") {
                if let Some(w) = app.get_webview_window("main") {
                    // hidden only where a tray can bring it back; otherwise minimised, so the taskbar still has it
                    if tray_available() {
                        let _ = w.hide();
                    } else {
                        let _ = w.minimize();
                    }
                }
            }
            Ok(())
        })
        // The close button hides to the tray so reminders keep firing; Quit lives in the tray menu.
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" && !QUITTING.load(Ordering::SeqCst) {
                    api.prevent_close();
                    if !tray_available() {
                        // No tray host (GNOME without an extension, a bare window manager): a hidden window would be
                        // unreachable, so the close button quits, as every other app does there. prevent_close plus
                        // quit_app keeps control: a window destroyed on its own would raise ExitRequested { code: None },
                        // which the run() handler prevents, leaving a windowless process.
                        quit_app(window.app_handle());
                        return;
                    }
                    let _ = window.hide();
                    // the UI shows a one-time "still running in the tray" note
                    let _ = window.emit("sundial://hidden", ());
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            load_db, save_db, data_path, reveal_data, open_url, notify,
            autostart_get, autostart_set, secret_set, secret_get, secret_delete, secret_store,
            set_hotkeys, ai_parse, app_version, update_check, update_install,
            toast_show, toast_payload, toast_action, deep_link_pending, machine_name,
            platform_info, platform
        ])
        .build(tauri::generate_context!())
        .expect("error while building Sundial")
        .run(|_app, event| {
            // A tray app: losing the last window (a toast closing while the main window is hidden) must not end
            // the process. Quit and the updater exit with a code, which this does not touch.
            if let tauri::RunEvent::ExitRequested { code: None, api, .. } = event {
                api.prevent_exit();
            }
        });
}
